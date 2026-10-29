import { randomBytes, createHash } from 'node:crypto'
import { mkdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import nodeLock from '../../../vendor/node.lock.json' with { type: 'json' }
import { hostDirectory, hostRecords, readHostRecord, type HostRecord } from '../host/store.js'
import { hostRunner, openHostTunnel, sshArguments, type HostRunner } from '../host/ssh.js'
import { shQuote } from '../host/boxExecution.js'
import { hostMachineName, LLM_HOST_WORDS } from '../../commands/llmhost/words.js'
import { publishAtomicSync } from '../../substrate/fileStore.js'
import { mediaRoot, mediaServerPath, type MediaSettings, type MediaConfig } from './settings.js'
import { parseMediaCatalogue, type MediaCatalogue } from './catalogue.js'
import { mediaRows, mediaRuntimeChoice, MediaSetupPaused, type MediaSnapshot, type MediaProgress } from './setup.js'

const REMOTE_DIR = '/workspace/mercury-media'
const REMOTE_PORT = 30080
export type MediaHostState = { id: string; name: string; token: string; url?: string; port: number }
type RemoteSnapshot = { catalogue: unknown; config: MediaConfig; runtime: { installed: boolean; variant?: string }; files: { file: string; bytes: number; total: number; installed: boolean; checkpoint?: boolean }[]; totalMemoryBytes: number; usableMemoryBytes: number; freeBytes: number }
export function mediaHostStatePath(id: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) throw new Error(LLM_HOST_WORDS.manage)
  return join(hostDirectory(), 'media', id, 'connection.json')
}
export function mediaHostChoices(): HostRecord[] {
  return hostRecords().filter(record => record.target && !record.cluster && record.jobState === 'ready' && record.status === 'RUNNING')
}
export function requireMediaHost(id: string): HostRecord & { target: NonNullable<HostRecord['target']> } {
  const record = readHostRecord(id)
  if (!record || record.status === 'TERMINATED') throw new Error(LLM_HOST_WORDS.terminatedPod)
  if (record.status === 'EXITED' || record.jobState === 'stopped') throw new Error(LLM_HOST_WORDS.stoppedDisk)
  if (!record.target || record.cluster || record.status !== 'RUNNING' || record.jobState !== 'ready') throw new Error(LLM_HOST_WORDS.manage)
  return record as HostRecord & { target: NonNullable<HostRecord['target']> }
}
function readState(id: string): MediaHostState | undefined {
  const path = mediaHostStatePath(id)
  if (!existsSync(path)) return undefined
  const state = JSON.parse(readFileSync(path, 'utf8')) as MediaHostState
  if (state.id !== id || !/^[a-f0-9]{64}$/.test(state.token) || !Number.isInteger(state.port) || state.port < 1024 || state.port > 65535) throw new Error('Media setup returned an unreadable response.')
  return state
}
function saveState(state: MediaHostState): void {
  const path = mediaHostStatePath(state.id)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  publishAtomicSync(path, JSON.stringify(state) + '\n', { mode: 0o600 })
}
const headers = (state: MediaHostState): Record<string, string> => ({ authorization: 'Bearer ' + state.token })
const connecting = new Map<string, Promise<MediaHostState>>()
export async function connectMediaHost(id: string, signal: AbortSignal, runner: HostRunner = hostRunner): Promise<MediaHostState> {
  const record = requireMediaHost(id)
  const state = readState(id)
  if (!state) throw new Error('Media runtime missing · /imagesetup')
  if (state.url) {
    try { if ((await fetch(state.url + '/health', { headers: headers(state), redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]) })).ok) return state } catch {}
  }
  signal.throwIfAborted()
  let pending = connecting.get(id)
  if (!pending) {
    pending = (async () => {
      const port = await openHostTunnel('media-' + id, record.target, runner, signal, undefined, { port: state.port, path: '/health', headers: headers(state) })
      const next = { ...state, url: 'http://127.0.0.1:' + port }
      saveState(next)
      return next
    })().finally(() => { connecting.delete(id) })
    connecting.set(id, pending)
  }
  return pending
}
export function mediaHostInstallScript(bundle: string, token: string): string {
  const node = nodeLock.platforms['linux-x64']
  const root = REMOTE_DIR + '/data'
  const config = JSON.stringify({ root, port: REMOTE_PORT, token })
  const start = 'export MEDIA_ROOT=' + shQuote(root) + '\nexport PATH=' + shQuote(REMOTE_DIR + '/node/bin') + ':$PATH\nexec ' + shQuote(REMOTE_DIR + '/node/bin/node') + ' ' + shQuote(bundle + '/remote-server.js') + ' ' + shQuote(REMOTE_DIR + '/server.json')
  return 'set -eu\numask 077\ntest "$(uname -s)" = Linux\ntest "$(uname -m)" = x86_64\nmkdir -p ' + shQuote(REMOTE_DIR) + '\ncd ' + shQuote(REMOTE_DIR) + '\n'
    + 'if ! test -x node/bin/node; then curl -fL --retry 3 ' + shQuote(node.url) + ' -o node.tar.gz; printf "%s  %s\\n" ' + shQuote(node.sha256) + ' node.tar.gz | sha256sum -c -; mkdir -p node; tar -xzf node.tar.gz --strip-components=1 -C node; rm node.tar.gz; fi\n'
    + 'for bin in unzip ffmpeg setsid git cmake c++; do if ! command -v "$bin" >/dev/null; then test "$(id -u)" = 0; apt-get update; DEBIAN_FRONTEND=noninteractive apt-get install -y unzip ffmpeg util-linux git cmake build-essential; break; fi; done\n'
    + 'node/bin/node --input-type=module -e ' + shQuote('import {readFileSync} from "node:fs"; import {createHash} from "node:crypto"; const dir=process.argv[1]; const m=JSON.parse(readFileSync(dir+"/manifest.json")); for(const [file,hash] of Object.entries(m.files)) { if(!/^[a-zA-Z0-9._-]+$/.test(file)||createHash("sha256").update(readFileSync(dir+"/"+file)).digest("hex")!==hash) throw Error("digest mismatch"); }') + ' ' + shQuote(bundle) + '\n'
    + 'if test -s server.pid && kill -0 "$(cat server.pid)" 2>/dev/null; then exit 0; fi\nprintf %s ' + shQuote(config) + ' > server.json\nprintf %s ' + shQuote(start) + ' > server.sh\nnohup setsid sh server.sh > server.log 2>&1 < /dev/null & echo $! > server.pid\n'
}
export async function installMediaHost(settings: MediaSettings, signal: AbortSignal, runner: HostRunner = hostRunner): Promise<MediaHostState> {
  const record = requireMediaHost(settings.host!)
  const dir = dirname(await mediaServerPath(settings))
  const manifest = readFileSync(join(dir, 'manifest.json'))
  const files = (JSON.parse(manifest.toString()) as { files: Record<string, string> }).files
  if (!files['remote-server.js']) throw new Error('Media extension is missing. Reinstall Mercury.')
  for (const [file, hash] of Object.entries(files)) {
    if (!/^[a-zA-Z0-9._-]+$/.test(file) || createHash('sha256').update(readFileSync(join(dir, file))).digest('hex') !== hash) throw new Error('digest mismatch')
  }
  const bundle = REMOTE_DIR + '/bundles/' + createHash('sha256').update(manifest).digest('hex').slice(0, 24)
  const args = sshArguments(record.target)
  const state = readState(record.id) ?? { id: record.id, name: hostMachineName(record.vendor ?? 'runpod', record.id), token: randomBytes(32).toString('hex'), port: REMOTE_PORT }
  await runner.run('ssh', [...args, 'umask 077; mkdir -p ' + shQuote(bundle)], signal)
  const scp = args.slice(0, -1).flatMap((arg, index, all) => arg === '-l' || all[index - 1] === '-l' ? [] : [arg === '-p' ? '-P' : arg])
  await runner.run('scp', [...scp, ...Object.keys(files).map(file => join(dir, file)), join(dir, 'manifest.json'), (record.target.user ? record.target.user + '@' : '') + record.target.host + ':' + bundle + '/'], signal, 300000)
  await runner.run('ssh', [...args, mediaHostInstallScript(bundle, state.token)], signal, 600000)
  saveState(state)
  return connectMediaHost(record.id, signal, runner)
}
async function hostFetch(state: MediaHostState, path: string, signal: AbortSignal, init?: RequestInit): Promise<Response> {
  const response = await fetch(state.url + path, { ...init, headers: { ...headers(state), ...init?.headers }, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) })
  if (!response.ok) throw new Error(await response.text() || LLM_HOST_WORDS.manage)
  return response
}
export async function readMediaHostSnapshot(settings: MediaSettings, runner: HostRunner = hostRunner, signal = new AbortController().signal): Promise<MediaSnapshot> {
  const record = requireMediaHost(settings.host!)
  const root = mediaRoot(settings)
  let snapshot: RemoteSnapshot
  if (readState(record.id)) {
    const state = await connectMediaHost(record.id, signal, runner)
    snapshot = await (await hostFetch(state, '/snapshot', signal)).json() as RemoteSnapshot
  } else {
    const script = 'import json, os, shutil, subprocess\np="/workspace"\ngpu=subprocess.check_output(["nvidia-smi","--query-gpu=memory.free","--format=csv,noheader,nounits"],text=True)\nprint(json.dumps({"totalMemoryBytes":os.sysconf("SC_PAGE_SIZE")*os.sysconf("SC_PHYS_PAGES"),"usableMemoryBytes":max(float(v)*1024**2 for v in gpu.splitlines()),"freeBytes":shutil.disk_usage(p).free}))'
    const facts = JSON.parse(await runner.run('ssh', [...sshArguments(record.target), 'python3 -c ' + shQuote(script)], signal)) as Pick<RemoteSnapshot, 'totalMemoryBytes' | 'usableMemoryBytes' | 'freeBytes'>
    const catalogue = JSON.parse(readFileSync(join(dirname(await mediaServerPath(settings)), 'catalog.json'), 'utf8')) as MediaCatalogue
    snapshot = { ...facts, catalogue, config: {}, runtime: { installed: false }, files: [] }
  }
  const catalogue = parseMediaCatalogue(snapshot.catalogue)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  publishAtomicSync(join(root, 'catalog.json'), JSON.stringify(catalogue), { mode: 0o600 })
  const previous = existsSync(join(root, 'config.json')) ? JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')) as MediaConfig : {}
  const config = { ...previous, imageModel: snapshot.config.imageModel, videoModel: snapshot.config.videoModel }
  publishAtomicSync(join(root, 'config.json'), JSON.stringify(config), { mode: 0o600 })
  publishAtomicSync(join(root, 'host.json'), JSON.stringify({ installed: snapshot.runtime.installed, location: hostMachineName(record.vendor ?? 'runpod', record.id) }), { mode: 0o600 })
  const installed = new Map(snapshot.files.map(file => [file.file, file]))
  const variants = catalogue.runtime.platforms['linux-x64'] ?? []
  const selected = snapshot.runtime.installed ? variants.find(row => row.variant === snapshot.runtime.variant) : undefined
  const runtime = mediaRuntimeChoice(selected ? { ...catalogue, runtime: { ...catalogue.runtime, platforms: { 'linux-x64': [selected] } } } : catalogue, 'linux', 'x64', 'nvidia')
  return { root, location: hostMachineName(record.vendor ?? 'runpod', record.id), host: record.id, catalogue, config, runtime, runtimeInstalled: snapshot.runtime.installed, totalMemoryBytes: snapshot.totalMemoryBytes, usableMemoryBytes: snapshot.usableMemoryBytes, freeBytes: snapshot.freeBytes, rows: mediaRows(catalogue, root, snapshot, snapshot.freeBytes, (_root, file) => installed.get(file.path)?.installed === true, (_root, _data, model) => installed.get(`${model.control ? 'controlnet' : 'checkpoints'}/${model.id}.safetensors`)?.installed === true) }
}
export async function runMediaHostSetup(args: string[], progress: (event: MediaProgress) => void, signal = new AbortController().signal, settings: MediaSettings, runner: HostRunner = hostRunner): Promise<void> {
  const state = await installMediaHost(settings, signal, runner)
  const controller = new AbortController()
  const combined = AbortSignal.any([signal, controller.signal])
  let timer = setTimeout(() => controller.abort(), 30000)
  let done = false
  let error: string | undefined
  try {
    const response = await fetch(state.url + '/setup', { method: 'POST', headers: { ...headers(state), 'content-type': 'application/json' }, body: JSON.stringify(args), redirect: 'error', signal: combined })
    if (!response.ok || !response.body) throw new Error(await response.text() || LLM_HOST_WORDS.manage)
    let text = ''
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    while (true) {
      const next = await reader.read()
      if (next.done) break
      clearTimeout(timer)
      timer = setTimeout(() => controller.abort(), 30000)
      text += decoder.decode(next.value, { stream: true })
      let end: number
      while ((end = text.indexOf('\n')) >= 0) {
        const event = JSON.parse(text.slice(0, end)) as MediaProgress
        text = text.slice(end + 1)
        if (event.event === 'done') done = true
        if (event.event === 'error') error = event.message
        if (['done', 'progress', 'error', 'cancelled'].includes(event.event)) progress(event)
      }
    }
    if (error || !done) throw new Error(error ?? 'Media setup returned an unreadable response.')
  } catch (error) {
    if (signal.aborted) throw new MediaSetupPaused({ event: 'cancelled' })
    throw error
  } finally { clearTimeout(timer) }
}
export async function setMediaHostDefaults(settings: MediaSettings, patch: MediaConfig): Promise<void> {
  const signal = new AbortController().signal
  const state = await connectMediaHost(settings.host!, signal)
  await hostFetch(state, '/config', signal, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
}

export async function refreshMediaHostActivity(id: string): Promise<void> {
  if (!readState(id)) return
  const signal = AbortSignal.timeout(30000)
  const state = await connectMediaHost(id, signal)
  const value = await (await hostFetch(state, '/activity', signal)).json() as { at: number; now: number }
  if (!Number.isFinite(value.at) || !Number.isFinite(value.now)) throw new Error('Media setup returned an unreadable response.')
  if (value.at > 0) publishAtomicSync(join(dirname(mediaHostStatePath(id)), 'activity.json'), JSON.stringify({ at: Date.now() - Math.max(0, value.now - value.at) }), { mode: 0o600 })
}

export async function readMediaHostDefaults(settings: MediaSettings): Promise<Pick<MediaConfig, 'imageModel' | 'videoModel'>> {
  const signal = AbortSignal.timeout(30000)
  const state = await connectMediaHost(settings.host!, signal)
  const value = await (await hostFetch(state, '/config', signal)).json() as { imageModel?: unknown; videoModel?: unknown }
  if (typeof value.imageModel !== 'string' || typeof value.videoModel !== 'string') throw new Error('Media setup returned an unreadable response.')
  return { imageModel: value.imageModel, videoModel: value.videoModel }
}
