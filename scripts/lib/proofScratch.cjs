const fs = require('node:fs')
const path = require('node:path')
const { fileURLToPath } = require('node:url')
const { syncBuiltinESMExports } = require('node:module')
if (fs.existsSync(path.join(__dirname, 'proofGuard.cjs'))) require('./proofGuard.cjs')

const RUN_ROOT_PREFIX = 'mercury-proof-run.'
const SINGLE_RUN_OWNER = 'MERCURY_SUITE_OF_ONE'
const SIGNAL_EXITS = [['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]]
const folders = new Set()
const kept = new Set()
const folderBornAtMs = new Map()
let installed = false
let ownRoot = ''
let madeRoot = false
let stopped = false
function noteScratchBirth(folder) {
  if (!folder) return
  const key = String(folder)
  const now = Date.now()
  if (!folderBornAtMs.has(key)) folderBornAtMs.set(key, now)
  try {
    const canon = fs.realpathSync(key)
    if (!folderBornAtMs.has(canon)) folderBornAtMs.set(canon, now)
  } catch {}
}
function keepAsked() {
  if (process.argv.some(word => word === '--keep' || word.startsWith('--keep-') || word.startsWith('--keep='))) return true
  return Object.entries(process.env).some(([name, value]) => /(?:^|_)KEEP(?:_FIXTURE|_SCRATCH)?$/.test(name) && value !== undefined && value !== '' && value !== '0' && value !== 'false')
}
function registerProofScratch(folder) {
  folders.add(folder)
  noteScratchBirth(folder)
  return folder
}
function keepProofScratch(folder) {
  kept.add(String(folder))
  for (const candidate of folders) {
    if (Buffer.from(candidate).equals(Buffer.from(folder))) folders.delete(candidate)
  }
}
function runRootBase(inherited, ownHome) {
  if (process.platform === 'win32') return ''
  const home = ownHome ? 'mercury-proof-home-XXXXXX' : 'config-home'
  let bound = NaN
  try {
    bound = Number(/^suite_socket_bound=(\d+)$/m.exec(fs.readFileSync(path.join(__dirname, 'suite-env.sh'), 'utf8'))?.[1])
  } catch {}
  if (!Number.isInteger(bound)) return ''
  for (const candidate of [inherited, '/tmp']) {
    try {
      const canon = fs.realpathSync(candidate)
      if (Buffer.byteLength(`${canon}/${RUN_ROOT_PREFIX}XXXXXX/${home}/daemon/control.sock`) <= bound) return canon
    } catch {}
  }
  return ''
}
function sweepOwnRoot(outside) {
  if (process.env.TMPDIR === ownRoot) process.env.TMPDIR = outside
  const held = [...kept].filter(folder => folder === ownRoot || folder.startsWith(ownRoot + path.sep))
  if (held.length === 0) return removeScratchFolder(ownRoot)
  for (const name of fs.readdirSync(ownRoot)) {
    const entry = path.join(ownRoot, name)
    if (!held.some(folder => folder === entry || folder.startsWith(entry + path.sep))) removeScratchFolder(entry)
  }
}
function holdsNothingToRead() {
  try {
    return fs.readdirSync(ownRoot).every(name => name.startsWith('mercury-proof-home-') && !kept.has(path.join(ownRoot, name)))
  } catch {
    return false
  }
}
function insideRunRoot(value, root) {
  const spellings = [root, `/private${root}`, root.startsWith('/private/') ? root.slice('/private'.length) : root]
  return spellings.some(spelling => value.startsWith(spelling + path.sep))
}
function scratchPrefix(prefix) {
  const root = process.env.MERCURY_SUITE_TMPDIR
  if (!root) return prefix
  try {
    const value = prefix instanceof URL ? fileURLToPath(prefix) : String(prefix)
    if (insideRunRoot(value, root)) return prefix
    if (/^\/(?:private\/)?tmp\/mw\//.test(value)) {
      const base = Buffer.from(root + path.sep)
      return Buffer.isBuffer(prefix)
        ? Buffer.concat([base, prefix.subarray(prefix.lastIndexOf(47) + 1)])
        : root + path.sep + value.slice(value.lastIndexOf('/') + 1)
    }
  } catch {
    return prefix
  }
  return prefix
}
function processStartedAt() {
  const { execFileSync } = require('node:child_process')
  for (const ps of ['ps', '/bin/ps', '/usr/bin/ps']) {
    try {
      const started = execFileSync(ps, ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, windowsHide: true }).trim()
      if (started) return started
    } catch {}
  }
  return '?'
}
function processFolder() {
  try {
    return process.cwd() || '?'
  } catch {
    return '?'
  }
}
function writeLedgerEntry(ledger) {
  try {
    fs.mkdirSync(ledger, { recursive: true })
    fs.writeFileSync(path.join(ledger, `${process.pid}.entry`), [process.pid, process.env.MERCURY_SUITE_RUNNER_PID || process.ppid, processStartedAt(), processFolder(), process.execPath].join('\t') + '\n')
  } catch {}
}
function installProofScratch(options = {}) {
  if (installed) return
  installed = true
  const runRoot = process.env.MERCURY_SUITE_TMPDIR
  const ledger = process.env.MERCURY_PROCESS_LEDGER_DIR
  if (ledger) writeLedgerEntry(ledger)
  const sync = fs.mkdtempSync
  const callback = fs.mkdtemp
  const promise = fs.promises.mkdtemp
  const inherited = require('node:os').tmpdir()
  const inRunRoot = path.basename(inherited).startsWith(RUN_ROOT_PREFIX)
  const adopted = !runRoot && inRunRoot && process.env[SINGLE_RUN_OWNER] === String(process.pid)
  const guest = !adopted && (Boolean(runRoot) || inRunRoot)
  const outside = adopted ? path.dirname(inherited) : inherited
  if (adopted) {
    ownRoot = inherited
    noteScratchBirth(ownRoot)
  } else if (!guest) {
    const base = runRootBase(inherited, options.ownHome === true)
    if (base) {
      try {
        ownRoot = sync(path.join(base, RUN_ROOT_PREFIX))
        noteScratchBirth(ownRoot)
        madeRoot = true
        process.env.TMPDIR = ownRoot
        process.env.MERCURY_TMPDIR = ownRoot
      } catch {
        ownRoot = ''
      }
    } else if (process.platform === 'win32' && !process.env.MERCURY_TMPDIR) {
      try {
        ownRoot = sync(path.join(inherited, RUN_ROOT_PREFIX))
        noteScratchBirth(ownRoot)
        process.env.MERCURY_TMPDIR = ownRoot
      } catch {
        ownRoot = ''
      }
    }
  }
  fs.mkdtempSync = function(prefix, options) {
    return registerProofScratch(sync.call(this, scratchPrefix(prefix), options))
  }
  fs.mkdtemp = function(prefix, options, done) {
    if (typeof options !== 'function' && typeof done !== 'function') return callback.apply(this, arguments)
    if (typeof options === 'function') { done = options; options = undefined }
    return callback.call(this, scratchPrefix(prefix), options, (error, folder) => {
      if (!error) registerProofScratch(folder)
      done(error, folder)
    })
  }
  fs.promises.mkdtemp = async function(prefix, options) {
    return registerProofScratch(await promise.call(this, scratchPrefix(prefix), options))
  }
  syncBuiltinESMExports()
  if (!process.env.MERCURY_SUITE_BROWSER_CLEANER) {
    try {
      require('./proofBrowser.cjs').installProofBrowser(profile => {
        const root = process.env.MERCURY_SUITE_TMPDIR || ownRoot
        return folders.has(profile) || Boolean(root && path.resolve(profile).startsWith(path.resolve(root) + path.sep))
      })
    } catch {}
  }
  if (ownRoot) {
    for (const [signal, code] of SIGNAL_EXITS) {
      process.on(signal, () => {
        if (process.listenerCount(signal) !== 1) return
        stopped = true
        process.exit(code)
      })
    }
  }
  process.on('exit', code => {
    if (guest) return
    if ((code !== 0 && !stopped) || keepAsked()) {
      if (ownRoot && !kept.has(ownRoot) && holdsNothingToRead()) {
        try { reapDaemonFoldersSync([ownRoot]) } catch {}
        try { removeScratchFolder(ownRoot) } catch {}
      }
      return
    }
    try { reapDaemonFoldersSync([...folders, ...(ownRoot ? [ownRoot] : [])]) } catch {}
    for (const folder of [...folders].reverse()) {
      try { removeScratchFolder(folder) } catch (error) {
        process.stderr.write(`proof scratch cleanup failed: ${folder}: ${error.message}\n`)
        process.exitCode = process.exitCode || 1
      }
    }
    if (!ownRoot) return
    try { sweepOwnRoot(outside) } catch (error) {
      process.stderr.write(`proof scratch left behind: ${ownRoot}: ${error.message}\n`)
    }
  })
}
const SKIP_SCAN_DIRS = new Set(['node_modules', '.git', 'vendor'])
const BIRTH_SLACK_MS = 1000
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  if (process.platform === 'win32') return true
  const { execFileSync } = require('node:child_process')
  for (const ps of ['ps', '/bin/ps', '/usr/bin/ps']) {
    try {
      const state = execFileSync(ps, ['-o', 'state=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000, windowsHide: true }).trim()
      if (state) return !state.startsWith('Z')
    } catch {}
  }
  return true
}
function win32PsExe() {
  const rawPath = process.env.PATH || ''
  const sep = rawPath.includes(';') && !rawPath.includes(':') ? ';' : path.delimiter
  for (const dir of rawPath.split(sep)) {
    if (!dir) continue
    const candidate = path.join(dir, 'pwsh.exe')
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {}
  }
  const fixed = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')
  try {
    if (fs.existsSync(fixed)) return fixed
  } catch {}
  return 'powershell.exe'
}
function inspectProcess(pid) {
  if (!pidAlive(pid)) return { state: 'gone' }
  const { execFileSync } = require('node:child_process')
  if (process.platform === 'win32') {
    const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { $t = if ($p.CreationDate) { $p.CreationDate.ToUniversalTime().ToString('o') } else { '' }; Write-Output ($t + [char]9 + [string]$p.CommandLine) }`
    let raw = ''
    try {
      raw = execFileSync(win32PsExe(), ['-NoProfile', '-Command', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000, windowsHide: true })
    } catch {
      return pidAlive(pid) ? { state: 'unreadable' } : { state: 'gone' }
    }
    const line = String(raw || '').replace(/\r?\n$/, '')
    if (!line.trim()) return pidAlive(pid) ? { state: 'unreadable' } : { state: 'gone' }
    const tab = line.indexOf('\t')
    if (tab < 0) return pidAlive(pid) ? { state: 'unreadable' } : { state: 'gone' }
    const bornMs = Date.parse(line.slice(0, tab).trim())
    const command = line.slice(tab + 1).trim()
    if (!Number.isFinite(bornMs)) return pidAlive(pid) ? { state: 'unreadable' } : { state: 'gone' }
    return { state: 'ok', bornMs, command }
  }
  for (const ps of ['ps', '/bin/ps', '/usr/bin/ps']) {
    try {
      const out = execFileSync(ps, ['-o', 'lstart=,command=', '-p', String(pid)], {
        encoding: 'utf8',
        env: Object.assign({}, process.env, { LC_ALL: 'C' }),
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
        windowsHide: true,
      }).trim()
      if (!out) continue
      const m = out.match(/^([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+([\s\S]+)$/)
      if (!m) continue
      const bornMs = Date.parse(m[1])
      if (!Number.isFinite(bornMs)) continue
      return { state: 'ok', bornMs, command: m[2].trim() }
    } catch {}
  }
  return pidAlive(pid) ? { state: 'unreadable' } : { state: 'gone' }
}
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
function hasBoundedScratchRoot(command, root, win32) {
  const clean = String(root || '').replace(/[\\/]+$/, '')
  if (!clean) return false
  if (win32) {
    const pattern = new RegExp(escapeRegex(clean.replace(/\//g, '\\')) + '(?:\\\\|$|[\\s"\'])', 'i')
    return pattern.test(String(command).replace(/\//g, '\\'))
  }
  const pattern = new RegExp(escapeRegex(clean) + '(?:/|$|[\\s"\'])')
  return pattern.test(command)
}
function commandMatchesScratchOrRepo(command, roots) {
  if (!command) return false
  const repoRoot = path.resolve(__dirname, '..', '..')
  if (process.platform === 'win32') {
    const norm = s => String(s).replace(/\//g, '\\').toLowerCase().replace(/\\+$/, '')
    const cmdNorm = String(command).replace(/\//g, '\\').toLowerCase()
    if (roots.some(root => hasBoundedScratchRoot(command, root, true))) return true
    return cmdNorm.includes(norm(repoRoot) + '\\')
  }
  if (roots.some(root => hasBoundedScratchRoot(command, root, false))) return true
  return command.includes(repoRoot + path.sep)
}
function folderBirthBoundMs(list) {
  let latest = -Infinity
  for (const raw of list) {
    if (!raw) continue
    const folder = String(raw)
    const registered = folderBornAtMs.get(folder)
    if (typeof registered === 'number' && Number.isFinite(registered)) {
      if (registered > latest) latest = registered
      continue
    }
    try {
      const canon = fs.realpathSync(folder)
      const regCanon = folderBornAtMs.get(canon)
      if (typeof regCanon === 'number' && Number.isFinite(regCanon)) {
        if (regCanon > latest) latest = regCanon
        continue
      }
    } catch {}
    try {
      const st = fs.statSync(folder)
      if (typeof st.birthtimeMs === 'number' && Number.isFinite(st.birthtimeMs) && st.birthtimeMs > 0) {
        if (st.birthtimeMs > latest) latest = st.birthtimeMs
      }
    } catch {}
  }
  return Number.isFinite(latest) ? latest : NaN
}
function ownedByScratch(pid, roots, notAfterMs) {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid || pid === process.ppid) return false
  if (process.env.MERCURY_SUITE_RUNNER_PID && String(pid) === process.env.MERCURY_SUITE_RUNNER_PID) return false
  const info = inspectProcess(pid)
  if (info.state === 'gone') return false
  if (!Number.isFinite(notAfterMs)) {
    process.stderr.write(`proof scratch: birth bound unavailable for pid ${pid}; leaving it untouched\n`)
    return false
  }
  if (info.state === 'unreadable') {
    process.stderr.write(`proof scratch: birth time unreadable for pid ${pid}; leaving it untouched\n`)
    return false
  }
  if (info.bornMs > notAfterMs + BIRTH_SLACK_MS) return false
  return commandMatchesScratchOrRepo(info.command, roots)
}
function daemonPidsInFolder(dir) {
  const daemonEntries = []
  const workerEntries = []
  for (const jsonName of ['daemon.json', 'daemon.lock']) {
    try {
      const jf = path.join(dir, jsonName)
      if (fs.existsSync(jf)) {
        const mtimeMs = fs.statSync(jf).mtimeMs
        const parsed = JSON.parse(fs.readFileSync(jf, 'utf8'))
        if (parsed && typeof parsed === 'object' && Number.isInteger(parsed.pid) && parsed.pid > 1) {
          daemonEntries.push({ pid: parsed.pid, notAfterMs: mtimeMs })
        }
      }
    } catch {}
  }
  try {
    const pidFile = path.join(dir, 'daemon.pid')
    if (fs.existsSync(pidFile)) {
      const mtimeMs = fs.statSync(pidFile).mtimeMs
      const pid = Number(fs.readFileSync(pidFile, 'utf8').trim())
      if (Number.isInteger(pid) && pid > 1) daemonEntries.push({ pid, notAfterMs: mtimeMs })
    }
  } catch {}
  try {
    for (const name of fs.readdirSync(dir)) {
      const m = name.match(/^hermes-daemon-[^.]+\.sock\.(\d+)$/)
      if (m) {
        const pid = Number(m[1])
        const mtimeMs = fs.lstatSync(path.join(dir, name)).mtimeMs
        if (Number.isInteger(pid) && pid > 1) daemonEntries.push({ pid, notAfterMs: mtimeMs })
      }
    }
  } catch {}
  try {
    const workersFile = path.join(dir, 'concourse-workers.json')
    if (fs.existsSync(workersFile)) {
      const fileMtimeMs = fs.statSync(workersFile).mtimeMs
      const parsed = JSON.parse(fs.readFileSync(workersFile, 'utf8'))
      if (parsed && typeof parsed === 'object') {
        const map = parsed.workers && typeof parsed.workers === 'object' && !Array.isArray(parsed.workers) ? parsed.workers : parsed
        for (const rec of Object.values(map)) {
          if (rec && typeof rec === 'object' && rec.endedAt === undefined && Number.isInteger(rec.pid) && rec.pid > 1) {
            let stampMs = NaN
            if (typeof rec.procStart === 'string') stampMs = Date.parse(rec.procStart)
            if (!Number.isFinite(stampMs) && typeof rec.spawnedAt === 'number' && Number.isFinite(rec.spawnedAt)) stampMs = rec.spawnedAt
            if (!Number.isFinite(stampMs)) stampMs = fileMtimeMs
            workerEntries.push({ pid: rec.pid, notAfterMs: stampMs })
          }
        }
      }
    }
  } catch {}
  return [...daemonEntries, ...workerEntries]
}
function findDaemonFolders(start, maxDepth = 3) {
  const found = []
  const MARKERS = new Set(['daemon.json', 'daemon.lock', 'daemon.pid', 'concourse-workers.json'])
  const walk = (cur, depth) => {
    let entries
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      return
    }
    if (entries.some(e => MARKERS.has(e.name) || /^hermes-daemon-[^.]+\.sock\.\d+$/.test(e.name))) found.push(cur)
    if (depth >= maxDepth) return
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || SKIP_SCAN_DIRS.has(entry.name)) continue
      walk(path.join(cur, entry.name), depth + 1)
    }
  }
  walk(start, 0)
  return found
}
function reapPidsSync(pids, graceMs = 1500) {
  const unique = [...new Set(pids.filter(pidAlive))]
  if (unique.length === 0) return
  for (const pid of unique) {
    try { process.kill(pid, 'SIGTERM') } catch {}
  }
  const deadline = Date.now() + Math.max(0, graceMs)
  while (Date.now() < deadline && unique.some(pidAlive)) sleepSync(25)
  const survivors = unique.filter(pidAlive)
  if (survivors.length === 0) return
  for (const pid of survivors) {
    try { process.kill(pid, 'SIGKILL') } catch {}
  }
  const killDeadline = Date.now() + 250
  while (Date.now() < killDeadline && survivors.some(pidAlive)) sleepSync(25)
}
function reapDaemonFoldersSync(targetFolders, graceMs = 1500) {
  const roots = []
  const daemonDirs = new Set()
  for (const raw of targetFolders) {
    if (!raw) continue
    const folder = String(raw)
    roots.push(folder)
    try { roots.push(fs.realpathSync(folder)) } catch {}
    for (const dir of findDaemonFolders(folder)) daemonDirs.add(dir)
  }
  const pids = []
  for (const dir of daemonDirs) {
    for (const entry of daemonPidsInFolder(dir)) {
      if (ownedByScratch(entry.pid, roots, entry.notAfterMs)) pids.push(entry.pid)
    }
  }
  reapPidsSync(pids, graceMs)
}
function reapThenRemove(pids, targetFolders, opts = {}) {
  const graceMs = opts && typeof opts.graceMs === 'number' ? opts.graceMs : 1500
  const list = Array.isArray(targetFolders) ? targetFolders : [targetFolders]
  const notAfterMs = opts && typeof opts.notAfterMs === 'number' ? opts.notAfterMs : folderBirthBoundMs(list)
  const roots = []
  for (const raw of list) {
    if (!raw) continue
    roots.push(String(raw))
    try { roots.push(fs.realpathSync(String(raw))) } catch {}
  }
  const owned = (Array.isArray(pids) ? pids : []).filter(pid => ownedByScratch(pid, roots, notAfterMs))
  reapPidsSync(owned, graceMs)
  reapDaemonFoldersSync(list, graceMs)
  for (const folder of list) {
    if (folder) removeScratchFolder(String(folder))
  }
}
const RETRY_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EMFILE', 'ENFILE'])
function removeScratchFolder(folder, maxRetries = 10, retryDelayMs = 100) {
  let cwd = ''
  try { cwd = process.cwd() } catch {}
  const inside = cwd === '' ? '..' : path.relative(path.resolve(folder), cwd)
  if (inside === '' || (!inside.startsWith('..') && !path.isAbsolute(inside))) {
    try { process.chdir(require('node:os').tmpdir()) } catch {}
  }
  for (let attempt = 0; ; attempt++) {
    try {
      fs.rmSync(folder, { recursive: true, force: true })
      return
    } catch (error) {
      const code = error && error.code ? error.code : ''
      if (code === 'ENOENT' && !fs.existsSync(folder)) return
      if (attempt >= maxRetries || !RETRY_CODES.has(code)) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, retryDelayMs * (attempt + 1))
    }
  }
}
function singleRunRootMadeHere() {
  return madeRoot ? ownRoot : ''
}
module.exports = { installProofScratch, registerProofScratch, keepProofScratch, removeScratchFolder, reapDaemonFoldersSync, reapThenRemove, singleRunRootMadeHere, SINGLE_RUN_OWNER }
if (process.env.MERCURY_SUITE_TMPDIR) {
  try {
    installProofScratch()
  } catch {}
}
