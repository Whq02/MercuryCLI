import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { spawn, execFile, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { promisify } from 'node:util'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { controlSession, loopbackEndpoint, verifyListener } from '../shared/control.mjs'
import { powershellEnvironment } from '../shared/powershell.mjs'

const exec = promisify(execFile)
const load = name => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'))
const pins = [load('./filmcraft.lock.json'), load('./filmcraft-cli.lock.json')]
const VERSION = '0.17.1'
const NO_TOKEN = 'FilmCraft answers only control requests that carry the FILMCRAFT_CONTROL_TOKEN it was started with. Launch it with craft_connect mode "launch", or attach with tokenFile naming a private file that holds the token of the open window.'
export const tokenPath = dataDir => join(dataDir, 'filmcraft-control', 'control.token')

function windowsPrivate(path, create) {
  const script = create
    ? '$p=$env:FILMCRAFT_PRIVATE_PATH;$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false);$rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,"FullControl","ContainerInherit,ObjectInherit","None","Allow");$acl.AddAccessRule($rule);Set-Acl -LiteralPath $p -AclObject $acl'
    : '$p=$env:FILMCRAFT_PRIVATE_PATH;$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$acl=Get-Acl -LiteralPath $p;if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid){throw "Control file has another owner"};foreach($r in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($r.AccessControlType -eq "Allow" -and $r.IdentityReference.Value -ne $sid){throw "Control file grants another identity access"}}'
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop';${script}`], { env: { ...powershellEnvironment(), FILMCRAFT_PRIVATE_PATH: path }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 })
}

export function readPrivateToken(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || /[\r\n\0]/.test(path)) throw new Error('FilmCraft needs an absolute private token-file path.')
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('FilmCraft control token must be a private regular file.')
  if (process.platform === 'win32') windowsPrivate(path, false)
  else if ((info.mode & 0o077) !== 0 || info.uid !== process.getuid()) throw new Error('FilmCraft control token must be readable only by the current user.')
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fstatSync(fd)
    if (opened.dev !== info.dev || opened.ino !== info.ino || opened.size > 256) throw new Error('FilmCraft control token file changed.')
    const token = readFileSync(fd, 'utf8').trim()
    if (!/^[a-fA-F0-9]{64}$/.test(token)) throw new Error('FilmCraft control token file must hold 64 hex characters.')
    return token
  } finally { closeSync(fd) }
}

function sessionToken(dataDir, input) {
  if (input.tokenFile) return readPrivateToken(input.tokenFile)
  if (!existsSync(tokenPath(dataDir))) throw new Error(NO_TOKEN)
  return readPrivateToken(tokenPath(dataDir))
}

function newToken(dataDir) {
  const path = tokenPath(dataDir), folder = dirname(path), pending = `${path}.pending`
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  const info = lstatSync(folder)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('FilmCraft control folder must be a private directory, not a link.')
  if (process.platform === 'win32') windowsPrivate(folder, true)
  else if ((info.mode & 0o077) !== 0 || info.uid !== process.getuid()) throw new Error('FilmCraft control folder must be private to the current user.')
  const token = randomBytes(32).toString('hex')
  rmSync(pending, { force: true })
  writeFileSync(pending, `${token}\n`, { flag: 'wx', mode: 0o600 })
  renameSync(pending, path)
  return token
}

async function probe({ endpoint, installation, dataDir, signal, input = {} }) {
  let processIdentity
  try { processIdentity = await verifyListener(endpoint, installation.gui, { signal, expectedSha256: installation.manifest.guiSha256 }) }
  catch (error) {
    if (error.code === 1) throw new Error(`FilmCraft is not listening at ${endpoint}. If it is open, save your work before restarting it with control enabled and FILMCRAFT_CONTROL_TOKEN set. The open window was not changed.`)
    throw error
  }
  const control = controlSession(endpoint, { signal, token: sessionToken(dataDir, input) })
  try {
    const document = await control.request('engine.execute', { command: 'project.inspect', params: {} })
    const project = document.path ?? document.project?.path ?? document.name ?? document.project?.name
    if (typeof project !== 'string' || !project) throw new Error('FilmCraft did not identify its current project')
    if (input.project && project !== input.project && project !== resolve(input.project)) throw new Error(`FilmCraft has a different project open: ${project}`)
    return { identity: 'filmcraft', version: VERSION, project, process: processIdentity }
  } finally { control.close() }
}

async function launch({ endpoint, installation, dataDir, signal, input }) {
  const { port } = loopbackEndpoint(endpoint)
  if (input.tokenFile) throw new Error('Launch creates a fresh session token. Use tokenFile only when attaching to a window started by hand.')
  if (process.platform === 'win32') {
    const running = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "@(Get-Process -Name filmcraft -ErrorAction SilentlyContinue).Count"], { signal })
    if (Number(running.stdout.trim()) > 0) throw new Error('FilmCraft is already open. Attach with control enabled; save your work before restarting it.')
  } else {
    try { await exec('pgrep', ['-x', process.platform === 'darwin' ? 'FilmCraft' : 'filmcraft'], { signal }); throw new Error('FilmCraft is already open. Attach with control enabled; save your work before restarting it.') }
    catch (e) { if (e.code !== 1) throw e }
  }
  const appData = join(dataDir, 'app-data'), temp = join(dataDir, 'tmp')
  await mkdir(appData, { recursive: true, mode: 0o700 }); await mkdir(temp, { recursive: true, mode: 0o700 })
  const token = newToken(dataDir)
  const log = await open(join(dataDir, 'filmcraft.log'), 'a', 0o600)
  const args = ['--control', String(port), '--data-dir', appData, ...(input.project ? [input.project] : ['--empty'])]
  const child = spawn(installation.gui, args, { detached: true, stdio: ['ignore', log.fd, log.fd], env: { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp, FILMCRAFT_CONTROL_TOKEN: token, FILMCRAFT_CONTROL_PORT: undefined } })
  await log.close()
  let spawnError, last
  child.on('error', error => { spawnError = error })
  child.unref()
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    signal?.throwIfAborted()
    if (spawnError) throw spawnError
    if (child.exitCode !== null) throw new Error(`FilmCraft exited with code ${child.exitCode}`)
    try { await probe({ endpoint, installation, dataDir, signal, input }); return child }
    catch (error) { if (signal?.aborted) throw error; last = error }
    await delay(200, undefined, { signal })
  }
  throw new Error(`FilmCraft did not become ready (${last?.message ?? 'no control listener'}). It was left open; check the window before trying again.`)
}

export const adapter = {
  id: 'filmcraft', title: 'FilmCraft', version: VERSION, pins, notices: load('./notices.json'),
  guiBasename: process.platform === 'darwin' ? 'FilmCraft' : 'filmcraft', cliBasename: 'filmcraft-cli', defaultPort: 9876,
  probe, launch,
  async verify(context) {
    const current = await probe(context)
    if (current.process.pid !== context.attached.process.pid || current.process.start !== context.attached.process.start) throw new Error('The FilmCraft process changed. Reconnect before editing.')
    return current
  },
  upstream({ installation, endpoint, input, dataDir }) {
    const headless = input.mode === 'headless'
    return { command: installation.cli, args: ['mcp', ...(headless ? (input.project ? ['--project', input.project] : []) : ['--bridge', endpoint])], env: { FILMCRAFT_DATA_DIR: join(dataDir, 'app-data'), FILMCRAFT_CONTROL_TOKEN: headless ? undefined : sessionToken(dataDir, input) } }
  },
}
