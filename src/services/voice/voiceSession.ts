import * as pendingInput from '../../input-core/pending-input.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  captureBoundMs,
  microphonePermissionHint,
  resolveCaptureBackend,
  startCapture,
  voiceDebugWavDir,
  type CaptureBackendKind,
  type CaptureBackendResolution,
  type CaptureHandle,
} from './capture.js'
import {
  ON_DEVICE_NAME,
  TRANSCRIBER_PIN_ENV,
  choiceDebugName,
  choiceDisplayName,
  liveTranscriberReads,
  parseSavedTranscriber,
  resolveTranscriber,
  transcribeWav,
  transcriberOptionNames,
  transcriberOptions,
  warmLocalTranscriber,
  type TranscriberResolution,
} from './transcribe.js'
import { mbWords, whisperDownloadDoor, whisperModelByName } from './whisperModels.js'

export type VoicePhase = 'idle' | 'recording' | 'transcribing'

export interface VoiceReceipt {
  seq: number
  text: string
  tone: 'info' | 'error'
}

export interface VoiceSnapshot {
  enabled: boolean
  phase: VoicePhase
  startedAt: number | null
  backend: CaptureBackendKind | null
  receipt: VoiceReceipt | null
}

export const RECORDING_FOOTER = 'recording · space or esc to stop'
export const TRANSCRIBING_FOOTER = 'transcribing…'

export const VOICE_OFF_RECEIPT = 'voice input is off — /speak on turns it on; then space in an empty composer starts a capture'
export const CANCELLED_RECEIPT = 'capture cancelled — nothing sent'
export const BUSY_RECEIPT = 'transcribing the last take — a moment'

const listeners = new Set<() => void>()
let snapshot: VoiceSnapshot = { enabled: false, phase: 'idle', startedAt: null, backend: null, receipt: null }
let receiptSeq = 0
let active: CaptureHandle | null = null

export function voiceInputEnabled(): boolean {
  try {
    return getGlobalConfig().voiceInputEnabled === true
  } catch {
    return false
  }
}

function publish(patch: Partial<VoiceSnapshot>): void {
  snapshot = { ...snapshot, enabled: voiceInputEnabled(), ...patch }
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
    }
  }
}

function receipt(text: string, tone: VoiceReceipt['tone']): void {
  receiptSeq += 1
  publish({ receipt: { seq: receiptSeq, text, tone } })
}

export function subscribeVoice(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
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

export function voiceTranscriberChoice(): string | null {
  try {
    const raw = getGlobalConfig().voiceTranscriber
    return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null
  } catch {
    return null
  }
}

export function setVoiceTranscriberChoice(name: string | null): void {
  saveGlobalConfig(config => {
    const next: Record<string, unknown> = { ...config }
    next.voiceTranscriber = name === null ? undefined : name
    return next as typeof config
  })
  publish({})
}

const seconds = (ms: number): string => `${Math.max(1, Math.round(ms / 1000))}s`

export function boundLabel(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000}-minute`
  return `${Math.round(ms / 100) / 10}-second`
}

export function landTranscript(text: string): void {
  const draft = pendingInput.text()
  const separator = draft === '' || /\s$/.test(draft) ? '' : ' '
  pendingInput.append(separator + text)
}

async function finishCapture(reason: 'key' | 'bound', env: NodeJS.ProcessEnv): Promise<void> {
  const handle = active
  if (handle === null || handle.settled) return
  active = null
  publish({ phase: 'transcribing' })
  if (reason === 'bound') receipt(`capture stopped at the ${boundLabel(captureBoundMs())} bound — transcribing`, 'info')
  try {
    let result
    try {
      result = await handle.stop()
    } catch (error) {
      receipt(error instanceof Error ? error.message : String(error), 'error')
      return
    }
    if (result.silent) {
      receipt(`only silence reached the microphone (${seconds(result.durationMs)}) — ${microphonePermissionHint()}`, 'error')
      return
    }
    const transcriber = resolveTranscriber(env)
    if (transcriber.state === 'none') {
      receipt(transcriber.note, 'error')
      return
    }
    try {
      const transcript = await transcribeWav(result.wav, { choice: transcriber.choice, env })
      const onDevice = transcriber.choice.kind === 'local'
      const via = onDevice ? transcriber.choice.label : `${choiceDisplayName(transcriber.choice)} (${transcript.model})`
      if (transcript.text === '') {
        receipt(`${via} heard no words in this take (${seconds(result.durationMs)})`, 'info')
        return
      }
      landTranscript(transcript.text)
      receipt(onDevice ? `transcribed on this machine (${transcript.model}) · ${seconds(result.durationMs)}` : `transcribed by ${via} · ${seconds(result.durationMs)}`, 'info')
    } catch (error) {
      receipt(`transcription failed — ${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  } finally {
    publish({ phase: 'idle', startedAt: null, backend: null })
  }
}

