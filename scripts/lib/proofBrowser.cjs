const fs = require('node:fs')
const path = require('node:path')
const cp = require('node:child_process')
const { syncBuiltinESMExports } = require('node:module')

const owned = new Set()
let installed = false
function identity(pid) {
  if (!Number.isInteger(pid) || pid < 2) return ''
  const result = cp.spawnSync('ps', ['-o', 'lstart=', '-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' })
  const row = (result.stdout || '').trim()
  return /\sZ\S*$/.test(row) ? '' : row.replace(/\s+\S+$/, '')
}
function cleaner(files) {
  if (files.length === 0) return
  const result = cp.spawnSync(process.execPath, [__filename, ...files], {
    env: { ...process.env, MERCURY_SUITE_BROWSER_CLEANER: '1' },
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: 10_000 + files.length * 5_000,
  })
  if (result.status !== 0) {
    process.stderr.write(`proof browser: cleanup helper failed (${result.status ?? result.signal})\n`)
    process.exitCode = process.exitCode || 1
  }
}
function installProofBrowser(isOwnedProfile) {
  if (installed || process.env.MERCURY_SUITE_BROWSER_CLEANER) return
  installed = true
  const spawn = cp.spawn
  cp.spawn = function(file, args, options) {
    const child = spawn.apply(this, arguments)
    const profileArg = Array.isArray(args) && args.find(arg => typeof arg === 'string' && arg.startsWith('--user-data-dir='))
    const debug = Array.isArray(args) && args.some(arg => typeof arg === 'string' && arg.startsWith('--remote-debugging-port='))
    if (!profileArg || !debug || !child.pid) return child
    const profile = profileArg.slice('--user-data-dir='.length)
    if (!isOwnedProfile(profile)) return child
    const ledger = process.env.MERCURY_SUITE_TMPDIR
      ? path.join(process.env.MERCURY_SUITE_TMPDIR, 'browser-ledger')
      : path.join(profile, '.proof-browser-ledger')
    fs.mkdirSync(ledger, { recursive: true })
    const entry = path.join(ledger, `${child.pid}.json`)
    fs.writeFileSync(entry, JSON.stringify({ pid: child.pid, identity: identity(child.pid), profile }))
    owned.add(entry)
    const kill = child.kill.bind(child)
    child.kill = function(signal) {
      if ([undefined, 'SIGTERM', 'SIGKILL', 15, 9].includes(signal) && fs.existsSync(entry) && identity(child.pid)) {
        cleaner([entry])
        return identity(child.pid) === ''
      }
      return kill(signal)
    }
    return child
  }
  syncBuiltinESMExports()
  process.prependListener('exit', () => cleaner([...owned].filter(file => fs.existsSync(file))))
}
async function protocolClose(profile) {
  const [port, endpoint] = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').trim().split('\n')
  if (!/^\d+$/.test(port) || !endpoint.startsWith('/devtools/browser/')) return false
  return new Promise(resolve => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`)
    const timer = setTimeout(() => finish(false), 1500)
    let sent = false
    let settled = false
    function finish(ok) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.close()
      resolve(ok)
    }
    socket.onopen = () => { sent = true; socket.send(JSON.stringify({ id: 1, method: 'Browser.close' })) }
    socket.onmessage = event => {
      try { const reply = JSON.parse(String(event.data)); if (reply.id === 1) finish(!reply.error) } catch {}
    }
    socket.onerror = () => finish(false)
    socket.onclose = () => finish(sent)
  })
}
function endTree(pid) {
  if (!Number.isInteger(pid) || pid < 2 || pid === process.pid) return
  try { process.kill(pid, 'SIGSTOP') } catch { return }
  const children = cp.spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
  for (const child of (children.stdout || '').trim().split(/\s+/).filter(Boolean)) endTree(Number(child))
  try { process.kill(pid, 'SIGKILL') } catch {}
}
async function closeEntry(file) {
  let entry
  try { entry = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return }
  const same = () => entry.identity !== '' && identity(entry.pid) === entry.identity
  let protocol = 'gone'
  let fallback = false
  if (same()) {
    const deadline = Date.now() + 3000
    try { protocol = await protocolClose(entry.profile) ? 'closed' : 'unavailable' } catch { protocol = 'unavailable' }
    while (same() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
    if (same()) {
      fallback = true
      endTree(entry.pid)
      const end = Date.now() + 1500
      while (same() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  fs.rmSync(entry.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  fs.rmSync(file, { force: true })
  process.stdout.write(`proof browser: pid=${entry.pid} protocol=${protocol} fallback=${fallback}\n`)
  if (same()) throw new Error(`browser ${entry.pid} survived cleanup`)
}
function quiesce(pid, root, ledger) {
  if (!Number.isInteger(pid) || pid < 2 || pid === process.pid) return
  const args = cp.spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout || ''
  const profile = /--user-data-dir=(.*?)(?=\s--|\n|$)/.exec(args)?.[1]?.trim()
  if (profile && args.includes('--remote-debugging-port=') && path.resolve(profile).startsWith(path.resolve(root) + path.sep)) {
    fs.mkdirSync(ledger, { recursive: true })
    const entry = path.join(ledger, `${pid}.json`)
    if (!fs.existsSync(entry)) fs.writeFileSync(entry, JSON.stringify({ pid, identity: identity(pid), profile }))
    return
  }
  try { process.kill(pid, 'SIGSTOP') } catch { return }
  const children = cp.spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).stdout || ''
  for (const child of children.trim().split(/\s+/).filter(Boolean)) quiesce(Number(child), root, ledger)
}
module.exports = { installProofBrowser, closeEntry }
if (require.main === module) {
  let inputs = process.argv.slice(2)
  if (inputs[0] === '--quiesce') {
    const root = inputs[2]
    const ledger = path.join(root, 'browser-ledger')
    quiesce(Number(inputs[1]), root, ledger)
    inputs = [ledger]
  }
  const files = inputs.flatMap(file => {
    if (!fs.existsSync(file)) return []
    return fs.statSync(file).isDirectory() ? fs.readdirSync(file).filter(name => name.endsWith('.json')).map(name => path.join(file, name)) : [file]
  })
  Promise.all(files.map(closeEntry)).catch(error => { console.error(error.message); process.exitCode = 1 })
}
