import express from 'express'
import cors from 'cors'
import {
  listDevices,
  developerModeEnabled,
  mountedImages,
  tunneldRunning,
  mountDeveloperImage,
  setLocation,
  clearLocation,
  TUNNELD_PORT
} from './pymd3.js'

const app = express()
const PORT = Number(process.env.PORT || 4000)

app.use(cors())
app.use(express.json())

// Probing the device costs a few seconds per call, so hold a short-lived cache.
let statusCache = { at: 0, data: null }
const STATUS_TTL = 4000

function majorVersion(productVersion) {
  const n = parseInt(String(productVersion || '').split('.')[0], 10)
  return Number.isNaN(n) ? 0 : n
}

async function collectStatus() {
  const devices = await listDevices()
  const device = devices[0] || null

  if (!device) {
    return {
      connected: false,
      device: null,
      developerMode: null,
      ddiMounted: null,
      tunnel: null,
      needsTunnel: false,
      ready: false,
      blockers: [{ code: 'NO_DEVICE', message: '未偵測到 iPhone。請以 USB 連接並解鎖螢幕。' }]
    }
  }

  const iosMajor = majorVersion(device.ProductVersion)
  const needsTunnel = iosMajor >= 17

  const [devMode, images, tunnel] = await Promise.all([
    developerModeEnabled(),
    mountedImages(),
    needsTunnel ? tunneldRunning() : Promise.resolve(null)
  ])

  const ddiMounted = Array.isArray(images) ? images.length > 0 : null

  const blockers = []
  if (devMode === false) {
    blockers.push({
      code: 'DEVELOPER_MODE_OFF',
      message: '開發者模式未啟用（設定 → 隱私權與安全性 → 開發者模式，需重開機）。'
    })
  }
  if (ddiMounted === false) {
    blockers.push({
      code: 'DDI_NOT_MOUNTED',
      message: 'Developer Disk Image 未掛載。'
    })
  }
  if (needsTunnel && tunnel === false) {
    blockers.push({
      code: 'NO_TUNNEL',
      message: `iOS ${iosMajor} 需要 RemoteXPC tunnel（tunneld 未在 127.0.0.1:${TUNNELD_PORT} 回應）。`
    })
  }

  return {
    connected: true,
    device: {
      name: device.DeviceName,
      model: device.ProductType,
      iosVersion: device.ProductVersion,
      udid: device.UniqueDeviceID,
      connectionType: device.ConnectionType
    },
    iosMajor,
    developerMode: devMode,
    ddiMounted,
    tunnel,
    needsTunnel,
    ready: blockers.length === 0,
    blockers
  }
}

app.get('/api/status', async (req, res) => {
  const fresh = req.query.fresh === '1'
  const now = Date.now()

  if (!fresh && statusCache.data && now - statusCache.at < STATUS_TTL) {
    return res.json({ ...statusCache.data, cached: true })
  }

  try {
    const data = await collectStatus()
    statusCache = { at: Date.now(), data }
    res.json({ ...data, cached: false })
  } catch (err) {
    res.status(500).json({ error: { code: 'INTERNAL', message: err.message } })
  }
})

app.post('/api/location', async (req, res) => {
  const lat = Number(req.body?.lat)
  const lng = Number(req.body?.lng)

  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    return res.status(400).json({
      error: { code: 'BAD_LAT', message: '緯度必須介於 -90 到 90。' }
    })
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    return res.status(400).json({
      error: { code: 'BAD_LNG', message: '經度必須介於 -180 到 180。' }
    })
  }

  const status = statusCache.data || (await collectStatus())
  const legacy = status.connected && status.iosMajor > 0 && status.iosMajor < 17

  const result = await setLocation(lat, lng, { legacy })
  if (result.ok) {
    return res.json({ ok: true, lat, lng, mode: legacy ? 'lockdown' : 'dvt' })
  }
  res.status(502).json({ error: result.error })
})

app.post('/api/location/clear', async (req, res) => {
  const status = statusCache.data || (await collectStatus())
  const legacy = status.connected && status.iosMajor > 0 && status.iosMajor < 17

  const result = await clearLocation({ legacy })
  if (result.ok) return res.json({ ok: true })
  res.status(502).json({ error: result.error })
})

app.post('/api/ddi/mount', async (req, res) => {
  const result = await mountDeveloperImage()
  statusCache = { at: 0, data: null }
  if (result.ok) return res.json({ ok: true, alreadyMounted: !!result.alreadyMounted })
  res.status(502).json({ error: result.error })
})

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[chGPS] bridge listening on http://127.0.0.1:${PORT}`)
})