export type VoiceToggleOutcome = { kind: 'started' | 'stopping' | 'busy' | 'refused'; text: string }

export async function toggleVoiceCapture(opts: { env?: NodeJS.ProcessEnv } = {}): Promise<VoiceToggleOutcome> {
  const env = opts.env ?? process.env
  const refuse = (text: string): VoiceToggleOutcome => {
    receipt(text, 'error')
    return { kind: 'refused', text }
  }
  if (snapshot.phase === 'transcribing') {
    receipt(BUSY_RECEIPT, 'info')
    return { kind: 'busy', text: BUSY_RECEIPT }
  }
  if (snapshot.phase === 'recording' && active !== null) {
    void finishCapture('key', env)
    return { kind: 'stopping', text: TRANSCRIBING_FOOTER }
  }
  if (!voiceInputEnabled()) return refuse(VOICE_OFF_RECEIPT)
  const backend = resolveCaptureBackend(env)
  if (backend.state === 'none') return refuse(backend.note)
  const transcriber = resolveTranscriber(env)
  if (transcriber.state === 'none') return refuse(transcriber.note)
  let handle: CaptureHandle
  try {
    handle = await startCapture({
      env,
      backend,
      onAutoStop: () => {
        void finishCapture('bound', env)
      },
    })
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error))
  }
  active = handle
  publish({ phase: 'recording', startedAt: handle.startedAt, backend: handle.backend })
  logForDebugging(`voice: capture started on ${handle.backend}; transcriber ${choiceDebugName(transcriber.choice)} (${transcriber.choice.label})`)
  if (transcriber.choice.kind === 'local') setImmediate(() => warmLocalTranscriber())
  const saved = transcriber.saved
  const words =
    saved !== null && saved.state === 'unavailable'
      ? `${choiceDisplayName(transcriber.choice)} transcribes — your saved ${saved.display} ${saved.short ?? 'cannot serve'}`
      : `${transcriber.choice.label} transcribes`
  return { kind: 'started', text: `recording — space or esc stops it (${words})` }
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
  try {
    handle.cancel()
  } catch {
  }
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
  if (transcriber.state === 'ok') {
    if (transcriber.choice.kind === 'local') {
      const local = transcriber.local
      const engine = local.state === 'ok' ? local.pack.engine.split(' ')[0] : 'whisper.cpp'
      const pack = local.state === 'ok' ? ` (pack ${local.pack.version} ${local.pack.platform}, ${local.pack.where})` : ''
      return `on-device — ${engine} ${transcriber.choice.model}${pack}`
    }
    return `${choiceDisplayName(transcriber.choice)} — ${transcriber.choice.label}, the most recent transcribing sign-in`
  }
  return `none — ${transcriber.note}`
}

