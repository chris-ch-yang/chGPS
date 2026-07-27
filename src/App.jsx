import { useState, useEffect, useCallback } from 'react'
import { MapContainer, TileLayer, Marker, Popup, useMapEvents, useMap } from 'react-leaflet'
import L from 'leaflet'
import './App.css'

const redIcon = new L.Icon({
  iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-red.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41]
})

const defaultIcon = new L.Icon.Default()

function MapClick({ onCoordinateSelect }) {
  useMapEvents({
    click: (e) => {
      const { lat, lng } = e.latlng
      onCoordinateSelect({ lat, lng })
    }
  })
  return null
}

/** MapContainer's `center` prop only applies on mount, so recentering needs the map instance. */
function Recenter({ center }) {
  const map = useMap()
  useEffect(() => {
    if (center) map.setView(center, map.getZoom())
  }, [center, map])
  return null
}

function useDeviceStatus(pollMs = 8000) {
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async (fresh = false) => {
    try {
      const res = await fetch(`/api/status${fresh ? '?fresh=1' : ''}`)
      setStatus(await res.json())
    } catch {
      setStatus({ bridgeDown: true })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    const id = setInterval(() => refresh(), pollMs)
    return () => clearInterval(id)
  }, [refresh, pollMs])

  return { status, loading, refresh }
}

