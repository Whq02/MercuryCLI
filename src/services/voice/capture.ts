import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { loadVoiceAddon, resolveVoicePackDir, VOICE_ADDON_FILE, voiceCheckoutRoot } from './voicePack.js'
import { encodeWav, pcmDurationMs, pcmIsSilent, pcmSamples, readWav, VOICE_SAMPLE_RATE } from './wav.js'

export const CAPTURE_BOUND_MS = 5 * 60_000

export function captureBoundMs(): number {
  const raw = (flagEnv('MERCURY_VOICE_BOUND_MS') ?? '').trim()
  if (!/^\d+$/.test(raw)) return CAPTURE_BOUND_MS
  const ms = Number(raw)
  return ms > 0 && ms <= CAPTURE_BOUND_MS ? ms : CAPTURE_BOUND_MS
}

export const NO_BACKEND_RECEIPT =
  'no microphone backend — the voice pack is absent on this install; run `bun run setup` (needs cargo) or put sox/ffmpeg on PATH'

export function recorderInstallHint(platform: string = process.platform): string {
  if (platform === 'darwin') return 'brew install ffmpeg'
  if (platform === 'win32') return 'winget install ffmpeg'
  return 'apt install ffmpeg, or your package manager'
}

export const NO_BACKEND_RECEIPT_RELEASE =
  'no microphone backend — this install carries no voice pack; put ffmpeg or sox on PATH'

export function noBackendReceipt(checkoutRoot: string | null = voiceCheckoutRoot(), platform: string = process.platform): string {
  return checkoutRoot !== null ? NO_BACKEND_RECEIPT : `${NO_BACKEND_RECEIPT_RELEASE} (${recorderInstallHint(platform)})`
}

export type CaptureBackendKind = 'vendored' | 'sox' | 'arecord' | 'ffmpeg' | 'fixture'

export const CAPTURE_BACKEND_KINDS: readonly CaptureBackendKind[] = ['vendored', 'sox', 'arecord', 'ffmpeg', 'fixture']

export type CaptureBackendResolution =
  | { state: 'ok'; kind: CaptureBackendKind; detail: string; pinned: boolean }
  | { state: 'none'; note: string; tried: string[] }

export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const dirs = (env.PATH ?? '').split(delimiter).filter(d => d !== '')
  const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = join(dir, name + suffix)
      try {
        if (statSync(candidate).isFile()) return candidate
      } catch {
      }
    }
  }
  return null
}

function fixtureWavPath(): string {
  return (flagEnv('MERCURY_VOICE_FIXTURE_WAV') ?? '').trim()
}

function fixtureResolution(): CaptureBackendResolution {
  const wav = fixtureWavPath()
  if (wav === '') {
    return { state: 'none', note: 'MERCURY_VOICE_BACKEND=fixture needs MERCURY_VOICE_FIXTURE_WAV=<path to a WAV>', tried: ['fixture'] }
  }
  if (!existsSync(wav)) return { state: 'none', note: `MERCURY_VOICE_FIXTURE_WAV names ${wav}, which is absent`, tried: ['fixture'] }
  return { state: 'ok', kind: 'fixture', detail: `fixture WAV ${wav}`, pinned: true }
}

function vendoredResolution(): CaptureBackendResolution {
  const pack = resolveVoicePackDir()
  if (pack.state === 'ok') {
    return { state: 'ok', kind: 'vendored', detail: `vendored pack ${pack.manifest.version} ${pack.manifest.platform} (${pack.source === 'workspace' ? 'the checkout' : pack.source === 'override' ? 'MERCURY_VOICE_PACK_DIR' : 'beside the bundle'})`, pinned: false }
  }
  return { state: 'none', note: pack.note, tried: ['vendored'] }
}

function pathToolResolution(kind: 'sox' | 'arecord' | 'ffmpeg', env: NodeJS.ProcessEnv): CaptureBackendResolution {
  if (kind === 'arecord' && process.platform !== 'linux') {
    return { state: 'none', note: 'arecord captures through ALSA — Linux only', tried: [kind] }
  }
  const found = findOnPath(kind, env)
  if (found === null) return { state: 'none', note: `${kind} is not on PATH`, tried: [kind] }
  return { state: 'ok', kind, detail: `${kind} on PATH (${found})`, pinned: false }
}

export function resolveCaptureBackend(env: NodeJS.ProcessEnv = process.env): CaptureBackendResolution {
  const pin = (flagEnv('MERCURY_VOICE_BACKEND') ?? '').trim().toLowerCase()
  if (pin !== '') {
    if (!(CAPTURE_BACKEND_KINDS as readonly string[]).includes(pin)) {
      return { state: 'none', note: `MERCURY_VOICE_BACKEND=${pin} is not one of ${CAPTURE_BACKEND_KINDS.join(' · ')}`, tried: [pin] }
    }
    const kind = pin as CaptureBackendKind
    const resolved = kind === 'fixture' ? fixtureResolution() : kind === 'vendored' ? vendoredResolution() : pathToolResolution(kind, env)
    if (resolved.state === 'ok') return { ...resolved, pinned: true }
    return { state: 'none', note: `MERCURY_VOICE_BACKEND=${kind} — ${resolved.note}`, tried: [kind] }
  }
  const tried: string[] = []
  const notes: string[] = []
  for (const kind of ['vendored', 'sox', 'arecord', 'ffmpeg'] as const) {
    const resolved = kind === 'vendored' ? vendoredResolution() : pathToolResolution(kind, env)
    if (resolved.state === 'ok') return resolved
    tried.push(kind)
    notes.push(`${kind}: ${resolved.note}`)
  }
  return { state: 'none', note: `${noBackendReceipt()} (${notes.join('; ')})`, tried }
}

