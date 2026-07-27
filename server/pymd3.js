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

/**
 * tunneld being reachable is not enough — it can be up with no tunnel to our
 * device. Its index returns { <udid>: [{ tunnel-address, tunnel-port, ... }] },
 * so confirm the specific UDID is present.
 */
export async function tunnelForDevice(udid) {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 2000)
    const res = await fetch(`http://127.0.0.1:${TUNNELD_PORT}/`, { signal: ctrl.signal })
    clearTimeout(t)
    if (!res.ok) return { daemon: false, tunnel: false }

    const map = await res.json()
    const entries = udid ? map?.[udid] : Object.values(map || {})[0]
    return { daemon: true, tunnel: Array.isArray(entries) && entries.length > 0 }
  } catch {
    return { daemon: false, tunnel: false }
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
 * On iOS 17+ the DVT session owns the simulation: `simulate-location set`
 * applies the coordinate, prints "Press ENTER to exit", then blocks. The
 * override lives only as long as that process does, so the process is kept
 * alive and tracked here rather than awaited to completion.
 *
 * Its stdin must stay open — closing it sends EOF, the prompt reads it as
 * "exit", and the simulation is torn down immediately.
 */
let activeSimulation = null

function killTree(child) {
  try {
    if (process.platform === 'win32' && child.pid) {
      // `python -m pymobiledevice3` runs as a parent/child pair, and on Windows
      // killing the parent orphans the child, which keeps holding the device.
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    } else {
      child.kill()
    }
  } catch {
    // already gone
  }
}

function stopActiveSimulation() {
  if (!activeSimulation) return false
  const { child } = activeSimulation
  activeSimulation = null
  killTree(child)
  return true
}

export function activeSimulationCoord() {
  return activeSimulation ? { lat: activeSimulation.lat, lng: activeSimulation.lng } : null
}

/** Applied-and-holding signal printed by pymobiledevice3 once the coord lands. */
const HOLD_PROMPT = /Press ENTER to exit/i

/** Grace period after which a still-running process is taken as holding. */
const HOLD_GRACE_MS = 15000
const HOLD_HARD_TIMEOUT_MS = 90000

function setLocationDvt(lat, lng, udid) {
  return new Promise((resolve) => {
    const args = ['-m', 'pymobiledevice3', 'developer', 'dvt', 'simulate-location', 'set']
    // Without --tunnel the CLI ignores a running tunneld and spins up its own
    // userspace tunnel, which is slow and often stalls.
    if (udid) args.push('--tunnel', udid)
    // `--` guards against a negative longitude being parsed as an option.
    args.push('--', String(lat), String(lng))

    const child = spawn(PYTHON, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      // The hold prompt has no trailing newline, so a buffered Python would
      // never flush it down the pipe and the success signal would be missed.
      env: { ...process.env, PYTHONUNBUFFERED: '1' }
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const succeed = () => {
      if (settled) return
      settled = true
      clearTimeout(hardTimer)
      clearTimeout(graceTimer)
      activeSimulation = { child, lat, lng }
      resolve({ ok: true })
    }

    const fail = (result) => {
      if (settled) return
      settled = true
      clearTimeout(hardTimer)
      clearTimeout(graceTimer)
      resolve(result)
    }

    const hardTimer = setTimeout(() => {
      killTree(child)
      fail({ ok: false, error: classifyError({ stdout, stderr, timedOut: true }) })
    }, HOLD_HARD_TIMEOUT_MS)

    // Fallback for when the prompt never reaches us: a process that is still
    // alive and quiet at this point has applied the coordinate and is holding.
    const graceTimer = setTimeout(() => {
      if (child.exitCode === null && !/error|traceback/i.test(stderr)) succeed()
    }, HOLD_GRACE_MS)

    child.stdout.on('data', (d) => {
      stdout += d
      if (HOLD_PROMPT.test(stdout)) succeed()
    })

    child.stderr.on('data', (d) => { stderr += d })

    child.on('error', (err) => {
      fail({ ok: false, error: { code: 'SPAWN_FAILED', message: err.message } })
    })

    // Exiting before the hold state means the coordinate never took.
    child.on('close', (code) => {
      if (activeSimulation?.child === child) activeSimulation = null
      fail({ ok: false, error: classifyError({ stdout, stderr, code }) })
    })
  })
}

export async function setLocation(lat, lng, { legacy = false, udid } = {}) {
  stopActiveSimulation()

  if (legacy) {
    // Pre-17 devices persist the override server-side, so the command exits.
    const r = await run(['developer', 'simulate-location', 'set', '--', String(lat), String(lng)], {
      timeout: 60000
    })
    return r.ok ? { ok: true } : { ok: false, error: classifyError(r) }
  }

  return setLocationDvt(lat, lng, udid)
}

export async function clearLocation({ legacy = false } = {}) {
  if (legacy) {
    const r = await run(['developer', 'simulate-location', 'clear'], { timeout: 60000 })
    return r.ok ? { ok: true } : { ok: false, error: classifyError(r) }
  }

  // Ending the DVT session is what restores real GPS on iOS 17+.
  stopActiveSimulation()
  return { ok: true }
}

// Don't leave a stray python process holding the device after the bridge dies.
for (const sig of ['exit', 'SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopActiveSimulation()
    if (sig !== 'exit') process.exit(0)
  })
}

export { run, classifyError, TUNNELD_PORT }
