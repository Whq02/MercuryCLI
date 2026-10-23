import { readFileSync } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { controlSession, loopbackEndpoint, verifyListener } from '../shared/control.mjs'

const exec = promisify(execFile)
const load = name => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'))
const pins = [load('./filmcraft.lock.json'), load('./filmcraft-cli.lock.json')]

async function probe({ endpoint, installation, signal, input = {} }) {
  let processIdentity
  try { processIdentity = await verifyListener(endpoint, installation.gui, { signal, expectedSha256: installation.manifest.guiSha256 }) }
  catch (error) {
    if (error.code === 1) throw new Error(`FilmCraft is not listening at ${endpoint}. If it is open, save your work before restarting it with control enabled. The open window was not changed.`)
    throw error
  }
  const control = controlSession(endpoint, { signal })
  try {
    const document = await control.request('engine.execute', { command: 'project.inspect', params: {} })
    const project = document.path ?? document.project?.path ?? document.name ?? document.project?.name
    if (typeof project !== 'string' || !project) throw new Error('FilmCraft did not identify its current project')
    if (input.project && project !== input.project && project !== resolve(input.project)) throw new Error(`FilmCraft has a different project open: ${project}`)
    return { identity: 'filmcraft', version: pins[0].version, project, process: processIdentity }
  } finally { control.close() }
}

async function launch({ endpoint, installation, dataDir, signal, input }) {
  const { port } = loopbackEndpoint(endpoint)
  if (process.platform === 'win32') {
    const running = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "@(Get-Process -Name filmcraft -ErrorAction SilentlyContinue).Count"], { signal })
    if (Number(running.stdout.trim()) > 0) throw new Error('FilmCraft is already open. Attach with control enabled; save your work before restarting it.')
  } else {
    try { await exec('pgrep', ['-x', process.platform === 'darwin' ? 'FilmCraft' : 'filmcraft'], { signal }); throw new Error('FilmCraft is already open. Attach with control enabled; save your work before restarting it.') }
    catch (e) { if (e.code !== 1) throw e }
  }
  const appData = join(dataDir, 'app-data'), temp = join(dataDir, 'tmp')
  await mkdir(appData, { recursive: true, mode: 0o700 }); await mkdir(temp, { recursive: true, mode: 0o700 })
  const log = await open(join(dataDir, 'filmcraft.log'), 'a', 0o600)
  const args = ['--control', String(port), '--data-dir', appData, ...(input.project ? [input.project] : ['--empty'])]
  const child = spawn(installation.gui, args, { detached: true, stdio: ['ignore', log.fd, log.fd], env: { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp } })
  await log.close()
  let spawnError
  child.on('error', error => { spawnError = error })
  child.unref()
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    signal?.throwIfAborted()
    if (spawnError) throw spawnError
    if (child.exitCode !== null) throw new Error(`FilmCraft exited with code ${child.exitCode}`)
    try { await verifyListener(endpoint, installation.gui, { signal, expectedSha256: installation.manifest.guiSha256 }); return child } catch {}
    await delay(200, undefined, { signal })
  }
  throw new Error('FilmCraft did not become ready. It was left open; check the window before trying again.')
}

export const adapter = {
  id: 'filmcraft', title: 'FilmCraft', version: '0.12.0', pins, notices: load('./notices.json'),
  guiBasename: process.platform === 'darwin' ? 'FilmCraft' : 'filmcraft', cliBasename: 'filmcraft-cli', defaultPort: 9876,
  probe, launch,
  async verify(context) {
    const current = await probe(context)
    if (current.process.pid !== context.attached.process.pid || current.process.start !== context.attached.process.start) throw new Error('The FilmCraft process changed. Reconnect before editing.')
    return current
  },
  upstream({ installation, endpoint, input, dataDir }) {
    return { command: installation.cli, args: ['mcp', ...(input.mode === 'headless' ? (input.project ? ['--project', input.project] : []) : ['--bridge', endpoint])], env: { FILMCRAFT_DATA_DIR: join(dataDir, 'app-data') } }
  },
}
