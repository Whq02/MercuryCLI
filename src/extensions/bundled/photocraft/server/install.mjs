import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse } from 'node:path'
import desktopLock from './photocraft.lock.json' with { type: 'json' }
import cliLock from './photocraft-cli.lock.json' with { type: 'json' }
import notices from './notices.json' with { type: 'json' }
import { verifyListener } from '../shared/control.mjs'

const VERSION = '0.14.0'
const REMEDY = 'Save your work, then restart PhotoCraft with control enabled and the selected project folders. The open window has not been changed.'
const descriptorPath = dataDir => join(dataDir, 'photocraft-instance.json')
export const tokenPath = dataDir => join(dataDir, 'photocraft-control', 'control.token')

export function endpointParts(endpoint) {
  const match = /^127\.0\.0\.1:(\d+)$/.exec(endpoint)
  if (!match || +match[1] < 1 || +match[1] > 65535) throw new Error('PhotoCraft requires 127.0.0.1 and a port from 1 to 65535.')
  return { host: '127.0.0.1', port: +match[1] }
}

export function scopedRoots(input) {
  const readRoot = input.readRoot ?? input.project
  const writeRoot = input.writeRoot
  const check = (value, label) => {
    if (typeof value !== 'string' || !isAbsolute(value) || /[\r\n\0]/.test(value)) throw new Error(`PhotoCraft needs an absolute ${label} folder.`)
    const path = realpathSync(value)
    if (!statSync(path).isDirectory() || path === parse(path).root || path === realpathSync(homedir())) throw new Error(`Choose a project ${label} folder, not a home folder or disk root.`)
    return path
  }
  return { readRoot: check(readRoot, 'input'), writeRoot: check(writeRoot, 'output') }
}

function windowsPrivate(path, create) {
  const script = create
    ? '$p=$env:PHOTOCRAFT_PRIVATE_PATH;$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false);$rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,"FullControl","ContainerInherit,ObjectInherit","None","Allow");$acl.AddAccessRule($rule);Set-Acl -LiteralPath $p -AclObject $acl'
    : '$p=$env:PHOTOCRAFT_PRIVATE_PATH;$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$acl=Get-Acl -LiteralPath $p;if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid){throw "Control file has another owner"};foreach($r in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($r.AccessControlType -eq "Allow" -and $r.IdentityReference.Value -ne $sid){throw "Control file grants another identity access"}}'
  try { execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop';${script}`], { env: { ...process.env, PHOTOCRAFT_PRIVATE_PATH: path }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 }) }
  catch { throw new Error('PhotoCraft control credentials require a user-only Windows ACL.') }
}

export function prepareControl(dataDir) {
  const folder = dirname(tokenPath(dataDir))
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  const info = lstatSync(folder)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('PhotoCraft control folder must be a private directory, not a link.')
  if (process.platform === 'win32') windowsPrivate(folder, true)
  else if ((info.mode & 0o077) !== 0 || info.uid !== process.getuid()) throw new Error('PhotoCraft control folder must be private to the current user.')
  if (existsSync(tokenPath(dataDir))) readPrivateToken(tokenPath(dataDir))
  return tokenPath(dataDir)
}

export function readPrivateToken(path) {
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('PhotoCraft control token must be a private regular file.')
  if (process.platform === 'win32') windowsPrivate(path, false)
  else if ((info.mode & 0o077) !== 0 || info.uid !== process.getuid()) throw new Error('PhotoCraft control token must be readable only by the current user.')
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fstatSync(fd)
    if (opened.dev !== info.dev || opened.ino !== info.ino || opened.size > 256) throw new Error('PhotoCraft control token file changed.')
    const token = readFileSync(fd, 'utf8').trim()
    if (!/^[a-fA-F0-9]{64}$/.test(token)) throw new Error('PhotoCraft control token file is invalid.')
    return token
  } finally { closeSync(fd) }
}

export async function inspectControl({ endpoint, tokenFile, signal, timeoutMs = 8000 }) {
  const address = endpointParts(endpoint)
  const token = readPrivateToken(tokenFile)
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const socket = createConnection(address)
    socket.setEncoding('utf8')
    let buffer = '', authenticated = false, settled = false
    const finish = (error, result) => {
      if (settled) return
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); socket.destroy()
      if (error) reject(error); else resolve(result)
    }
    const abort = () => finish(new Error('PhotoCraft attachment cancelled.'))
    const timer = setTimeout(() => finish(new Error('PhotoCraft did not answer the attachment check. No edit was sent.')), timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    socket.once('error', () => finish(new Error(`PhotoCraft control is unavailable. ${REMEDY}`)))
    socket.once('end', () => finish(new Error('PhotoCraft disconnected during attachment. No edit was sent.')))
    socket.once('connect', () => socket.write(JSON.stringify({ id: 1, method: 'auth', params: { token } }) + '\n'))
    socket.on('data', chunk => {
      buffer += chunk
      if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) return finish(new Error('PhotoCraft returned an invalid attachment response.'))
      let boundary
      while ((boundary = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1)
        let response
        try { response = JSON.parse(line) } catch { return finish(new Error('The selected port did not answer as PhotoCraft.')) }
        if (!authenticated) {
          if (response.id !== 1 || response.ok !== true) return finish(new Error('PhotoCraft control authentication failed. Check the selected instance and token file.'))
          authenticated = true
          socket.write(JSON.stringify({ id: 2, method: 'ui.inspect', params: {} }) + '\n')
        } else {
          const state = response.result
          if (response.id !== 2 || response.ok !== true || !state?.window || !state.session || !('document' in state)) return finish(new Error('The selected port did not identify a PhotoCraft desktop window.'))
          finish(null, state)
        }
      }
    })
  })
}