export class CaptureError extends Error {
  readonly kind: CaptureBackendKind | 'none'
  constructor(kind: CaptureBackendKind | 'none', message: string) {
    super(message)
    this.name = 'CaptureError'
    this.kind = kind
  }
}

export interface CaptureResult {
  wav: Buffer
  durationMs: number
  silent: boolean
  autoStopped: boolean
  backend: CaptureBackendKind
}

export interface CaptureHandle {
  readonly backend: CaptureBackendKind
  readonly startedAt: number
  stop(): Promise<CaptureResult>
  cancel(): void
  readonly settled: boolean
}

export interface StartCaptureOptions {
  env?: NodeJS.ProcessEnv
  backend?: CaptureBackendResolution
  boundMs?: number
  onAutoStop?: () => void
  now?: () => number
}

interface RawCapture {
  stop(): Promise<Buffer>
  cancel(): void
}

export function microphonePermissionHint(platform: string = process.platform): string {
  if (platform === 'darwin') {
    return 'if macOS never asked, allow your terminal under System Settings → Privacy & Security → Microphone'
  }
  if (platform === 'win32') {
    return 'if Windows never asked, allow desktop apps under Settings → Privacy & security → Microphone'
  }
  return 'check the operating system microphone permission for your terminal'
}


function startVendored(): RawCapture {
  const load = loadVoiceAddon()
  if (load.state === 'unavailable') throw new CaptureError('vendored', load.note)
  let handle: number
  try {
    handle = load.addon.startCapture()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new CaptureError('vendored', `the microphone could not be opened (${reason}) — ${microphonePermissionHint()}`)
  }
  let done = false
  return {
    stop: async () => {
      if (done) return Buffer.alloc(0)
      done = true
      return Buffer.from(load.addon.stopCapture(handle))
    },
    cancel: () => {
      if (done) return
      done = true
      try {
        load.addon.cancelCapture(handle)
      } catch {
      }
    },
  }
}


function startFixture(): RawCapture {
  const path = fixtureWavPath()
  return {
    stop: async () => {
      let bytes: Buffer
      try {
        bytes = readFileSync(path)
      } catch (error) {
        throw new CaptureError('fixture', `the fixture WAV ${path} could not be read: ${error instanceof Error ? error.message : String(error)}`)
      }
      const wav = readWav(bytes)
      if (!wav.ok) throw new CaptureError('fixture', `the fixture WAV ${path} is not PCM WAV: ${wav.reason}`)
      if (wav.header.sampleRate !== VOICE_SAMPLE_RATE || wav.header.channels !== 1 || wav.header.bitsPerSample !== 16) {
        throw new CaptureError('fixture', `the fixture WAV ${path} is ${wav.header.sampleRate} Hz · ${wav.header.channels} ch · ${wav.header.bitsPerSample}-bit; the capture shape is 16000 Hz · 1 ch · 16-bit`)
      }
      return Buffer.from(wav.pcm)
    },
    cancel: () => {},
  }
}


function firstDshowAudioDevice(ffmpeg: string, env: NodeJS.ProcessEnv): string | null {
  const probe = spawnSync(ffmpeg, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { encoding: 'utf8', env, timeout: 10_000 })
  const text = `${probe.stdout ?? ''}\n${probe.stderr ?? ''}`
  for (const line of text.split('\n')) {
    const m = /"([^"]+)"\s*\((audio)\)/.exec(line)
    if (m) return m[1] as string
  }
  return null
}

function recorderArgv(kind: 'sox' | 'arecord' | 'ffmpeg', exe: string, env: NodeJS.ProcessEnv): string[] {
  switch (kind) {
    case 'sox':
      return ['-q', '-d', '-t', 'raw', '-r', String(VOICE_SAMPLE_RATE), '-c', '1', '-b', '16', '-e', 'signed-integer', '-']
    case 'arecord':
      return ['-q', '-f', 'S16_LE', '-r', String(VOICE_SAMPLE_RATE), '-c', '1', '-t', 'raw', '-']
    case 'ffmpeg': {
      const input =
        process.platform === 'darwin'
          ? ['-f', 'avfoundation', '-i', ':0']
          : process.platform === 'win32'
            ? ['-f', 'dshow', '-i', `audio=${firstDshowAudioDevice(exe, env) ?? 'default'}`]
            : ['-f', 'alsa', '-i', 'default']
      return ['-hide_banner', '-loglevel', 'error', '-nostats', ...input, '-ar', String(VOICE_SAMPLE_RATE), '-ac', '1', '-f', 's16le', '-']
    }
  }
}

