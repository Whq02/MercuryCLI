import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { isVoiceWavShape, pcmDurationMs, readWav } from './wav.js'
import { voiceCheckoutRoot } from './voicePack.js'
import { cpuFloorRefusal, cpuFloorRoadWords, loadWhisperAddon, probeCpuFloor, resolveWhisperPackDir, whisperPackAbsentNote, type WhisperAddon } from './whisperPack.js'
import { checkWhisperModel, type WhisperModelLanguage, type WhisperModelRow } from './whisperModels.js'

export function localTranscribeDeadlineMs(audioMs: number): number {
  return 120_000 + Math.max(0, Math.round(audioMs))
}

export type LocalAbsentReason = 'pack' | 'pin' | 'cpu' | 'model' | 'load'
export type LocalTranscriberRead =
  | {
      state: 'ok'
      label: string
      model: string
      language: WhisperModelLanguage
      pack: { version: string; platform: string; engine: string; gpu: string; where: string; floor: string }
    }
  | { state: 'absent'; reason: LocalAbsentReason; note: string; short: string; download?: WhisperModelRow }

export interface TranscriberChoice {
  kind: 'local'
  label: string
  model: string
}

export type TranscriberResolution =
  | { state: 'ok'; choice: TranscriberChoice; local: Extract<LocalTranscriberRead, { state: 'ok' }> }
  | { state: 'none'; note: string; local: Extract<LocalTranscriberRead, { state: 'absent' }> }

export function noTranscriberReceipt(local: LocalTranscriberRead): string {
  return local.state === 'absent' ? `on-device transcriber: ${local.note}` : local.label
}

export function pickTranscriber(local: LocalTranscriberRead): TranscriberResolution {
  return local.state === 'ok'
    ? { state: 'ok', choice: { kind: 'local', label: local.label, model: local.model }, local }
    : { state: 'none', note: noTranscriberReceipt(local), local }
}

export function localTranscriberRead(): LocalTranscriberRead {
  const pack = resolveWhisperPackDir()
  if (pack.state === 'unavailable') {
    if (pack.note.startsWith('MERCURY_WHISPER_PACK_DIR')) return { state: 'absent', reason: 'pin', note: pack.note, short: 'on-device pack pin broken' }
    const checkout = voiceCheckoutRoot() !== null
    return { state: 'absent', reason: 'pack', note: pack.note.startsWith('no on-device transcriber pack for') ? whisperPackAbsentNote() : pack.note, short: checkout ? 'no on-device pack (bun run setup)' : 'no on-device pack in this build' }
  }
  const floor = probeCpuFloor({ addonPath: pack.addonPath })
  if (floor.state !== 'met') {
    return { state: 'absent', reason: 'cpu', note: cpuFloorRefusal(floor), short: floor.state === 'unmet' ? 'CPU below the on-device floor' : 'on-device CPU check inconclusive' }
  }
  const load = loadWhisperAddon()
  if (load.state === 'unavailable') return { state: 'absent', reason: 'load', note: load.note, short: 'on-device pack cannot load' }
  const model = checkWhisperModel()
  if (model.state === 'broken') return { state: 'absent', reason: 'pin', note: model.note, short: 'on-device model pin broken' }
  if (model.state === 'absent') return { state: 'absent', reason: 'model', note: model.note, short: 'on-device model: /voice on', download: model.row }
  if (model.state === 'mismatch') return { state: 'absent', reason: 'model', note: `pack present, model damaged: ${model.note}`, short: 'damaged model: /voice on' }
  const where = pack.source === 'workspace' ? 'the checkout' : pack.source === 'override' ? 'MERCURY_WHISPER_PACK_DIR' : 'beside the bundle'
  return {
    state: 'ok', label: `on-device transcriber (${model.name})`, model: model.name, language: model.language,
    pack: { version: pack.manifest.version, platform: pack.manifest.platform, engine: `${pack.manifest.engine.name} ${pack.manifest.engine.version}`, gpu: pack.manifest.gpu, where, floor: cpuFloorRoadWords(floor) },
  }
}

export function resolveTranscriber(): TranscriberResolution {
  return pickTranscriber(localTranscriberRead())
}

