import { execFile, execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, mkdirSync, mkdtempSync, lstatSync } from 'node:fs'
import { readFile, readdir, readlink, realpath, stat } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const desktop = JSON.parse(readFileSync(new URL('./lightcraft.lock.json', import.meta.url), 'utf8'))
const cli = JSON.parse(readFileSync(new URL('./lightcraft-cli.lock.json', import.meta.url), 'utf8'))

export function endpointPort(endpoint) {
  const match = /^127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(endpoint)
  if (!match || Number(match[1]) > 65535) throw new Error('LightCraft requires a 127.0.0.1 control address and a port from 1 to 65535.')
  return Number(match[1])
}

function libraryPath(input) {
  if (typeof input?.library !== 'string' || !isAbsolute(input.library) || input.library.includes('\0')) {
    throw new Error('Choose the absolute path of the LightCraft library to use.')
  }
  return resolve(input.library)
}

async function digest(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function powershell(script, signal) {
  const command = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return exec(command, ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; ${script}`], { signal, timeout: 10000, maxBuffer: 1024 * 1024 })
}

export async function inspectListener(endpoint, signal) {
  const port = endpointPort(endpoint)
  if (process.platform === 'darwin') {
    const { stdout } = await exec('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpun'], { signal, timeout: 10000 })
    const pids = [...new Set([...stdout.matchAll(/^p(\d+)$/gm)].map(m => Number(m[1])))]
    const addresses = [...stdout.matchAll(/^n(.+)$/gm)].map(m => m[1])
    const users = [...stdout.matchAll(/^u(\d+)$/gm)].map(m => Number(m[1]))
    if (pids.length !== 1 || !addresses.length || addresses.some(a => a !== endpoint) || users.some(u => u !== process.getuid())) {
      throw new Error('The LightCraft control address is not a single private loopback listener for this user.')
    }
    const pid = pids[0]
    const [{ stdout: files }, { stdout: started }] = await Promise.all([
      exec('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn'], { signal, timeout: 10000 }),
      exec('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { signal, timeout: 10000 }),
    ])
    const executable = files.split('\n').find(line => line.startsWith('n'))?.slice(1)
    if (!executable || !started.trim()) throw new Error('Cannot identify the LightCraft listening process.')
    return { pid, executable, started: started.trim() }
  }
  if (process.platform === 'win32') {
    const { stdout } = await powershell(`$s=@(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue); if($s.Count -ne 1 -or $s[0].LocalAddress -ne '127.0.0.1'){throw 'Expected one loopback listener'}; $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$s[0].OwningProcess); $o=Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid; if($o.Sid -ne [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value){throw 'Listener belongs to another user'}; @{pid=$p.ProcessId;executable=$p.ExecutablePath;started=$p.CreationDate.ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress`, signal)
    const listener = JSON.parse(stdout.replace(/^\uFEFF/, ''))
    if (!Number.isInteger(listener.pid) || !listener.executable || !listener.started) throw new Error('Cannot identify the LightCraft listening process.')
    return listener
  }
  if (process.platform === 'linux') {
    const lines = (await readFile('/proc/net/tcp', 'utf8')).trim().split('\n').slice(1)
    const rows = lines.map(line => line.trim().split(/\s+/)).filter(cols => parseInt(cols[1].split(':')[1], 16) === port && cols[3] === '0A')
    if (rows.length !== 1 || rows[0][1].split(':')[0] !== '0100007F' || Number(rows[0][7]) !== process.getuid()) {
      throw new Error('The LightCraft control address is not a single private loopback listener for this user.')
    }
    const inode = `socket:[${rows[0][9]}]`
    const listeners = []
    for (const pid of (await readdir('/proc')).filter(name => /^\d+$/.test(name))) {
      try {
        if ((await stat(`/proc/${pid}`)).uid !== process.getuid()) continue
        const descriptors = await readdir(`/proc/${pid}/fd`)
        let found = false
        for (const fd of descriptors) {
          try { if (await readlink(`/proc/${pid}/fd/${fd}`) === inode) found = true } catch {}
        }
        if (!found) continue
        const record = await readFile(`/proc/${pid}/stat`, 'utf8')
        listeners.push({ pid: Number(pid), executable: await readlink(`/proc/${pid}/exe`), started: record.slice(record.lastIndexOf(')') + 2).split(' ')[19] })
      } catch {}
    }
    if (listeners.length !== 1) throw new Error('Cannot identify the LightCraft listening process.')
    return listeners[0]
  }
  throw new Error('LightCraft process verification is unavailable on this platform.')
}

export async function verifyListener({ endpoint, installation, signal }, inspect = inspectListener) {
  if (!installation?.gui || !installation?.cli || installation.manifest?.version !== desktop.version || !/^[a-f0-9]{64}$/.test(installation.manifest.guiSha256) || !/^[a-f0-9]{64}$/.test(installation.manifest.cliSha256)) {
    throw new Error(`Verify the LightCraft ${desktop.version} installation before attaching.`)
  }
  const listener = await inspect(endpoint, signal)
  const [actual, expected, cliHash] = await Promise.all([
    digest(listener.executable), digest(installation.gui), digest(installation.cli),
  ])
  if (actual !== expected || expected !== installation.manifest.guiSha256 || cliHash !== installation.manifest.cliSha256) {
    throw new Error(`The listening app does not match LightCraft ${desktop.version}. No command was sent.`)
  }
  const version = await exec(installation.cli, ['--version'], { signal, timeout: 10000 })
  if (version.stdout.trim() !== `lightcraft-cli ${desktop.version}`) {
    throw new Error(`The listening app does not match LightCraft ${desktop.version}. No command was sent.`)
  }
  const current = await inspect(endpoint, signal)
  if (current.pid !== listener.pid || current.started !== listener.started || current.executable !== listener.executable) {
    throw new Error('The LightCraft listening process changed. Attach again before editing.')
  }
  return { ...listener, executableSha256: actual }
}

export async function readLibrary(endpoint, signal) {
  const port = endpointPort(endpoint)
  return new Promise((resolveResult, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const chunks = []
    let bytes = 0
    let done = false
    const finish = (error, result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      socket.destroy()
      if (error) reject(error)
      else resolveResult(result)
    }
    const abort = () => finish(new Error('LightCraft attachment cancelled.'))
    const timer = setTimeout(() => finish(new Error('LightCraft did not answer the library check. No edit was sent.')), 10000)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) { abort(); return }
    socket.once('connect', () => socket.write(JSON.stringify({ id: 1, method: 'engine.execute', params: { command: 'library.info', params: {} } }) + '\n'))
    socket.on('data', chunk => {
      chunks.push(chunk)
      bytes += chunk.length
      if (bytes > 64 * 1024 * 1024) { finish(new Error('LightCraft library reply exceeds the protocol limit.')); return }
      if (!chunk.includes(10)) return
      try {
        const reply = JSON.parse(Buffer.concat(chunks).toString('utf8').split('\n')[0])
        if (reply.id !== 1 || reply.ok !== true || typeof reply.result?.path !== 'string') throw new Error('LightCraft did not identify a persistent library.')
        finish(null, reply.result.path)
      } catch (error) { finish(error) }
    })
    socket.once('error', error => finish(error))
    socket.once('end', () => finish(new Error('LightCraft disconnected during the library check. No edit was sent.')))
  })
}

export async function probe(context) {
  const expected = await realpath(libraryPath(context.input))
  const identity = await verifyListener(context)
  const project = await realpath(await readLibrary(context.endpoint, context.signal))
  if (project !== expected) throw new Error(`LightCraft has a different library open: ${project}. Expected ${expected}. No edit was sent.`)
  return { identity: 'lightcraft', version: desktop.version, project, process: identity }
}

export async function verify(context) {
  const current = await probe(context)
  const previous = context.attached?.process
  if (!previous || current.process.pid !== previous.pid || current.process.started !== previous.started || current.process.executableSha256 !== previous.executableSha256) {
    throw new Error('The LightCraft process changed. Attach again before editing.')
  }
  return current
}

export function privateEnvironment(dataDir) {
  if (!isAbsolute(dataDir)) throw new Error('LightCraft requires an absolute private data directory.')
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const directory = lstatSync(dataDir)
  if (directory.isSymbolicLink() || !directory.isDirectory()) throw new Error('LightCraft data must be a private directory, not a link.')
  if (process.platform !== 'win32' && (directory.uid !== process.getuid() || (directory.mode & 0o077) !== 0)) {
    throw new Error('LightCraft data must be accessible only to the current user.')
  }
  const temp = mkdtempSync(join(dataDir, 'lightcraft-temp-'))
  const config = join(dataDir, 'lightcraft-config')
  mkdirSync(config, { recursive: true, mode: 0o700 })
  if (lstatSync(config).isSymbolicLink()) throw new Error('LightCraft configuration must not be a link.')
  if (process.platform === 'win32') {
    const command = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    for (const directory of [temp, config]) {
      execFileSync(command, ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; $p=$env:MERCURY_LIGHTCRAFT_PRIVATE_DIR; $u=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $a=Get-Acl -LiteralPath $p; $a.SetAccessRuleProtection($true,$false); foreach($r in @($a.Access)){$a.RemoveAccessRuleSpecific($r)}; $a.SetOwner($u); $r=New-Object System.Security.AccessControl.FileSystemAccessRule($u,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $a.AddAccessRule($r); Set-Acl -LiteralPath $p -AclObject $a; $v=Get-Acl -LiteralPath $p; if(-not $v.AreAccessRulesProtected -or @($v.Access | Where-Object {$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $u.Value}).Count -ne 0){throw 'Private directory ACL verification failed'}"], {
        env: { ...process.env, MERCURY_LIGHTCRAFT_PRIVATE_DIR: directory }, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
      })
    }
  }
  return { LIGHTCRAFT_CONFIG_DIR: config, TMPDIR: temp, TMP: temp, TEMP: temp }
}

async function runningApp(signal) {
  if (process.platform === 'win32') {
    const { stdout } = await powershell("@(Get-CimInstance Win32_Process -Filter \"Name='lightcraft.exe'\").Count", signal)
    return Number(stdout.trim()) > 0
  }
  try {
    await exec('/usr/bin/pgrep', ['-x', process.platform === 'darwin' ? 'LightCraft' : 'lightcraft'], { signal, timeout: 10000 })
    return true
  } catch (error) {
    if (error.code === 1) return false
    throw error
  }
}

export async function launch({ installation, endpoint, dataDir, input, signal }) {
  const port = endpointPort(endpoint)
  const library = libraryPath(input)
  if (await runningApp(signal)) throw new Error('LightCraft is already running. Save your work and enable its control port, then attach. The existing window was left open.')
  const reservation = createServer()
  await new Promise((done, reject) => { reservation.once('error', reject); reservation.listen(port, '127.0.0.1', done) })
  await new Promise(done => reservation.close(done))
  signal?.throwIfAborted()
  const child = spawn(installation.gui, ['--control', String(port), '--library', library], {
    env: { ...process.env, ...privateEnvironment(dataDir) }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: false,
  })
  child.stderr?.on('data', bytes => process.stderr.write(bytes))
  await new Promise((resolveSpawn, reject) => { child.once('spawn', resolveSpawn); child.once('error', reject) })
  const deadline = Date.now() + 30000
  let lastError
  while (Date.now() < deadline) {
    signal?.throwIfAborted()
    if (child.exitCode !== null) throw new Error(`LightCraft exited before attachment (${child.exitCode}).`)
    try { await probe({ installation, endpoint, dataDir, input, signal }); return child } catch (error) { lastError = error }
    await new Promise(done => setTimeout(done, 200))
  }
  throw new Error(`LightCraft opened but could not be verified: ${lastError?.message}. The window was left open.`)
}

export function upstream({ installation, endpoint, dataDir, input }) {
  const library = libraryPath(input)
  endpointPort(endpoint)
  return {
    command: installation.cli,
    args: input.mode === 'headless' ? ['mcp', '--library', library] : ['mcp', '--connect', endpoint],
    env: privateEnvironment(dataDir),
  }
}

export const adapter = {
  id: 'lightcraft', title: 'LightCraft', version: desktop.version, pins: [desktop, cli],
  guiBasename: process.platform === 'darwin' ? 'LightCraft' : 'lightcraft', cliBasename: 'lightcraft-cli', defaultPort: 7980,
  probe, launch, upstream, verify,
}
