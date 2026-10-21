import * as pendingInput from '../../input-core/pending-input.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { captureBoundMs, microphonePermissionHint, resolveCaptureBackend, startCapture, voiceDebugWavDir, type CaptureBackendKind, type CaptureBackendResolution, type CaptureHandle } from './capture.js'
import type { CaptureStreamErrors } from './voicePack.js'
import { localDecodesInFlight, resolveTranscriber, transcribeWav, warmLocalTranscriber, type TranscriberResolution } from './transcribe.js'
import { mbWords, whisperDownloadDoor, whisperModelByName } from './whisperModels.js'

type VoicePhase = 'idle' | 'recording' | 'transcribing'
interface VoiceReceipt { seq: number; text: string; tone: 'info' | 'error' }
interface VoiceSnapshot {
  enabled: boolean
  phase: VoicePhase
  startedAt: number | null
  backend: CaptureBackendKind | null
  receipt: VoiceReceipt | null
}

export const HOLD_TO_TALK_MS = 1_000
export const HOLD_WORDS = `hold space for ${HOLD_TO_TALK_MS / 1000} s to speak, release it to stop, esc cancels`
export const NO_REPEAT_WORDS = '/voice starts and stops a take without the key — the road for a terminal whose key repeat is off (a held key that never repeats cannot open a take)'
export const RECORDING_FOOTER = 'recording · release space to stop · esc cancels'
export const TRANSCRIBING_FOOTER = 'transcribing…'
export const VOICE_OFF_RECEIPT = `voice input is off — /voice on turns it on; then ${HOLD_WORDS}`
const ALREADY_RECORDING_RECEIPT = 'already recording — /voice again or esc ends the take'
export const CANCELLED_RECEIPT = 'capture cancelled — nothing sent'
export const BUSY_RECEIPT = 'transcribing the last take — a moment'
export const ENGINE_BUSY_RECEIPT = 'the on-device transcriber is still decoding the previous take — try again in a moment'

const listeners = new Set<() => void>()
let snapshot: VoiceSnapshot = { enabled: false, phase: 'idle', startedAt: null, backend: null, receipt: null }
let receiptSeq = 0
let active: CaptureHandle | null = null
let lastStreamErrors: CaptureStreamErrors | null = null

type StreamErrorNotice = { kind: 'fatal'; text: string } | { kind: 'transient'; debug: string } | null
export function streamErrorNotice(errors: CaptureStreamErrors): StreamErrorNotice {
  if (errors.fatal !== null) return { kind: 'fatal', text: `the input stream failed during the take — ${errors.fatal}` }
  if (errors.transient > 0) {
    return { kind: 'transient', debug: `voice capture: ${errors.transient} transient stream error${errors.transient === 1 ? '' : 's'} (${errors.lastTransient ?? 'buffer underrun or overrun'})` }
  }
  return null
}

export function lastTakeStreamWords(errors: CaptureStreamErrors | null = lastStreamErrors, take: 'last take' | 'this take' = 'last take'): string | null {
  if (errors === null) return null
  const notice = streamErrorNotice(errors)
  if (notice === null) return `${take}: the input stream ${take === 'this take' ? 'is' : 'stayed'} clean`
  if (notice.kind === 'fatal') return `${take}: ${notice.text}`
  return `${take}: ${errors.transient} transient stream error${errors.transient === 1 ? '' : 's'}, the capture ${take === 'this take' ? 'keeps' : 'kept'} going`
}

function currentTakeStreamWords(): string | null {
  if (active !== null && !active.settled) return lastTakeStreamWords(active.streamErrors(), 'this take')
  return lastTakeStreamWords()
}

export function voiceInputEnabled(): boolean {
  try { return getGlobalConfig().voiceInputEnabled === true } catch { return false }
}

function publish(patch: Partial<VoiceSnapshot>): void {
  snapshot = { ...snapshot, enabled: voiceInputEnabled(), ...patch }
  for (const listener of [...listeners]) {
    try { listener() } catch {}
  }
}

function receipt(text: string, tone: VoiceReceipt['tone']): void {
  receiptSeq += 1
  publish({ receipt: { seq: receiptSeq, text, tone } })
}