export interface TranscribeOptions {
  choice: TranscriberChoice
  deadlineMs?: number
}

export interface Transcript {
  text: string
  kind: 'local'
  family: null
  model: string
  ms: number
}

export class TranscribeError extends Error {
  readonly kind = 'local'
  readonly family = null
  constructor(_source: 'local', message: string) {
    super(message)
    this.name = 'TranscribeError'
  }
}

const loadedModels = new Map<string, number>()
let decodeTail: Promise<unknown> = Promise.resolve()
let decodesHeld = 0

export function localDecodesInFlight(): number {
  return decodesHeld
}

function modelHandle(addon: WhisperAddon, path: string): number {
  const cached = loadedModels.get(path)
  if (cached !== undefined) return cached
  const handle = addon.loadModel(path)
  loadedModels.set(path, handle)
  return handle
}

export function stripNonSpeechMarkers(text: string): string {
  return text
    .replace(/\[(?:BLANK_AUDIO|MUSIC|NOISE|SILENCE|INAUDIBLE|_[A-Z_]+_)\]/g, ' ')
    .replace(/\((?:silence|music|noise|inaudible)\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function warmLocalTranscriber(): void {
  try {
    const load = loadWhisperAddon()
    if (load.state !== 'ok') return
    const model = checkWhisperModel()
    if (model.state !== 'present') return
    modelHandle(load.addon, model.path)
  } catch {}
}

export async function transcribeWav(wav: Buffer, opts: TranscribeOptions): Promise<Transcript> {
  const read = readWav(wav)
  if (!read.ok) throw new TranscribeError('local', `the take is not a PCM WAV: ${read.reason}`)
  if (!isVoiceWavShape(read.header)) {
    throw new TranscribeError('local', `the take is ${read.header.sampleRate} Hz · ${read.header.channels} ch · ${read.header.bitsPerSample}-bit; the on-device transcriber decodes 16000 Hz · 1 ch · 16-bit`)
  }
  const load = loadWhisperAddon()
  if (load.state === 'unavailable') throw new TranscribeError('local', load.note)
  const model = checkWhisperModel()
  if (model.state !== 'present') throw new TranscribeError('local', model.note)
  let handle: number
  try {
    handle = modelHandle(load.addon, model.path)
  } catch (error) {
    throw new TranscribeError('local', error instanceof Error ? error.message : String(error))
  }
  const deadlineMs = opts.deadlineMs ?? localTranscribeDeadlineMs(pcmDurationMs(read.pcm))
  const queued = decodesHeld > 0
  let timer: ReturnType<typeof setTimeout> | null = null
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TranscribeError('local', queued
      ? `the on-device transcriber is still decoding the previous take — this one waited ${Math.round(deadlineMs / 1000)}s for it (${model.name})`
      : `the on-device transcriber did not answer within ${Math.round(deadlineMs / 1000)}s (${model.name})`)), deadlineMs)
    timer.unref?.()
  })
  const pcm = Buffer.from(read.pcm)
  decodesHeld += 1
  const decode = decodeTail
    .then(() => load.addon.transcribe(handle, pcm, { language: model.language === 'en' ? 'en' : 'auto' }))
    .finally(() => { decodesHeld -= 1 })
  decodeTail = decode.catch(() => {})
  try {
    const answer = await Promise.race([decode, bound])
    return { text: stripNonSpeechMarkers(answer.text), kind: 'local', family: null, model: model.name, ms: answer.ms }
  } catch (error) {
    if (error instanceof TranscribeError) throw error
    throw new TranscribeError('local', error instanceof Error ? error.message : String(error))
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

export function unloadLocalModels(): void {
  if (loadedModels.size === 0) return
  try {
    const load = loadWhisperAddon()
    if (load.state === 'ok') {
      for (const handle of loadedModels.values()) {
        try { load.addon.unloadModel(handle) } catch {}
      }
    }
  } catch {}
  loadedModels.clear()
}

registerCleanup(async () => {
  unloadLocalModels()
})
process.once('exit', () => {
  unloadLocalModels()
})

export function resetLocalTranscriberForTest(): void {
  unloadLocalModels()
}