function DevicePanel({ status, loading, onRefresh, onMountDdi, busy }) {
  if (loading) return <div className="device-panel"><span className="dot dot-idle" /> 連線中…</div>

  if (!status || status.bridgeDown) {
    return (
      <div className="device-panel device-error">
        <span className="dot dot-bad" />
        <div>
          <strong>Bridge 未啟動</strong>
          <p>請執行 <code>npm run server</code></p>
        </div>
      </div>
    )
  }

  if (!status.connected) {
    return (
      <div className="device-panel device-error">
        <span className="dot dot-bad" />
        <div>
          <strong>未偵測到 iPhone</strong>
          <p>請以 USB 連接並解鎖螢幕</p>
        </div>
        <button className="btn-small" onClick={() => onRefresh(true)}>↻</button>
      </div>
    )
  }

  const { device, ready, blockers } = status

  return (
    <div className={`device-panel ${ready ? 'device-ready' : 'device-warn'}`}>
      <span className={`dot ${ready ? 'dot-good' : 'dot-warn'}`} />
      <div className="device-info">
        <strong>{device.name}</strong>
        <p>{device.model} · iOS {device.iosVersion}</p>
        {!ready && (
          <ul className="blocker-list">
            {blockers.map((b) => (
              <li key={b.code}>
                {b.message}
                {b.code === 'DDI_NOT_MOUNTED' && (
                  <button className="btn-inline" onClick={onMountDdi} disabled={busy}>
                    {busy ? '掛載中…' : '立即掛載'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {ready && <p className="ready-text">✓ 可傳送定位</p>}
      </div>
      <button className="btn-small" onClick={() => onRefresh(true)} title="重新檢查">↻</button>
    </div>
  )
}

function App() {
  const [coordinates, setCoordinates] = useState([])
  const [activeIndex, setActiveIndex] = useState(null)
  const [inputLat, setInputLat] = useState('')
  const [inputLng, setInputLng] = useState('')
  const [mapCenter, setMapCenter] = useState([25.0330, 121.5654])
  const [sending, setSending] = useState(false)
  const [mounting, setMounting] = useState(false)
  const [toast, setToast] = useState(null)
  const [appliedCoord, setAppliedCoord] = useState(null)

  const { status, loading, refresh } = useDeviceStatus()

  const notify = (type, text) => {
    setToast({ type, text })
    setTimeout(() => setToast(null), 5000)
  }

  const handleCoordinateSelect = (coord) => {
    setCoordinates((prev) => [...prev, { id: Date.now(), ...coord }])
  }

  const handleUpdateCoordinate = () => {
    if (activeIndex !== null && inputLat && inputLng) {
      const updated = [...coordinates]
      updated[activeIndex] = {
        ...updated[activeIndex],
        lat: parseFloat(inputLat),
        lng: parseFloat(inputLng)
      }
      setCoordinates(updated)
    }
  }

  const handleDeleteCoordinate = (index) => {
    setCoordinates((prev) => prev.filter((_, i) => i !== index))
    if (activeIndex === index) {
      setActiveIndex(null)
      setInputLat('')
      setInputLng('')
    }
  }

  const handleSelectForEdit = (index) => {
    setActiveIndex(index)
    setInputLat(coordinates[index].lat.toString())
    setInputLng(coordinates[index].lng.toString())
  }

  const handleJumpToLocation = (coord) => {
    setMapCenter([coord.lat, coord.lng])
  }

  const sendToDevice = async (lat, lng) => {
    setSending(true)
    try {
      const res = await fetch('/api/location', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat, lng })
      })
      const data = await res.json()
      if (res.ok) {
        setAppliedCoord({ lat, lng })
        notify('success', `已將 iPhone 定位設為 ${lat.toFixed(5)}, ${lng.toFixed(5)}`)
      } else {
        notify('error', data.error?.message || '傳送失敗')
      }
    } catch {
      notify('error', '無法連線到 bridge，請確認 npm run server 已啟動')
    } finally {
      setSending(false)
      refresh(true)
    }
  }

  const clearDeviceLocation = async () => {
    setSending(true)
    try {
      const res = await fetch('/api/location/clear', { method: 'POST' })
      const data = await res.json()
      if (res.ok) {
        setAppliedCoord(null)
        notify('success', '已還原為真實 GPS')
      } else {
        notify('error', data.error?.message || '還原失敗')
      }
    } catch {
      notify('error', '無法連線到 bridge')
    } finally {
      setSending(false)
    }
  }

  const mountDdi = async () => {
    setMounting(true)
    notify('info', '正在下載並掛載 Developer Disk Image，可能需要數分鐘…')
    try {
      const res = await fetch('/api/ddi/mount', { method: 'POST' })
      const data = await res.json()
      if (res.ok) notify('success', 'DDI 掛載完成')
      else notify('error', data.error?.message || 'DDI 掛載失敗')
    } catch {
      notify('error', '無法連線到 bridge')
    } finally {
      setMounting(false)
      refresh(true)
    }
  }

  const deviceReady = !!status?.ready

  return (
    <div className="app-container">
      <div className="app-header">
        <div>
          <h1>🗺️ GPS Location Editor for Apple Devices</h1>
          <p className="subtitle">點擊地圖選取座標，透過 USB 傳送到 iPhone</p>
        </div>
      </div>

      {toast && <div className={`toast toast-${toast.type}`}>{toast.text}</div>}

      <div className="app-layout">
        <div className="map-section">
          <MapContainer center={mapCenter} zoom={11} className="map-container">
            <TileLayer
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              attribution='&copy; OpenStreetMap contributors'
            />
            <MapClick onCoordinateSelect={handleCoordinateSelect} />
            <Recenter center={mapCenter} />
            {coordinates.map((coord, idx) => (
              <Marker
                key={coord.id}
                position={[coord.lat, coord.lng]}
                icon={activeIndex === idx ? redIcon : defaultIcon}
              >
                <Popup>
                  <div className="popup-body">
                    <strong>Location {idx + 1}</strong>
                    <p>Lat: {coord.lat.toFixed(6)}</p>
                    <p>Lng: {coord.lng.toFixed(6)}</p>
                    <button
                      className="btn-primary btn-popup"
                      disabled={!deviceReady || sending}
                      onClick={() => sendToDevice(coord.lat, coord.lng)}
                    >
                      📲 傳送到 iPhone
                    </button>
                  </div>
                </Popup>
              </Marker>
            ))}
          </MapContainer>
        </div>

        <div className="control-panel">
          <DevicePanel
            status={status}
            loading={loading}
            onRefresh={refresh}
            onMountDdi={mountDdi}
            busy={mounting}
          />

          {appliedCoord && (
            <div className="applied-banner">
              <span>📍 目前模擬位置</span>
              <code>{appliedCoord.lat.toFixed(5)}, {appliedCoord.lng.toFixed(5)}</code>
              <button className="btn-inline" onClick={clearDeviceLocation} disabled={sending}>
                還原真實 GPS
              </button>
            </div>
          )}

          <div className="locations-list">
            <h2>📍 Saved Locations</h2>
            <div className="locations-scroll">
              {coordinates.length === 0 ? (
                <p className="empty-state">點擊地圖以新增位置</p>
              ) : (
                coordinates.map((coord, idx) => (
                  <div
                    key={coord.id}
                    className={`location-item ${activeIndex === idx ? 'active' : ''}`}
                  >
                    <div className="location-info" onClick={() => handleSelectForEdit(idx)}>
                      <strong>Location {idx + 1}</strong>
                      <p>Lat: {coord.lat.toFixed(6)}</p>
                      <p>Lng: {coord.lng.toFixed(6)}</p>
                    </div>
                    <div className="location-actions">
                      <button
                        className="btn-small btn-send"
                        onClick={() => sendToDevice(coord.lat, coord.lng)}
                        disabled={!deviceReady || sending}
                        title={deviceReady ? '傳送到 iPhone' : '裝置尚未就緒'}
                      >
                        📲
                      </button>
                      <button
                        className="btn-small btn-jump"
                        onClick={() => handleJumpToLocation(coord)}
                        title="移動地圖到此位置"
                      >
                        🎯
                      </button>
                      <button
                        className="btn-small btn-delete"
                        onClick={() => handleDeleteCoordinate(idx)}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="editor-section">
            <h2>✏️ Edit Location</h2>
            {activeIndex !== null ? (
              <div className="editor-form">
                <div className="form-row">
                  <div className="form-group">
                    <label>Latitude</label>
                    <input
                      type="number"
                      step="0.000001"
                      value={inputLat}
                      onChange={(e) => setInputLat(e.target.value)}
                      placeholder="25.033000"
                    />
                  </div>
                  <div className="form-group">
                    <label>Longitude</label>
                    <input
                      type="number"
                      step="0.000001"
                      value={inputLng}
                      onChange={(e) => setInputLng(e.target.value)}
                      placeholder="121.565400"
                    />
                  </div>
                </div>
                <button className="btn-secondary" onClick={handleUpdateCoordinate}>
                  更新座標
                </button>
                <button
                  className="btn-primary"
                  disabled={!deviceReady || sending}
                  onClick={() => sendToDevice(parseFloat(inputLat), parseFloat(inputLng))}
                >
                  {sending ? '傳送中…' : '📲 傳送到 iPhone'}
                </button>
              </div>
            ) : (
              <p className="empty-state">選擇一個位置以編輯</p>
            )}
          </div>

          <div className="export-section">
            <button
              className="btn-secondary"
              onClick={() => {
                const data = JSON.stringify(coordinates, null, 2)
                const blob = new Blob([data], { type: 'application/json' })
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url
                a.download = 'gps-locations.json'
                a.click()
                URL.revokeObjectURL(url)
              }}
              disabled={coordinates.length === 0}
            >
              📤 匯出 JSON
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default App