function onDeviceWords(transcriber: TranscriberResolution): string | null {
  if (transcriber.state === 'ok' && transcriber.choice.kind === 'local') return null
  const local = transcriber.local
  if (local.state === 'ok') {
    const saved = transcriber.saved
    if (saved !== null && saved.state === 'serving') return `on-device transcriber: usable (${local.model}), your saved choice is ${saved.display}`
    return `on-device transcriber: usable (${local.model}), held back by ${TRANSCRIBER_PIN_ENV}`
  }
  return `on-device transcriber: ${local.note}`
}

function defaultWords(transcriber: TranscriberResolution): string {
  const saved = transcriber.saved
  const serving = transcriber.state === 'ok' ? choiceDisplayName(transcriber.choice) : 'nothing'
  if (saved === null) return `default: the shipped one — ${ON_DEVICE_NAME} when the pack and a model are present, else the most recent signed-in family (/speak options chooses another)`
  if (saved.state === 'serving') return `default: your saved choice — ${saved.display} (/speak options default restores the shipped default)`
  if (saved.state === 'overridden') return `default: ${saved.note ?? `the pin overrides your saved choice (${saved.display})`}`
  return `your saved choice (${saved.display}) cannot serve: ${saved.note ?? 'unusable'} — ${serving} serves (/speak options chooses another)`
}

function downloadDoorWords(transcriber: TranscriberResolution): string | null {
  const local = transcriber.local
  if (local.state === 'absent' && local.reason === 'model' && local.download !== undefined) return whisperDownloadDoor(local.download)
  return null
}

function onDeviceCostWords(transcriber: TranscriberResolution): string | null {
  if (transcriber.state !== 'ok' || transcriber.choice.kind !== 'local' || transcriber.local.state !== 'ok') return null
  const local = transcriber.local
  const road = local.pack.gpu === 'metal' ? 'Metal on the GPU' : 'the CPU'
  return `on-device: ${local.pack.engine}, ${local.model} (${local.language === 'en' ? 'English' : 'multilingual'}), ${road}; ${onDeviceMemoryWords(local.model)}`
}

export function onDeviceMemoryWords(model: string): string {
  const row = whisperModelByName(model)
  const bytes = row?.bytes ?? 59_721_011
  const mb = Math.round((bytes / 1_000_000) * 1.35 / 5) * 5
  return `about ${mb} MB more memory while the model is loaded${row ? ` (the file is ${mbWords(row.bytes)})` : ''}`
}

export function describeVoiceStatus(env: NodeJS.ProcessEnv = process.env): string {
  const on = voiceInputEnabled()
  const transcriber = resolveTranscriber(env)
  const onDevice = onDeviceWords(transcriber)
  const door = downloadDoorWords(transcriber)
  return [
    `voice input ${on ? 'ON — space in an empty composer starts a capture, space or esc stops it' : 'OFF — /speak on turns it on'}`,
    `transcriber: ${transcriber.state === 'ok' ? (transcriber.choice.kind === 'local' ? transcriberWords(transcriber) : `${choiceDisplayName(transcriber.choice)} · ${transcriber.choice.label}`) : `none — ${transcriber.note}`}`,
    defaultWords(transcriber),
    ...(onDevice !== null ? [onDevice] : []),
    ...(door !== null ? [door] : []),
    `backend: ${backendWords(resolveCaptureBackend(env))}`,
  ].join('\n')
}