function sha(path) { return createHash('sha256').update(readFileSync(path)).digest('hex') }
function versionOf(binary) {
  let text
  try { text = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
  catch { throw new Error('PhotoCraft version could not be verified.') }
  if (!/^photocraft(?:-cli)? 0\.14\.0\b/i.test(text)) throw new Error('PhotoCraft and its command-line tool must both be version 0.14.0. No existing installation was replaced.')
  return VERSION
}

function runningCommand(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('PhotoCraft instance record has no valid process.')
  try {
    if (process.platform === 'win32') return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`], { encoding: 'utf8', timeout: 10000 }).trim()
    if (process.platform === 'linux') return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ')
    return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 10000 }).trim()
  } catch { throw new Error(`The recorded PhotoCraft process is no longer running. ${REMEDY}`) }
}

function descriptor(dataDir, endpoint) {
  let record
  try { record = JSON.parse(readFileSync(descriptorPath(dataDir), 'utf8')) }
  catch { throw new Error(`This PhotoCraft window has no verified project record. ${REMEDY}`) }
  if (record.version !== VERSION || record.endpoint !== endpoint || !Array.isArray(record.args)) throw new Error(`The PhotoCraft instance does not match the selected version or address. ${REMEDY}`)
  if (record.tokenFile !== tokenPath(dataDir)) throw new Error('PhotoCraft instance record names a different control file.')
  const actual = runningCommand(record.pid).replaceAll('"', '')
  if (actual !== [record.gui, ...record.args].join(' ') || sha(record.gui) !== record.guiSha256) throw new Error(`The PhotoCraft process no longer matches its project record. ${REMEDY}`)
  scopedRoots(record)
  return record
}

export async function probe({ endpoint, dataDir, signal, installation, input = {} }) {
  const listener = await verifyListener(endpoint, installation.gui, { signal, expectedSha256: installation.manifest.guiSha256 })
  let record
  if (input.tokenFile) {
    if (!isAbsolute(input.tokenFile) || /[\r\n\0]/.test(input.tokenFile)) throw new Error('PhotoCraft needs an absolute private control-file path.')
    const roots = scopedRoots(input)
    const args = ['--control', String(endpointParts(endpoint).port), '--control-token-file', input.tokenFile, '--automation-read-root', roots.readRoot, '--automation-write-root', roots.writeRoot]
    if (runningCommand(listener.pid).replaceAll('"', '') !== [installation.gui, ...args].join(' ')) throw new Error('The PhotoCraft process does not match the selected control file and project folders. No app command was sent.')
    versionOf(installation.gui)
    record = { gui: installation.gui, pid: listener.pid, guiSha256: listener.sha256, version: VERSION, tokenFile: input.tokenFile, ...roots }
  } else record = descriptor(dataDir, endpoint)
  if (record.gui !== installation.gui) throw new Error('The PhotoCraft window uses a different installation.')
  if (listener.pid !== record.pid || listener.sha256 !== record.guiSha256) throw new Error('The PhotoCraft control process changed. No app command was sent.')
  if ((input.readRoot && realpathSync(input.readRoot) !== record.readRoot) || (input.writeRoot && realpathSync(input.writeRoot) !== record.writeRoot) || (input.project && realpathSync(input.project) !== record.readRoot)) throw new Error('The selected PhotoCraft window has different project folders. No app command was sent.')
  const state = await inspectControl({ endpoint, tokenFile: record.tokenFile, signal })
  return { identity: 'photocraft', version: record.version, project: record.readRoot, readRoot: record.readRoot, writeRoot: record.writeRoot, document: state.document?.name ?? null, pid: record.pid }
}

export function otherPhotoCraftRunning() {
  try {
    if (process.platform === 'win32') return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "@(Get-CimInstance Win32_Process -Filter \"Name='photocraft.exe'\").Count"], { encoding: 'utf8', timeout: 10000 }).trim() !== '0'
    return execFileSync('pgrep', ['-i', '-x', 'photocraft'], { encoding: 'utf8', timeout: 10000 }).trim() !== ''
  } catch (error) {
    if (process.platform !== 'win32' && error.status === 1) return false
    throw new Error('Could not check for an existing PhotoCraft window. No new window was launched.')
  }
}

export async function launch({ installation, endpoint, dataDir, input, signal }) {
  endpointParts(endpoint); signal?.throwIfAborted()
  if (input.tokenFile && input.tokenFile !== tokenPath(dataDir)) throw new Error('Launch uses a new private control file. Use a selected token file only when attaching to its existing window.')
  if (otherPhotoCraftRunning()) throw new Error(`PhotoCraft is already running. Attach to its existing window. ${REMEDY}`)
  if (existsSync(descriptorPath(dataDir))) {
    let old
    try { old = JSON.parse(readFileSync(descriptorPath(dataDir), 'utf8')) } catch { throw new Error('PhotoCraft instance record is unreadable; no window was launched.') }
    try { process.kill(old.pid, 0); throw new Error('PhotoCraft is already running. Attach to its window instead.') }
    catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  const roots = scopedRoots(input)
  await new Promise((resolve, reject) => {
    const listener = createServer()
    listener.once('error', () => reject(new Error('The selected PhotoCraft port is already in use. No window was launched.')))
    listener.listen(endpointParts(endpoint), () => listener.close(resolve))
  })
  versionOf(installation.gui); versionOf(installation.cli)
  const tokenFile = prepareControl(dataDir)
  const args = ['--control', String(endpointParts(endpoint).port), '--control-token-file', tokenFile, '--automation-read-root', roots.readRoot, '--automation-write-root', roots.writeRoot]
  const temp = join(dataDir, 'tmp'), config = join(dataDir, 'photocraft-config')
  mkdirSync(temp, { recursive: true, mode: 0o700 }); mkdirSync(config, { recursive: true, mode: 0o700 })
  const env = { ...process.env, PHOTOCRAFT_CONFIG_DIR: config, TMPDIR: temp, TMP: temp, TEMP: temp }
  delete env.PHOTOCRAFT_CONTROL_TOKEN; delete env.PHOTOCRAFT_CONTROL_TOKEN_FILE; delete env.PHOTOCRAFT_CONTROL_PORT
  delete env.PHOTOCRAFT_AUTOMATION_READ_ROOT; delete env.PHOTOCRAFT_AUTOMATION_WRITE_ROOT
  const child = spawn(installation.gui, args, { cwd: roots.readRoot, env, detached: true, stdio: 'ignore', windowsHide: false })
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(new Error('PhotoCraft could not be launched.'))) })
  const record = { version: VERSION, endpoint, pid: child.pid, gui: installation.gui, guiSha256: sha(installation.gui), args, tokenFile, ...roots }
  const pending = descriptorPath(dataDir) + '.pending'
  writeFileSync(pending, JSON.stringify(record), { mode: 0o600 }); renameSync(pending, descriptorPath(dataDir))
  child.unref()
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    signal?.throwIfAborted()
    if (child.exitCode !== null) throw new Error('PhotoCraft exited before its control connection was ready.')
    try { await probe({ endpoint, dataDir, signal, installation, input }); return child }
    catch (error) {
      if (signal?.aborted) throw error
      if (Date.now() >= deadline) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  throw new Error('PhotoCraft opened but did not answer its control check. The window was left open; inspect it before attaching again.')
}

export function upstream({ installation, endpoint, dataDir, input }) {
  const temp = join(dataDir, 'tmp')
  mkdirSync(temp, { recursive: true, mode: 0o700 })
  const args = ['mcp']
  if (input.mode === 'headless') {
    const roots = scopedRoots(input)
    args.push('--automation-read-root', roots.readRoot, '--automation-write-root', roots.writeRoot)
  } else {
    endpointParts(endpoint)
    const tokenFile = input.tokenFile ?? tokenPath(dataDir)
    readPrivateToken(tokenFile)
    args.push('--bridge', endpoint, '--control-token-file', tokenFile)
  }
  return { command: installation.cli, args, env: { PHOTOCRAFT_CONFIG_DIR: join(dataDir, 'photocraft-config'), TMPDIR: temp, TMP: temp, TEMP: temp, PHOTOCRAFT_CONTROL_TOKEN: undefined, PHOTOCRAFT_CONTROL_TOKEN_FILE: undefined, PHOTOCRAFT_CONTROL_PORT: undefined } }
}

export const adapter = { id: 'photocraft', title: 'PhotoCraft', version: VERSION, pins: [desktopLock, cliLock], notices, guiBasename: process.platform === 'darwin' ? 'PhotoCraft' : 'photocraft', cliBasename: 'photocraft-cli', defaultPort: 7878, probe, launch, upstream }
