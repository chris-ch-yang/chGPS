import { spawn } from 'node:child_process'

const PYTHON = process.env.PYTHON || 'python'
const TUNNELD_PORT = Number(process.env.TUNNELD_PORT || 49151)

/**
 * Run a pymobiledevice3 subcommand and capture its output.
 * Always invoked as `python -m pymobiledevice3` so it works regardless of
 * whether the console script landed on PATH.
 */
function run(args, { timeout = 45000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(PYTHON, ['-m', 'pymobiledevice3', ...args], {
      windowsHide: true
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeout)

    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })

    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, code: -1, stdout, stderr: err.message, timedOut: false })
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0 && !timedOut, code, stdout, stderr, timedOut })
    })
  })
}

/** pymobiledevice3 prints logs to stderr, so stdout is usually clean JSON. */
function parseJson(stdout) {
  const start = stdout.search(/[[{]/)
  if (start === -1) return null
  try {
    return JSON.parse(stdout.slice(start))
  } catch {
    return null
  }
}

/**
 * Map pymobiledevice3's raw errors onto something a user can act on.
 * Returns { code, message } — code is a stable identifier for the frontend.
 */
function classifyError(result) {
  const blob = `${result.stdout}\n${result.stderr}`

  if (result.timedOut) {
    return {
      code: 'TIMEOUT',
      message: '指令逾時。若是 iOS 17+，通常代表 tunnel 未啟動或已中斷。'
    }
  }
  if (/DeveloperModeIsNotEnabled|developer mode is not enabled/i.test(blob)) {
    return {
      code: 'DEVELOPER_MODE_OFF',
      message: 'iPhone 尚未啟用開發者模式（設定 → 隱私權與安全性 → 開發者模式，開啟後需重開機）。'
    }
  }
  if (/no such device|device not found|NoDeviceConnected|Device is not connected/i.test(blob)) {
    return {
      code: 'NO_DEVICE',
      message: '找不到 iPhone。請確認 USB 已連接、螢幕已解鎖，並已點選「信任這台電腦」。'
    }
  }
  if (/DeveloperDiskImage|DDI|image not mounted|UnsupportedCommandError/i.test(blob)) {
    return {
      code: 'DDI_NOT_MOUNTED',
      message: 'Developer Disk Image 尚未掛載。請先執行掛載（需連網下載）。'
    }
  }
  if (/tunneld|RemoteXPC|no tunnel|TunnelNotFound|start-tunnel|Failed to connect to remote/i.test(blob)) {
    return {
      code: 'NO_TUNNEL',
      message: 'iOS 17+ 需要 RemoteXPC tunnel。請以系統管理員身分執行 tunneld。'
    }
  }
  if (/PasswordRequired|pair|Trust|Unpaired/i.test(blob)) {
    return {
      code: 'NOT_PAIRED',
      message: 'iPhone 尚未與這台電腦配對。請解鎖 iPhone 並點選「信任」。'
    }
  }

  const tail = blob.trim().split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 400)
  return { code: 'UNKNOWN', message: tail || '未知錯誤' }
}

export async function listDevices() {
  const r = await run(['usbmux', 'list'], { timeout: 20000 })
  if (!r.ok) return []
  return parseJson(r.stdout) || []
}

export async function developerModeEnabled() {
  const r = await run(['amfi', 'developer-mode-status'], { timeout: 20000 })
  if (!r.ok) return null
  return /true/i.test(r.stdout)
}

export async function mountedImages() {
  const r = await run(['mounter', 'list'], { timeout: 25000 })
  if (!r.ok) return null
  return parseJson(r.stdout) || []
}

/** tunneld exposes an HTTP endpoint; reachability is the cheapest liveness probe. */
export async function tunneldRunning() {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 1500)
    const res = await fetch(`http://127.0.0.1:${TUNNELD_PORT}/`, { signal: ctrl.signal })
    clearTimeout(t)
    return res.ok
  } catch {
    return false
  }
}

export async function mountDeveloperImage() {
  // Downloads a personalized DDI from Apple on iOS 17+, so allow generous time.
  const r = await run(['mounter', 'auto-mount'], { timeout: 300000 })
  if (r.ok) return { ok: true }
  const blob = `${r.stdout}${r.stderr}`
  if (/already mounted/i.test(blob)) return { ok: true, alreadyMounted: true }
  return { ok: false, error: classifyError(r) }
}

/**
 * Set the simulated GPS coordinate.
 * iOS 17+ routes through DVT; older devices use the legacy lockdown service.
 */
export async function setLocation(lat, lng, { legacy = false } = {}) {
  const base = legacy
    ? ['developer', 'simulate-location', 'set']
    : ['developer', 'dvt', 'simulate-location', 'set']

  // `--` guards against a negative longitude being parsed as an option.
  const r = await run([...base, '--', String(lat), String(lng)], { timeout: 90000 })
  if (r.ok) return { ok: true }
  return { ok: false, error: classifyError(r) }
}

export async function clearLocation({ legacy = false } = {}) {
  const base = legacy
    ? ['developer', 'simulate-location', 'clear']
    : ['developer', 'dvt', 'simulate-location', 'clear']

  const r = await run([...base], { timeout: 60000 })
  if (r.ok) return { ok: true }
  return { ok: false, error: classifyError(r) }
}

export { run, classifyError, TUNNELD_PORT }
