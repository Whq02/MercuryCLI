// ============================================================================
//  services/voice/voiceSession — voice INPUT: the operator speaks, the words
//  land in the composer. The one state owner the composer, the footer, the
//  commands (/speak · /voice) and the doctor read.
//
//  The master toggle is the persisted `voiceInputEnabled` setting (/speak
//  on|off). With it ON, space in an empty composer (or /voice) starts a
//  capture; `v` again stops it and the take goes to the transcriber; esc
//  cancels the take — nothing leaves the box before a take STOPS, by
//  construction: the transcriber is only ever handed a finished take. The
//  transcript is appended to the composer through the pending-input owner
//  (the composer snaps its cursor to the end of an external edit), ready
//  to edit or send. Every refusal is a receipt with the operator's words;
//  the phase drives the footer (recording · transcribing).
//
//  Mercury never speaks: this module has no output road but the composer.
// ============================================================================
import * as pendingInput from '../../input-core/pending-input.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { providerDisplayName } from '../providers/routeLaw.js'
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
import { resolveTranscriber, transcribeWav, type TranscriberResolution } from './transcribe.js'

export type VoicePhase = 'idle' | 'recording' | 'transcribing'

export interface VoiceReceipt {
  /** Monotonic; a consumer paints each receipt once. */
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

/** The footer words (the footer paints the ● before the recording line). */
export const RECORDING_FOOTER = 'recording · space or esc to stop'
export const TRANSCRIBING_FOOTER = 'transcribing…'

export const VOICE_OFF_RECEIPT = 'voice input is off — /speak on turns it on; then space in an empty composer starts a capture'
export const CANCELLED_RECEIPT = 'capture cancelled — nothing sent'
export const BUSY_RECEIPT = 'transcribing the last take — a moment'

const listeners = new Set<() => void>()
let snapshot: VoiceSnapshot = { enabled: false, phase: 'idle', startedAt: null, backend: null, receipt: null }
let receiptSeq = 0
let active: CaptureHandle | null = null

/** The persisted master toggle (false until /speak on; unreadable ⇒ off). */
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
      /* a subscriber's failure is its own */
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
  // The toggle can move underneath (another /speak, a config write): the
  // snapshot answers the live setting; the object only changes on a publish.
  const enabled = voiceInputEnabled()
  if (enabled !== snapshot.enabled) snapshot = { ...snapshot, enabled }
  return snapshot
}

/** /speak on|off — persisted; the snapshot follows at once. */
export function setVoiceInputEnabled(on: boolean): void {
  saveGlobalConfig(config => ({ ...config, voiceInputEnabled: on }))
  if (!on && active !== null) cancelVoiceCapture()
  publish({})
}

const seconds = (ms: number): string => `${Math.max(1, Math.round(ms / 1000))}s`

/** The bound's words for the receipt: whole minutes as minutes, anything
 *  shorter (a proof's bound) as seconds. */
export function boundLabel(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000}-minute`
  return `${Math.round(ms / 100) / 10}-second`
}

/** The transcript lands at the end of the draft, one space from any words
 *  already there; the composer's external-edit law puts the cursor after it. */
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
    // Re-resolved at the stop: a sign-in that landed during the take counts.
    const transcriber = resolveTranscriber(env)
    if (transcriber.state === 'none') {
      receipt(transcriber.note, 'error')
      return
    }
    try {
      const transcript = await transcribeWav(result.wav, { choice: transcriber.choice, env })
      const via = `${providerDisplayName(transcriber.choice.family)} (${transcript.model})`
      if (transcript.text === '') {
        receipt(`${via} heard no words in this take (${seconds(result.durationMs)})`, 'info')
        return
      }
      landTranscript(transcript.text)
      receipt(`transcribed by ${via} · ${seconds(result.durationMs)}`, 'info')
    } catch (error) {
      receipt(`transcription failed — ${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  } finally {
    publish({ phase: 'idle', startedAt: null, backend: null })
  }
}

export type VoiceToggleOutcome = { kind: 'started' | 'stopping' | 'busy' | 'refused'; text: string }

/**
 * The one action behind space and /voice: start a capture, or stop the one
 * running (its take goes to the transcriber). Every refusal answers its
 * words AND publishes them as a receipt.
 */
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
  // A keyless home hears the refusal BEFORE speaking, not after a take.
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
  logForDebugging(`voice: capture started on ${handle.backend}; transcriber ${transcriber.choice.family} (${transcriber.choice.label})`)
  return { kind: 'started', text: `recording — space or esc stops it (${transcriber.choice.label} transcribes)` }
}

