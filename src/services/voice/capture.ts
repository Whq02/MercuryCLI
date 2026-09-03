// ============================================================================
//  services/voice/capture — the ONE microphone capture owner.
//
//  One road in: startCapture() opens a capture on the default input and
//  answers a handle; stop() closes it and hands back the whole take as a
//  16 kHz mono 16-bit WAV held in memory — never on disk, unless the debug
//  directory (MERCURY_VOICE_DEBUG_WAV_DIR) asks for a copy. cancel() drops
//  the take. Every capture is BOUNDED: at CAPTURE_BOUND_MS the owner stops
//  it by itself and says so (MERCURY_VOICE_BOUND_MS shortens the bound for
//  a proof, never lengthens it).
//
//  Backends, in ladder order (MERCURY_VOICE_BACKEND pins one):
//    vendored  the voice pack (native/voice — a Node-API addon over the
//              platform's own audio layer), loaded through voicePack.ts;
//    sox · arecord · ffmpeg  recorders already on PATH — never vendored;
//              each is asked for raw s16le 16 kHz mono on stdout;
//    fixture   a canned WAV (MERCURY_VOICE_FIXTURE_WAV) — the provers'
//              hermetic microphone.
//  No backend ⇒ the honest receipt (NO_BACKEND_RECEIPT); the doctor row
//  names the same resolution.
// ============================================================================
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { loadVoiceAddon, resolveVoicePackDir, VOICE_ADDON_FILE } from './voicePack.js'
import { encodeWav, pcmDurationMs, pcmIsSilent, pcmSamples, readWav, VOICE_SAMPLE_RATE } from './wav.js'

/** Five minutes: the longest single take the composer accepts. */
export const CAPTURE_BOUND_MS = 5 * 60_000

/** The bound a capture opens with: CAPTURE_BOUND_MS, unless the proof seam
 *  MERCURY_VOICE_BOUND_MS names a shorter one (a whole number of
 *  milliseconds, at most the product bound — anything else is ignored). */
export function captureBoundMs(): number {
  const raw = (flagEnv('MERCURY_VOICE_BOUND_MS') ?? '').trim()
  if (!/^\d+$/.test(raw)) return CAPTURE_BOUND_MS
  const ms = Number(raw)
  return ms > 0 && ms <= CAPTURE_BOUND_MS ? ms : CAPTURE_BOUND_MS
}

export const NO_BACKEND_RECEIPT =
  'no microphone backend — the voice pack is absent on this install; run `bun run setup` (needs cargo) or put sox/ffmpeg on PATH'

export type CaptureBackendKind = 'vendored' | 'sox' | 'arecord' | 'ffmpeg' | 'fixture'

export const CAPTURE_BACKEND_KINDS: readonly CaptureBackendKind[] = ['vendored', 'sox', 'arecord', 'ffmpeg', 'fixture']

export type CaptureBackendResolution =
  | { state: 'ok'; kind: CaptureBackendKind; detail: string; pinned: boolean }
  | { state: 'none'; note: string; tried: string[] }

/** A PATH lookup by name, no spawn (win32 adds the executable suffixes). */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const dirs = (env.PATH ?? '').split(delimiter).filter(d => d !== '')
  const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = join(dir, name + suffix)
      try {
        if (statSync(candidate).isFile()) return candidate
      } catch {
        /* not here */
      }
    }
  }
  return null
}

/** The fixture WAV the registry row names (a proof seam; process env only). */
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

/**
 * Which backend a capture would use right now, or why none can — the
 * doctor row and the receipts read this same answer. MERCURY_VOICE_BACKEND
 * pins one backend: a pinned backend that cannot serve names itself, never
 * a silent fallback.
 */
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
  return { state: 'none', note: `${NO_BACKEND_RECEIPT} (${notes.join('; ')})`, tried }
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
  /** The whole take, 16 kHz mono 16-bit WAV. */
  wav: Buffer
  durationMs: number
  /** No sample rose above the silence floor. */
  silent: boolean
  /** The owner stopped the take at the bound. */
  autoStopped: boolean
  backend: CaptureBackendKind
}

export interface CaptureHandle {
  readonly backend: CaptureBackendKind
  readonly startedAt: number
  /** Close the capture and answer the take. Idempotent: a second call
   *  answers the same result. */
  stop(): Promise<CaptureResult>
  /** Drop the take: no bytes are kept, nothing is answered. */
  cancel(): void
  readonly settled: boolean
}

export interface StartCaptureOptions {
  env?: NodeJS.ProcessEnv
  /** The resolved backend (default: resolveCaptureBackend(env)). */
  backend?: CaptureBackendResolution
  /** The bound (default CAPTURE_BOUND_MS); the owner stops the take there. */
  boundMs?: number
  /** Called once when the bound stops the take — the caller then stop()s. */
  onAutoStop?: () => void
  now?: () => number
}

/** The raw-sample source each backend implements. */
interface RawCapture {
  /** Close the source; answer every s16le 16 kHz mono byte it produced. */
  stop(): Promise<Buffer>
  cancel(): void
}

/** The macOS permission words: the OS attributes the microphone prompt to
 *  the terminal app, and a denial answers a live stream of silence. */
export function microphonePermissionHint(platform: string = process.platform): string {
  if (platform === 'darwin') {
    return 'if macOS never asked, allow your terminal under System Settings → Privacy & Security → Microphone'
  }
  if (platform === 'win32') {
    return 'if Windows never asked, allow desktop apps under Settings → Privacy & security → Microphone'
  }
  return 'check the operating system microphone permission for your terminal'
}

// ── the vendored addon ─────────────────────────────────────────────────────

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
        /* a cancelled take owes nothing */
      }
    },
  }
}

// ── the fixture ────────────────────────────────────────────────────────────

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

// ── PATH recorders (raw s16le 16 kHz mono on stdout) ───────────────────────

/** The first dshow audio device ffmpeg lists (Windows has no "default"
 *  alias on that input). */
function firstDshowAudioDevice(ffmpeg: string, env: NodeJS.ProcessEnv): string | null {
  const probe = spawnSync(ffmpeg, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { encoding: 'utf8', env, timeout: 10_000, windowsHide: true })
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
      // -d: the default audio device; raw signed 16-bit 16 kHz mono to stdout.
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
    child = spawn(exe, recorderArgv(kind, exe, env), { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
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
    // ffmpeg reads a 'q' on stdin; the recorders end their stream on
    // SIGINT; anything still alive after the grace is killed.
    try {
      child.stdin?.write('q\n')
      child.stdin?.end()
    } catch {
      /* stdin already gone */
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

// ── the capture ────────────────────────────────────────────────────────────

/** The debug directory that receives a copy of every finished take — the
 *  ONLY road a take has to disk; null (the default) means none. The doctor
 *  row reads this to say so honestly. */
export function voiceDebugWavDir(): string | null {
  const dir = (flagEnv('MERCURY_VOICE_DEBUG_WAV_DIR') ?? '').trim()
  return dir === '' ? null : dir
}

/**
 * Open a capture on the resolved backend. Throws a CaptureError with the
 * operator's words when no backend serves or the microphone cannot be
 * opened. The take stays in memory; the bound closes it.
 */
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
            /* the debug copy is best-effort; the take itself is in memory */
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

/** The vendored addon's own facts for the doctor (devices, pack) — never
 *  opens a capture. */
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