export function subscribeVoice(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function voiceSnapshot(): VoiceSnapshot {
  const enabled = voiceInputEnabled()
  if (enabled !== snapshot.enabled) snapshot = { ...snapshot, enabled }
  return snapshot
}

export function setVoiceInputEnabled(on: boolean): void {
  saveGlobalConfig(config => ({ ...config, voiceInputEnabled: on }))
  if (!on && active !== null) cancelVoiceCapture()
  publish({})
}

const seconds = (ms: number): string => `${Math.max(1, Math.round(ms / 1000))}s`
export function boundLabel(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000}-minute`
  return `${Math.round(ms / 100) / 10}-second`
}

function landTranscript(text: string): void {
  const draft = pendingInput.text()
  const separator = draft === '' || /\s$/.test(draft) ? '' : ' '
  pendingInput.append(separator + text)
}

async function finishCapture(reason: 'key' | 'bound'): Promise<void> {
  const handle = active
  if (handle === null || handle.settled) return
  active = null
  publish({ phase: 'transcribing' })
  if (reason === 'bound') receipt(`capture stopped at the ${boundLabel(captureBoundMs())} bound — transcribing`, 'info')
  try {
    let result
    try { result = await handle.stop() } catch (error) {
      receipt(error instanceof Error ? error.message : String(error), 'error')
      return
    }
    lastStreamErrors = result.streamErrors
    const streamNotice = streamErrorNotice(result.streamErrors)
    if (streamNotice?.kind === 'transient') logForDebugging(streamNotice.debug)
    if (streamNotice?.kind === 'fatal') {
      receipt(`${streamNotice.text} — ${microphonePermissionHint()}`, 'error')
      return
    }
    if (result.silent) {
      receipt(`only silence reached the microphone (${seconds(result.durationMs)}) — ${microphonePermissionHint()}`, 'error')
      return
    }
    const transcriber = resolveTranscriber()
    if (transcriber.state === 'none') { receipt(transcriber.note, 'error'); return }
    try {
      const transcript = await transcribeWav(result.wav, { choice: transcriber.choice })
      if (transcript.text === '') {
        receipt(`${transcriber.choice.label} heard no words in this take (${seconds(result.durationMs)})`, 'info')
        return
      }
      landTranscript(transcript.text)
      receipt(`transcribed on this machine (${transcript.model}) · ${seconds(result.durationMs)}`, 'info')
    } catch (error) {
      receipt(`transcription failed — ${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  } finally {
    publish({ phase: 'idle', startedAt: null, backend: null })
  }
}

type VoiceToggleOutcome = { kind: 'started' | 'stopping' | 'busy' | 'refused'; text: string }
type VoiceRoad = 'hold' | 'command'

export async function toggleVoiceCapture(opts: { env?: NodeJS.ProcessEnv } = {}): Promise<VoiceToggleOutcome> {
  if (snapshot.phase === 'recording' && active !== null) {
    stopVoiceCapture(opts)
    return { kind: 'stopping', text: TRANSCRIBING_FOOTER }
  }
  return startVoiceCapture({ ...opts, road: 'command' })
}

export function stopVoiceCapture(_opts: { env?: NodeJS.ProcessEnv } = {}): boolean {
  if (snapshot.phase !== 'recording' || active === null) return false
  void finishCapture('key')
  return true
}

export async function startVoiceCapture(opts: { env?: NodeJS.ProcessEnv; road?: VoiceRoad } = {}): Promise<VoiceToggleOutcome> {
  const env = opts.env ?? process.env
  const refuse = (text: string): VoiceToggleOutcome => { receipt(text, 'error'); return { kind: 'refused', text } }
  if (snapshot.phase === 'transcribing') {
    receipt(BUSY_RECEIPT, 'info')
    return { kind: 'busy', text: BUSY_RECEIPT }
  }
  if (snapshot.phase === 'recording' && active !== null) {
    receipt(ALREADY_RECORDING_RECEIPT, 'info')
    return { kind: 'busy', text: ALREADY_RECORDING_RECEIPT }
  }
  if (!voiceInputEnabled()) return refuse(VOICE_OFF_RECEIPT)
  const backend = resolveCaptureBackend(env)
  if (backend.state === 'none') return refuse(backend.note)
  const transcriber = resolveTranscriber()
  if (transcriber.state === 'none') return refuse(transcriber.note)
  if (localDecodesInFlight() > 0) return refuse(ENGINE_BUSY_RECEIPT)
  let handle: CaptureHandle
  try {
    handle = await startCapture({ env, backend, onAutoStop: () => { void finishCapture('bound') } })
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error))
  }
  active = handle
  publish({ phase: 'recording', startedAt: handle.startedAt, backend: handle.backend })
  logForDebugging(`voice: capture started on ${handle.backend}; transcriber on-device (${transcriber.choice.label})`)
  setImmediate(() => warmLocalTranscriber())
  const stop = opts.road === 'command' ? '/voice again stops it, esc cancels' : 'release space to stop, esc cancels'
  return { kind: 'started', text: `recording — ${stop} (${transcriber.choice.label} transcribes)` }
}