function startPathRecorder(kind: 'sox' | 'arecord' | 'ffmpeg', env: NodeJS.ProcessEnv): RawCapture {
  const exe = findOnPath(kind, env)
  if (exe === null) throw new CaptureError(kind, `${kind} left PATH between the resolution and the capture`)
  const chunks: Buffer[] = []
  let stderr = ''
  let child: ChildProcess
  try {
    child = spawn(exe, recorderArgv(kind, exe, env), { env, stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (error) {
    throw new CaptureError(kind, `${kind} could not be started: ${error instanceof Error ? error.message : String(error)}`)
  }
  child.stdout?.on('data', (chunk: Buffer) => {
    chunks.push(chunk)
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-2000)
  })
  let spawnError: Error | null = null
  child.on('error', error => {
    spawnError = error
  })
  const exited = new Promise<number | null>(resolve => {
    child.on('close', code => resolve(code))
  })
  const end = async (): Promise<void> => {
    if (child.exitCode !== null) return
    try {
      child.stdin?.write('q\n')
      child.stdin?.end()
    } catch {
    }
    if (process.platform !== 'win32') child.kill('SIGINT')
    const grace = new Promise<void>(resolve => setTimeout(resolve, 3_000))
    await Promise.race([exited, grace])
    if (child.exitCode === null) child.kill('SIGKILL')
    await exited
  }
  let done = false
  return {
    stop: async () => {
      if (done) return Buffer.alloc(0)
      done = true
      await end()
      if (spawnError !== null) throw new CaptureError(kind, `${kind} failed: ${(spawnError as Error).message}`)
      const bytes = Buffer.concat(chunks)
      if (bytes.length === 0) {
        throw new CaptureError(kind, `${kind} produced no audio${stderr.trim() !== '' ? ` (${stderr.trim().split('\n').slice(-1)[0]})` : ''} — ${microphonePermissionHint()}`)
      }
      return bytes
    },
    cancel: () => {
      if (done) return
      done = true
      void end()
    },
  }
}


export function voiceDebugWavDir(): string | null {
  const dir = (flagEnv('MERCURY_VOICE_DEBUG_WAV_DIR') ?? '').trim()
  return dir === '' ? null : dir
}

export async function startCapture(opts: StartCaptureOptions = {}): Promise<CaptureHandle> {
  const env = opts.env ?? process.env
  const backend = opts.backend ?? resolveCaptureBackend(env)
  if (backend.state === 'none') throw new CaptureError('none', backend.note)
  const now = opts.now ?? Date.now
  const raw: RawCapture =
    backend.kind === 'vendored' ? startVendored() : backend.kind === 'fixture' ? startFixture() : startPathRecorder(backend.kind, env)
  const startedAt = now()
  let settled = false
  let cancelled = false
  let autoStopped = false
  let result: Promise<CaptureResult> | null = null
  const boundMs = opts.boundMs ?? captureBoundMs()
  const bound = setTimeout(() => {
    if (settled) return
    autoStopped = true
    opts.onAutoStop?.()
  }, boundMs)
  bound.unref?.()
  const handle: CaptureHandle = {
    backend: backend.kind,
    startedAt,
    get settled() {
      return settled
    },
    stop: () => {
      if (result !== null) return result
      if (cancelled) return Promise.reject(new CaptureError(backend.kind, 'the take was cancelled — nothing to stop'))
      settled = true
      clearTimeout(bound)
      result = (async (): Promise<CaptureResult> => {
        const pcm = await raw.stop()
        const wav = encodeWav(pcm)
        const dump = voiceDebugWavDir()
        if (dump !== null) {
          try {
            mkdirSync(dump, { recursive: true })
            writeFileSync(join(dump, `capture-${startedAt}.wav`), wav)
          } catch {
          }
        }
        return {
          wav,
          durationMs: pcmDurationMs(pcm),
          silent: pcmIsSilent(pcmSamples(pcm)),
          autoStopped,
          backend: backend.kind,
        }
      })()
      return result
    },
    cancel: () => {
      if (settled) return
      settled = true
      cancelled = true
      clearTimeout(bound)
      raw.cancel()
    },
  }
  return handle
}

export function describeVendoredPack(): { state: 'ok'; version: string; platform: string; devices: string[]; defaultDevice: string | null; dir: string } | { state: 'unavailable'; note: string } {
  const load = loadVoiceAddon()
  if (load.state === 'unavailable') return load
  let devices: string[] = []
  let defaultDevice: string | null = null
  try {
    devices = load.addon.listInputDevices()
    defaultDevice = load.addon.defaultInputDevice()
  } catch (error) {
    return { state: 'unavailable', note: `the voice addon loaded but could not enumerate input devices: ${error instanceof Error ? error.message : String(error)}` }
  }
  return { state: 'ok', version: load.manifest.version, platform: load.manifest.platform, devices, defaultDevice, dir: load.dir }
}

export { VOICE_ADDON_FILE }