export function describeVoiceOptions(env: NodeJS.ProcessEnv = process.env): string {
  const transcriber = resolveTranscriber(env)
  const rows = transcriberOptions(liveTranscriberReads(env))
  const saved = parseSavedTranscriber(voiceTranscriberChoice())
  const savedName = saved.kind === 'unset' ? null : saved.kind === 'family' ? saved.family : saved.kind === 'unknown' ? saved.raw : ON_DEVICE_NAME
  const servingName = transcriber.state === 'ok' ? (transcriber.choice.kind === 'local' ? ON_DEVICE_NAME : transcriber.choice.family) : null
  const lines = [`transcribers this install can use — /speak options <name> makes one your default; /speak options default restores the shipped default`]
  for (const row of rows) {
    const mark = row.name === servingName ? '●' : '○'
    const tags = [
      ...(row.name === servingName ? ['serves now'] : []),
      ...(row.name === savedName ? ['your saved choice'] : savedName === null && row.name === ON_DEVICE_NAME ? ['the shipped default'] : []),
    ]
    lines.push(`${mark} ${row.name} — ${row.display === row.name ? '' : `${row.display}: `}${row.detail}${tags.length > 0 ? ` (${tags.join(', ')})` : ''}`)
  }
  if (savedName !== null && !rows.some(r => r.name === savedName)) lines.push(`○ ${savedName} — your saved choice, not a transcriber this install can use (${transcriberOptionNames().join(' · ')})`)
  lines.push(defaultWords(transcriber))
  if (transcriber.saved?.state === 'overridden' && transcriber.saved.note) lines.push(transcriber.saved.note)
  return lines.join('\n')
}

export interface VoiceReadiness {
  ready: boolean
  line: string
  detail: string
}

export function describeVoiceReadiness(env: NodeJS.ProcessEnv = process.env): VoiceReadiness {
  const backend = resolveCaptureBackend(env)
  const transcriber = resolveTranscriber(env)
  const on = voiceInputEnabled()
  const permission =
    process.platform === 'darwin'
      ? 'microphone permission: macOS asks for the terminal on the first capture — not knowable before it'
      : 'microphone permission: the operating system decides at the first capture'
  const line = `backend: ${backendWords(backend)} · transcriber: ${transcriberWords(transcriber)} · /speak ${on ? 'on' : 'off'}`
  const anthropicNamed = transcriber.skipped.some(s => s.startsWith('Anthropic'))
  const debugDir = voiceDebugWavDir()
  const onDevice = transcriber.state === 'ok' && transcriber.choice.kind === 'local'
  const onDeviceLine = onDeviceWords(transcriber)
  const cost = onDeviceCostWords(transcriber)
  const door = downloadDoorWords(transcriber)
  const disk = debugDir === null ? 'nothing is written to disk' : `a debug copy of every take is written to ${debugDir} (MERCURY_VOICE_DEBUG_WAV_DIR)`
  const local = transcriber.local
  const detail = [
    backend.state === 'ok' ? `capture: ${backend.detail}${backend.pinned ? ' (MERCURY_VOICE_BACKEND)' : ''}` : `capture: ${backend.note}`,
    transcriber.state === 'ok' ? (transcriber.choice.kind === 'local' ? `transcriber: on-device (${transcriber.choice.model})` : `transcriber: ${transcriber.choice.label}`) : `transcriber: ${transcriber.note}`,
    ...(local.state === 'ok' ? [`on-device CPU floor: ${local.pack.floor}`] : []),
    defaultWords(transcriber),
    ...(cost !== null ? [cost] : []),
    ...(transcriber.state === 'ok' && transcriber.unused.length > 0 ? [`cloud families signed in, not used: ${transcriber.unused.join('; ')}`] : []),
    ...(onDeviceLine !== null ? [onDeviceLine] : []),
    ...(door !== null ? [door] : []),
    ...(transcriber.skipped.length > 0 ? [`families passed over: ${transcriber.skipped.join('; ')}`] : []),
    ...(anthropicNamed ? [] : ['Anthropic: no speech-to-text endpoint']),
    permission,
    onDevice ? `audio never leaves the box: the take is transcribed on this machine; ${disk}` : `audio leaves the box only to the transcribing family, only after a take stops; ${disk}`,
  ].join('\n')
  return { ready: backend.state === 'ok' && transcriber.state === 'ok', line, detail }
}

export function resetVoiceForTest(): void {
  if (active !== null) {
    try {
      active.cancel()
    } catch {
    }
  }
  active = null
  receiptSeq = 0
  snapshot = { enabled: voiceInputEnabled(), phase: 'idle', startedAt: null, backend: null, receipt: null }
}