/** Esc during a capture: the take is dropped; no request is made. */
export function cancelVoiceCapture(): boolean {
  const handle = active
  if (handle === null) return false
  active = null
  handle.cancel()
  publish({ phase: 'idle', startedAt: null, backend: null })
  receipt(CANCELLED_RECEIPT, 'info')
  return true
}

/** The exit road: a take still open when Mercury quits is dropped so the
 *  microphone (and a PATH recorder child) is released — no receipt, nobody
 *  is left to paint one. Answers whether a take was open. */
export function releaseVoiceCaptureOnExit(): boolean {
  const handle = active
  if (handle === null) return false
  active = null
  try {
    handle.cancel()
  } catch {
    /* a dropped take owes nothing */
  }
  publish({ phase: 'idle', startedAt: null, backend: null })
  return true
}

// The graceful-shutdown road runs every registered cleanup; the registry is
// a bare set, so this import pulls no shutdown module in.
registerCleanup(async () => {
  releaseVoiceCaptureOnExit()
})

function backendWords(backend: CaptureBackendResolution): string {
  return backend.state === 'ok' ? backend.detail : `none — ${backend.note}`
}

function transcriberWords(transcriber: TranscriberResolution): string {
  if (transcriber.state === 'ok') {
    return `${providerDisplayName(transcriber.choice.family)} — ${transcriber.choice.label}, the most recent transcribing sign-in`
  }
  return `none — ${transcriber.note}`
}

/** The /speak status line — the transcriber before the backend, whose
 *  words can carry a path (a receipt row truncates at the terminal's width;
 *  the sign-in must never be the part that falls off). */
export function describeVoiceStatus(env: NodeJS.ProcessEnv = process.env): string {
  const on = voiceInputEnabled()
  const transcriber = resolveTranscriber(env)
  return [
    `voice input ${on ? 'ON — space in an empty composer starts a capture, space or esc stops it' : 'OFF — /speak on turns it on'}`,
    `transcriber: ${transcriber.state === 'ok' ? `${providerDisplayName(transcriber.choice.family)} · ${transcriber.choice.label}` : `none — ${transcriber.note}`}`,
    `backend: ${backendWords(resolveCaptureBackend(env))}`,
  ].join('\n')
}

export interface VoiceReadiness {
  /** A backend AND a transcriber answer. */
  ready: boolean
  /** The doctor row's evidence line. */
  line: string
  /** The doctor row's detail: the ladder, the families passed over, the permission words. */
  detail: string
}

/** The doctor row's words — the same owners the capture would use. */
export function describeVoiceReadiness(env: NodeJS.ProcessEnv = process.env): VoiceReadiness {
  const backend = resolveCaptureBackend(env)
  const transcriber = resolveTranscriber(env)
  const on = voiceInputEnabled()
  const permission =
    process.platform === 'darwin'
      ? 'microphone permission: macOS asks for the terminal on the first capture — not knowable before it'
      : 'microphone permission: the operating system decides at the first capture'
  const line = `backend: ${backendWords(backend)} · transcriber: ${transcriberWords(transcriber)} · /speak ${on ? 'on' : 'off'}`
  // Anthropic is named once: with the family signed in it is already among
  // the families passed over, with its reason.
  const anthropicNamed = transcriber.skipped.some(s => s.startsWith('Anthropic'))
  const debugDir = voiceDebugWavDir()
  const detail = [
    backend.state === 'ok' ? `capture: ${backend.detail}${backend.pinned ? ' (MERCURY_VOICE_BACKEND)' : ''}` : `capture: ${backend.note}`,
    transcriber.state === 'ok' ? `transcriber: ${transcriber.choice.label}` : `transcriber: ${transcriber.note}`,
    ...(transcriber.skipped.length > 0 ? [`families passed over: ${transcriber.skipped.join('; ')}`] : []),
    ...(anthropicNamed ? [] : ['Anthropic: no speech-to-text endpoint']),
    permission,
    `audio leaves the box only to the transcribing family, only after a take stops; ${
      debugDir === null ? 'nothing is written to disk' : `a debug copy of every take is written to ${debugDir} (MERCURY_VOICE_DEBUG_WAV_DIR)`
    }`,
  ].join('\n')
  return { ready: backend.state === 'ok' && transcriber.state === 'ok', line, detail }
}

/** Proof seam: drop any capture and forget the receipts. */
export function resetVoiceForTest(): void {
  if (active !== null) {
    try {
      active.cancel()
    } catch {
      /* a dropped take owes nothing */
    }
  }
  active = null
  receiptSeq = 0
  snapshot = { enabled: voiceInputEnabled(), phase: 'idle', startedAt: null, backend: null, receipt: null }
}