export function cancelVoiceCapture(): boolean {
  const handle = active
  if (handle === null) return false
  active = null
  handle.cancel()
  publish({ phase: 'idle', startedAt: null, backend: null })
  receipt(CANCELLED_RECEIPT, 'info')
  return true
}

export function releaseVoiceCaptureOnExit(): boolean {
  const handle = active
  if (handle === null) return false
  active = null
  try { handle.cancel() } catch {}
  publish({ phase: 'idle', startedAt: null, backend: null })
  return true
}

registerCleanup(async () => {
  releaseVoiceCaptureOnExit()
})

function backendWords(backend: CaptureBackendResolution): string {
  return backend.state === 'ok' ? backend.detail : `none — ${backend.note}`
}

function transcriberWords(transcriber: TranscriberResolution): string {
  if (transcriber.state === 'none') return `none — ${transcriber.note}`
  const local = transcriber.local
  return `on-device — ${local.pack.engine.split(' ')[0]} ${local.model} (pack ${local.pack.version} ${local.pack.platform}, ${local.pack.where})`
}

function downloadDoorWords(transcriber: TranscriberResolution): string | null {
  const local = transcriber.local
  return local.state === 'absent' && local.reason === 'model' && local.download !== undefined ? whisperDownloadDoor(local.download) : null
}

function onDeviceCostWords(transcriber: TranscriberResolution): string | null {
  if (transcriber.state !== 'ok') return null
  const local = transcriber.local
  const road = local.pack.gpu === 'metal' ? 'Metal on the GPU' : 'the CPU'
  return `on-device: ${local.pack.engine}, ${local.model} (${local.language === 'en' ? 'English' : 'multilingual'}), ${road}; ${onDeviceMemoryWords(local.model)}`
}

function onDeviceMemoryWords(model: string): string {
  const row = whisperModelByName(model)
  const bytes = row?.bytes ?? 59_721_011
  const mb = Math.round((bytes / 1_000_000) * 1.35 / 5) * 5
  return `about ${mb} MB more memory while the model is loaded${row ? ` (the file is ${mbWords(row.bytes)})` : ''}`
}

export function describeVoiceStatus(env: NodeJS.ProcessEnv = process.env): string {
  const on = voiceInputEnabled()
  const transcriber = resolveTranscriber()
  const door = downloadDoorWords(transcriber)
  return [
    `voice input ${on ? `ON — ${HOLD_WORDS}` : 'OFF — /voice on turns it on'}`,
    ...(on ? [NO_REPEAT_WORDS] : []),
    `transcriber: ${transcriberWords(transcriber)}`,
    ...(door !== null ? [door] : []),
    `backend: ${backendWords(resolveCaptureBackend(env))}`,
    ...(currentTakeStreamWords() !== null ? [currentTakeStreamWords() as string] : []),
  ].join('\n')
}

interface VoiceReadiness { ready: boolean; line: string; detail: string }
export function describeVoiceReadiness(env: NodeJS.ProcessEnv = process.env): VoiceReadiness {
  const backend = resolveCaptureBackend(env)
  const transcriber = resolveTranscriber()
  const on = voiceInputEnabled()
  const permission = process.platform === 'darwin'
    ? 'microphone permission: macOS asks for the terminal on the first capture — not knowable before it'
    : 'microphone permission: the operating system decides at the first capture'
  const line = `backend: ${backendWords(backend)} · transcriber: ${transcriberWords(transcriber)} · /voice ${on ? 'on' : 'off'}`
  const debugDir = voiceDebugWavDir()
  const cost = onDeviceCostWords(transcriber)
  const door = downloadDoorWords(transcriber)
  const disk = debugDir === null ? 'nothing is written to disk' : `a debug copy of every take is written to ${debugDir} (MERCURY_VOICE_DEBUG_WAV_DIR)`
  const local = transcriber.local
  const detail = [
    backend.state === 'ok' ? `capture: ${backend.detail}${backend.pinned ? ' (MERCURY_VOICE_BACKEND)' : ''}` : `capture: ${backend.note}`,
    `transcriber: ${transcriberWords(transcriber)}`,
    ...(local.state === 'ok' ? [`on-device CPU floor: ${local.pack.floor}`] : []),
    ...(cost !== null ? [cost] : []),
    ...(door !== null ? [door] : []),
    permission,
    `audio never leaves the box: the take is transcribed on this machine; ${disk}`,
  ].join('\n')
  return { ready: backend.state === 'ok' && transcriber.state === 'ok', line, detail }
}

export function resetVoiceForTest(): void {
  if (active !== null) {
    try { active.cancel() } catch {}
  }
  active = null
  receiptSeq = 0
  lastStreamErrors = null
  snapshot = { enabled: voiceInputEnabled(), phase: 'idle', startedAt: null, backend: null, receipt: null }
}
