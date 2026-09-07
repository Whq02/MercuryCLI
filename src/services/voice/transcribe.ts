import type { CallModelRoute } from '../providers/idSpaces.js'
import { fetchWithProviderDeadline } from '../providers/fetchDeadline.js'
import { providerDisplayName } from '../providers/routeLaw.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { isVoiceWavShape, pcmDurationMs, readWav } from './wav.js'
import { voiceCheckoutRoot } from './voicePack.js'
import { cpuFloorRefusal, cpuFloorRoadWords, loadWhisperAddon, probeCpuFloor, resolveWhisperPackDir, whisperPackAbsentNote, type WhisperAddon } from './whisperPack.js'
import { checkWhisperModel, type WhisperModelLanguage, type WhisperModelRow } from './whisperModels.js'

export const NO_TRANSCRIBER_DOORS = '/logins openai (API key) or /logins gemini'

export const OPENAI_TRANSCRIBE_MODELS = ['gpt-4o-transcribe', 'whisper-1'] as const
export const GEMINI_TRANSCRIBE_FALLBACK_MODEL = 'gemini-2.5-flash'
export const GEMINI_TRANSCRIBE_PROMPT = 'Transcribe this audio verbatim. Output only the transcript, no commentary.'

export const TRANSCRIBE_DEADLINE_MS = 120_000

export function localTranscribeDeadlineMs(audioMs: number): number {
  return 120_000 + Math.max(0, Math.round(audioMs))
}

export type TranscribingFamily = 'openai' | 'gemini'

export const FAMILY_TRANSCRIBER: Record<CallModelRoute, { slot: 'api-key' } | { slot: 'none'; why: string }> = {
  anthropic: { slot: 'none', why: 'no speech-to-text endpoint' },
  openai: { slot: 'api-key' },
  gemini: { slot: 'api-key' },
  zai: { slot: 'none', why: 'no speech-to-text endpoint' },
  moonshot: { slot: 'none', why: 'no speech-to-text endpoint' },
  deepseek: { slot: 'none', why: 'no speech-to-text endpoint' },
  openrouter: { slot: 'none', why: 'no speech-to-text endpoint' },
  huggingface: { slot: 'none', why: 'no speech-to-text endpoint wired' },
  'openai-compat': { slot: 'none', why: 'no speech-to-text endpoint declared' },
  local: { slot: 'none', why: 'no speech-to-text endpoint declared' },
}


export type TranscriberOrder = 'on-device-first' | 'cloud-first'

export const TRANSCRIBER_ORDER: TranscriberOrder = 'on-device-first'

export const TRANSCRIBER_PIN_ENV = 'MERCURY_VOICE_TRANSCRIBER'

export type TranscriberPin =
  | { kind: 'unset' }
  | { kind: 'on-device' }
  | { kind: 'cloud' }
  | { kind: 'family'; family: CallModelRoute }
  | { kind: 'broken'; value: string; note: string }

export function parseTranscriberPin(raw: string | undefined): TranscriberPin {
  const value = (raw ?? '').trim().toLowerCase()
  if (value === '') return { kind: 'unset' }
  if (value === 'on-device') return { kind: 'on-device' }
  if (value === 'cloud') return { kind: 'cloud' }
  if (Object.prototype.hasOwnProperty.call(FAMILY_TRANSCRIBER, value)) return { kind: 'family', family: value as CallModelRoute }
  return {
    kind: 'broken',
    value,
    note: `${TRANSCRIBER_PIN_ENV}=${value} is not on-device, cloud or a family id (${Object.keys(FAMILY_TRANSCRIBER).join(' · ')}) — the pin names itself, no silent fallback`,
  }
}

export function liveTranscriberPin(): TranscriberPin {
  return parseTranscriberPin(flagEnv(TRANSCRIBER_PIN_ENV))
}


export const ON_DEVICE_NAME = 'on-device'

export type SavedTranscriber =
  | { kind: 'unset' }
  | { kind: 'on-device' }
  | { kind: 'family'; family: CallModelRoute }
  | { kind: 'unknown'; raw: string }

export function transcriberOptionNames(): string[] {
  return [ON_DEVICE_NAME, ...(Object.keys(FAMILY_TRANSCRIBER) as CallModelRoute[]).filter(f => FAMILY_TRANSCRIBER[f].slot === 'api-key')]
}

export function parseSavedTranscriber(raw: string | null | undefined): SavedTranscriber {
  const value = (raw ?? '').trim().toLowerCase()
  if (value === '') return { kind: 'unset' }
  if (value === ON_DEVICE_NAME) return { kind: 'on-device' }
  if (Object.prototype.hasOwnProperty.call(FAMILY_TRANSCRIBER, value)) return { kind: 'family', family: value as CallModelRoute }
  return { kind: 'unknown', raw: value }
}

export function savedTranscriberDisplay(saved: SavedTranscriber): string {
  return saved.kind === 'family' ? providerDisplayName(saved.family) : saved.kind === 'unknown' ? saved.raw : ON_DEVICE_NAME
}

export interface SavedChoiceOutcome {
  name: string
  display: string
  state: 'serving' | 'unavailable' | 'overridden'
  note?: string
  short?: string
}

export function liveSavedTranscriber(): SavedTranscriber {
  try {
    const { getGlobalConfig } = require('../../utils/config.js') as typeof import('../../utils/config.js')
    return parseSavedTranscriber(getGlobalConfig().voiceTranscriber)
  } catch {
    return { kind: 'unset' }
  }
}


export type LocalAbsentReason = 'pack' | 'pin' | 'cpu' | 'model'

export type LocalTranscriberRead =
  | {
      state: 'ok'
      label: string
      model: string
      language: WhisperModelLanguage
      pack: { version: string; platform: string; engine: string; gpu: string; where: string; floor: string }
    }
  | {
      state: 'absent'
      reason: LocalAbsentReason
      note: string
      short: string
      download?: WhisperModelRow
    }

export interface TranscriberReads {
  openaiApiKeyLabel(): string | null
  geminiApiKeyLabel(): string | null
  localTranscriber(): LocalTranscriberRead
}

export interface TranscriberChoiceCloud {
  kind: 'cloud'
  family: TranscribingFamily
  slot: 'api-key'
  label: string
}

export interface TranscriberChoiceLocal {
  kind: 'local'
  label: string
  model: string
}

export type TranscriberChoice = TranscriberChoiceCloud | TranscriberChoiceLocal

export type TranscriberResolution =
  | {
      state: 'ok'
      choice: TranscriberChoice
      skipped: string[]
      local: LocalTranscriberRead
      unused: string[]
      saved: SavedChoiceOutcome | null
    }
  | { state: 'none'; note: string; skipped: string[]; local: LocalTranscriberRead; saved: SavedChoiceOutcome | null }

export function choiceDisplayName(choice: TranscriberChoice): string {
  return choice.kind === 'cloud' ? providerDisplayName(choice.family) : 'on-device'
}

export function choiceDebugName(choice: TranscriberChoice): string {
  return choice.kind === 'cloud' ? choice.family : 'on-device'
}

export function noTranscriberReceipt(local: LocalTranscriberRead, pin: TranscriberPin = { kind: 'unset' }): string {
  const middle = pin.kind === 'cloud' || pin.kind === 'family' ? (local.state === 'ok' ? 'on-device held back by the pin' : local.short) : local.state === 'ok' ? 'on-device unusable' : local.short
  return `nothing transcribes yet — ${middle}; or ${NO_TRANSCRIBER_DOORS}`
}

const HELD_BACK = 'on-device transcriber: held back by'

export function pickTranscriber(
  families: readonly string[],
  reads: TranscriberReads,
  pin: TranscriberPin = { kind: 'unset' },
  order: TranscriberOrder = TRANSCRIBER_ORDER,
  savedChoice: SavedTranscriber = { kind: 'unset' },
): TranscriberResolution {
  const local = reads.localTranscriber()
  const skipped: string[] = []
  const savedName = savedChoice.kind === 'unset' ? null : savedChoice.kind === 'family' ? savedChoice.family : savedChoice.kind === 'unknown' ? savedChoice.raw : ON_DEVICE_NAME
  const savedDisplay = savedTranscriberDisplay(savedChoice)
  const pinValue = pin.kind === 'on-device' || pin.kind === 'cloud' ? pin.kind : pin.kind === 'family' ? pin.family : pin.kind === 'broken' ? pin.value : null
  const overridden: SavedChoiceOutcome | null = savedName !== null && pinValue !== null ? { name: savedName, display: savedDisplay, state: 'overridden', note: `${TRANSCRIBER_PIN_ENV}=${pinValue} overrides your saved choice (${savedDisplay}) for this process` } : null
  if (pin.kind === 'broken') return { state: 'none', note: pin.note, skipped, local, saved: overridden }
  const localChoice = (): TranscriberChoiceLocal | null => (local.state === 'ok' ? { kind: 'local', label: local.label, model: local.model } : null)
  const labelOf = (family: string): string | null => (family === 'openai' ? reads.openaiApiKeyLabel() : family === 'gemini' ? reads.geminiApiKeyLabel() : null)
  const walk = (): { choice: TranscriberChoiceCloud | null; withKeys: string[] } => {
    let choice: TranscriberChoiceCloud | null = null
    const withKeys: string[] = []
    for (const family of families) {
      const rule = FAMILY_TRANSCRIBER[family as CallModelRoute]
      if (rule === undefined) continue
      if (rule.slot === 'none') {
        skipped.push(`${providerDisplayName(family as CallModelRoute)}: ${rule.why}`)
        continue
      }
      const label = labelOf(family)
      if (label === null) {
        skipped.push(`${providerDisplayName(family as CallModelRoute)}: signed in without an API key (that slot does not transcribe)`)
        continue
      }
      withKeys.push(`${providerDisplayName(family as CallModelRoute)} (${label}) — ${TRANSCRIBER_PIN_ENV}=${family} chooses it`)
      if (choice === null) choice = { kind: 'cloud', family: family as TranscribingFamily, slot: 'api-key', label }
    }
    return { choice, withKeys }
  }

  if (pin.kind === 'on-device') {
    const choice = localChoice()
    if (choice !== null) return { state: 'ok', choice, skipped, local, unused: [], saved: overridden }
    return { state: 'none', note: `${TRANSCRIBER_PIN_ENV}=on-device but the on-device transcriber is ${local.state === 'absent' ? local.note : 'unusable'} — the pin names itself, no silent fallback`, skipped, local, saved: overridden }
  }
  if (pin.kind === 'family') {
    const family = pin.family
    const rule = FAMILY_TRANSCRIBER[family]
    const display = providerDisplayName(family)
    if (local.state === 'ok') skipped.push(`${HELD_BACK} ${TRANSCRIBER_PIN_ENV}=${family}`)
    if (rule.slot === 'none') {
      return { state: 'none', note: `${TRANSCRIBER_PIN_ENV}=${family} but ${display}: ${rule.why} — the pin names itself, no silent fallback`, skipped, local, saved: overridden }
    }
    const label = labelOf(family)
    if (label === null) {
      return { state: 'none', note: `${TRANSCRIBER_PIN_ENV}=${family} but no ${display} API key is signed in — the pin names itself, no silent fallback`, skipped, local, saved: overridden }
    }
    return { state: 'ok', choice: { kind: 'cloud', family: family as TranscribingFamily, slot: 'api-key', label }, skipped, local, unused: [], saved: overridden }
  }
  if (pin.kind === 'cloud') {
    if (local.state === 'ok') skipped.push(`${HELD_BACK} ${TRANSCRIBER_PIN_ENV}=cloud`)
    const { choice } = walk()
    if (choice !== null) return { state: 'ok', choice, skipped, local, unused: [], saved: overridden }
    return { state: 'none', note: noTranscriberReceipt(local, pin), skipped, local, saved: overridden }
  }
  let saved: SavedChoiceOutcome | null = null
  if (savedChoice.kind === 'on-device') {
    const choice = localChoice()
    if (choice !== null) {
      const { withKeys } = walk()
      return { state: 'ok', choice, skipped, local, unused: withKeys, saved: { name: ON_DEVICE_NAME, display: ON_DEVICE_NAME, state: 'serving' } }
    }
    saved = { name: ON_DEVICE_NAME, display: ON_DEVICE_NAME, state: 'unavailable', note: local.state === 'absent' ? local.note : 'unusable', short: 'cannot serve' }
  } else if (savedChoice.kind === 'family') {
    const family = savedChoice.family
    const rule = FAMILY_TRANSCRIBER[family]
    const display = providerDisplayName(family)
    const label = rule.slot === 'api-key' ? labelOf(family) : null
    if (label !== null) {
      if (local.state === 'ok') skipped.push(`on-device transcriber: usable (${local.model}), your saved choice is ${display}`)
      return { state: 'ok', choice: { kind: 'cloud', family: family as TranscribingFamily, slot: 'api-key', label }, skipped, local, unused: [], saved: { name: family, display, state: 'serving' } }
    }
    saved = rule.slot === 'none' ? { name: family, display, state: 'unavailable', note: `${display}: ${rule.why}`, short: 'cannot serve' } : { name: family, display, state: 'unavailable', note: `not signed in — /logins ${family} (API key)`, short: 'is not signed in' }
  } else if (savedChoice.kind === 'unknown') {
    saved = { name: savedChoice.raw, display: savedChoice.raw, state: 'unavailable', note: `"${savedChoice.raw}" is not a transcriber this install can use (${transcriberOptionNames().join(' · ')})`, short: 'is not a transcriber' }
  }
  if (order === 'on-device-first') {
    const choice = localChoice()
    if (choice !== null) {
      const { withKeys } = walk()
      return { state: 'ok', choice, skipped, local, unused: withKeys, saved }
    }
    const { choice: cloud } = walk()
    if (cloud !== null) return { state: 'ok', choice: cloud, skipped, local, unused: [], saved }
    return { state: 'none', note: noTranscriberReceipt(local, pin), skipped, local, saved }
  }
  const { choice: cloud } = walk()
  if (cloud !== null) {
    if (local.state === 'ok') skipped.push('on-device transcriber: usable, second in the order (cloud first)')
    return { state: 'ok', choice: cloud, skipped, local, unused: [], saved }
  }
  const choice = localChoice()
  if (choice !== null) return { state: 'ok', choice, skipped, local, unused: [], saved }
  return { state: 'none', note: noTranscriberReceipt(local, pin), skipped, local, saved }
}

export function localTranscriberRead(): LocalTranscriberRead {
  const pack = resolveWhisperPackDir()
  if (pack.state === 'unavailable') {
    const pinned = pack.note.startsWith('MERCURY_WHISPER_PACK_DIR')
    if (pinned) return { state: 'absent', reason: 'pin', note: pack.note, short: 'on-device pack pin broken' }
    const checkout = voiceCheckoutRoot() !== null
    return { state: 'absent', reason: 'pack', note: whisperPackAbsentNote(), short: checkout ? 'no on-device pack (bun run setup)' : 'no on-device pack in this build' }
  }
  const floor = probeCpuFloor({ addonPath: pack.addonPath })
  if (floor.state !== 'met') {
    return {
      state: 'absent',
      reason: 'cpu',
      note: cpuFloorRefusal(floor),
      short: floor.state === 'unmet' ? 'CPU below the on-device floor' : 'on-device CPU check inconclusive',
    }
  }
  const model = checkWhisperModel()
  if (model.state === 'broken') return { state: 'absent', reason: 'pin', note: model.note, short: 'on-device model pin broken' }
  if (model.state === 'absent') return { state: 'absent', reason: 'model', note: model.note, short: 'on-device model: /speak download', download: model.row }
  if (model.state === 'mismatch') return { state: 'absent', reason: 'model', note: `pack present, model damaged: ${model.note}`, short: 'damaged model: /speak download' }
  const where = pack.source === 'workspace' ? 'the checkout' : pack.source === 'override' ? 'MERCURY_WHISPER_PACK_DIR' : 'beside the bundle'
  return {
    state: 'ok',
    label: `on-device transcriber (${model.name})`,
    model: model.name,
    language: model.language,
    pack: { version: pack.manifest.version, platform: pack.manifest.platform, engine: `${pack.manifest.engine.name} ${pack.manifest.engine.version}`, gpu: pack.manifest.gpu, where, floor: cpuFloorRoadWords(floor) },
  }
}

export function liveTranscriberReads(env: NodeJS.ProcessEnv = process.env): TranscriberReads {
  return {
    openaiApiKeyLabel: () => {
      const { resolveOpenaiApiKey } =
        require('../providers/openai/openaiAccounts.js') as typeof import('../providers/openai/openaiAccounts.js')
      const key = resolveOpenaiApiKey(env)
      return key ? `OpenAI API key (${key.source})` : null
    },
    geminiApiKeyLabel: () => {
      const { resolveGeminiApiKey } =
        require('../providers/gemini/geminiAccounts.js') as typeof import('../providers/gemini/geminiAccounts.js')
      const key = resolveGeminiApiKey(env)
      if (!key) return null
      return key.source === 'env-google' ? 'Gemini API key (GOOGLE_API_KEY env)' : key.source === 'env-gemini' ? 'Gemini API key (GEMINI_API_KEY env)' : 'Gemini API key (stored)'
    },
    localTranscriber: localTranscriberRead,
  }
}

export function liveFamilyOrder(): string[] {
  const { recentSignIns } = require('../../utils/model/computedDefault.js') as typeof import('../../utils/model/computedDefault.js')
  try {
    return recentSignIns().map(c => c.family)
  } catch {
    return []
  }
}

export function resolveTranscriber(env: NodeJS.ProcessEnv = process.env): TranscriberResolution {
  return pickTranscriber(liveFamilyOrder(), liveTranscriberReads(env), liveTranscriberPin(), TRANSCRIBER_ORDER, liveSavedTranscriber())
}

export interface TranscriberOption {
  name: string
  display: string
  state: 'ready' | 'unavailable'
  detail: string
}

export function transcriberOptions(reads: TranscriberReads): TranscriberOption[] {
  const local = reads.localTranscriber()
  const rows: TranscriberOption[] = [
    local.state === 'ok'
      ? { name: ON_DEVICE_NAME, display: ON_DEVICE_NAME, state: 'ready', detail: `${local.pack.engine.split(' ')[0]} ${local.model} (pack ${local.pack.version} ${local.pack.platform}, ${local.pack.where})` }
      : { name: ON_DEVICE_NAME, display: ON_DEVICE_NAME, state: 'unavailable', detail: local.note },
  ]
  for (const family of Object.keys(FAMILY_TRANSCRIBER) as CallModelRoute[]) {
    if (FAMILY_TRANSCRIBER[family].slot !== 'api-key') continue
    const label = family === 'openai' ? reads.openaiApiKeyLabel() : family === 'gemini' ? reads.geminiApiKeyLabel() : null
    rows.push(label !== null ? { name: family, display: providerDisplayName(family), state: 'ready', detail: label } : { name: family, display: providerDisplayName(family), state: 'unavailable', detail: `not signed in — /logins ${family} (API key)` })
  }
  return rows
}


export interface TranscribeOptions {
  choice: TranscriberChoice
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  deadlineMs?: number
}

export interface Transcript {
  text: string
  kind: 'cloud' | 'local'
  family: TranscribingFamily | null
  model: string
  ms: number | null
}

export class TranscribeError extends Error {
  readonly kind: 'cloud' | 'local'
  readonly family: TranscribingFamily | null
  constructor(source: TranscribingFamily | 'local', message: string) {
    super(message)
    this.name = 'TranscribeError'
    this.kind = source === 'local' ? 'local' : 'cloud'
    this.family = source === 'local' ? null : source
  }
}

async function bodyExcerpt(res: Response): Promise<string> {
  try {
    const text = await res.text()
    try {
      const parsed = JSON.parse(text) as { error?: { message?: unknown } | string }
      const message = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message
      if (typeof message === 'string' && message !== '') return message.slice(0, 200)
    } catch {
    }
    return text.replace(/\s+/g, ' ').trim().slice(0, 200)
  } catch {
    return ''
  }
}

async function transcribeOpenai(wav: Buffer, opts: TranscribeOptions): Promise<Transcript> {
  const env = opts.env ?? process.env
  const fetchImpl = opts.fetchImpl ?? fetch
  const { resolveOpenaiRequestAuth } =
    require('../providers/openai/openaiAccounts.js') as typeof import('../providers/openai/openaiAccounts.js')
  const auth = await resolveOpenaiRequestAuth({ env, sourceKind: 'api-key', fetchImpl })
  if (!auth) throw new TranscribeError('openai', 'the OpenAI API key left the store before the request — /logins openai')
  const provider = providerDisplayName('openai')
  let lastRefusal = ''
  for (const model of OPENAI_TRANSCRIBE_MODELS) {
    const form = new FormData()
    const bytes = new Uint8Array(wav.byteLength)
    bytes.set(wav)
    form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'capture.wav')
    form.append('model', model)
    form.append('response_format', 'json')
    const res = await fetchWithProviderDeadline(fetchImpl, provider, opts.deadlineMs ?? TRANSCRIBE_DEADLINE_MS, `${auth.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: auth.headers,
      body: form,
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
    if (res.ok) {
      const parsed = (await res.json()) as { text?: unknown }
      if (typeof parsed.text !== 'string') throw new TranscribeError('openai', `${provider} answered without a transcript text (${model})`)
      return { text: parsed.text.trim(), kind: 'cloud', family: 'openai', model, ms: null }
    }
    const excerpt = await bodyExcerpt(res)
    lastRefusal = `${provider} ${model}: HTTP ${res.status}${excerpt !== '' ? ` — ${excerpt}` : ''}`
    const modelGone = res.status === 404 || (res.status === 400 && /model/i.test(excerpt))
    if (!modelGone) break
  }
  throw new TranscribeError('openai', lastRefusal)
}

export function geminiTranscribeModel(): string {
  try {
    const { providerFrontierFact } =
      require('../../utils/model/providerFrontier.js') as typeof import('../../utils/model/providerFrontier.js')
    const fact = providerFrontierFact('gemini')
    if (fact !== undefined && typeof fact.modelId === 'string' && fact.modelId !== '') return fact.modelId
  } catch {
  }
  return GEMINI_TRANSCRIBE_FALLBACK_MODEL
}

async function transcribeGemini(wav: Buffer, opts: TranscribeOptions): Promise<Transcript> {
  const env = opts.env ?? process.env
  const fetchImpl = opts.fetchImpl ?? fetch
  const { resolveGeminiRequestAuth } =
    require('../providers/gemini/geminiAccounts.js') as typeof import('../providers/gemini/geminiAccounts.js')
  const auth = await resolveGeminiRequestAuth({ env, sourceKind: 'api-key', fetchImpl })
  if (!auth) throw new TranscribeError('gemini', 'the Gemini API key left the store before the request — /logins gemini')
  const provider = providerDisplayName('gemini')
  const model = geminiTranscribeModel()
  const res = await fetchWithProviderDeadline(fetchImpl, provider, opts.deadlineMs ?? TRANSCRIBE_DEADLINE_MS, `${auth.baseUrl}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { ...auth.headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [{ text: GEMINI_TRANSCRIBE_PROMPT }, { inline_data: { mime_type: 'audio/wav', data: wav.toString('base64') } }],
        },
      ],
      generationConfig: { temperature: 0 },
    }),
    ...(opts.signal ? { signal: opts.signal } : {}),
  })
  if (!res.ok) {
    const excerpt = await bodyExcerpt(res)
    throw new TranscribeError('gemini', `${provider} ${model}: HTTP ${res.status}${excerpt !== '' ? ` — ${excerpt}` : ''}`)
  }
  const parsed = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> }
  const text = (parsed.candidates?.[0]?.content?.parts ?? [])
    .map(part => (typeof part.text === 'string' ? part.text : ''))
    .join('')
    .trim()
  if (text === '' && (parsed.candidates?.length ?? 0) === 0) throw new TranscribeError('gemini', `${provider} answered without a candidate (${model})`)
  return { text, kind: 'cloud', family: 'gemini', model, ms: null }
}


const loadedModels = new Map<string, number>()

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
  } catch {
  }
}

async function transcribeLocal(wav: Buffer, opts: TranscribeOptions): Promise<Transcript> {
  const read = readWav(wav)
  if (!read.ok) throw new TranscribeError('local', `the take is not a PCM WAV: ${read.reason}`)
  if (!isVoiceWavShape(read.header)) {
    throw new TranscribeError('local', `the take is ${read.header.sampleRate} Hz · ${read.header.channels} ch · ${read.header.bitsPerSample}-bit; the on-device transcriber decodes 16000 Hz · 1 ch · 16-bit`)
  }
  const load = loadWhisperAddon()
  if (load.state === 'unavailable') throw new TranscribeError('local', load.note)
  const model = checkWhisperModel()
  if (model.state !== 'present') throw new TranscribeError('local', model.state === 'absent' ? model.note : model.note)
  let handle: number
  try {
    handle = modelHandle(load.addon, model.path)
  } catch (error) {
    throw new TranscribeError('local', error instanceof Error ? error.message : String(error))
  }
  const audioMs = pcmDurationMs(read.pcm)
  const deadlineMs = opts.deadlineMs ?? localTranscribeDeadlineMs(audioMs)
  let timer: ReturnType<typeof setTimeout> | null = null
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TranscribeError('local', `the on-device transcriber did not answer within ${Math.round(deadlineMs / 1000)}s (${model.name})`)), deadlineMs)
    timer.unref?.()
  })
  try {
    const answer = await Promise.race([load.addon.transcribe(handle, Buffer.from(read.pcm), { language: model.language === 'en' ? 'en' : 'auto' }), bound])
    return { text: stripNonSpeechMarkers(answer.text), kind: 'local', family: null, model: model.name, ms: answer.ms }
  } catch (error) {
    if (error instanceof TranscribeError) throw error
    throw new TranscribeError('local', error instanceof Error ? error.message : String(error))
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

export async function transcribeWav(wav: Buffer, opts: TranscribeOptions): Promise<Transcript> {
  if (opts.choice.kind === 'local') return transcribeLocal(wav, opts)
  return opts.choice.family === 'openai' ? transcribeOpenai(wav, opts) : transcribeGemini(wav, opts)
}

export function unloadLocalModels(): void {
  if (loadedModels.size === 0) return
  try {
    const load = loadWhisperAddon()
    if (load.state === 'ok') {
      for (const handle of loadedModels.values()) {
        try {
          load.addon.unloadModel(handle)
        } catch {
        }
      }
    }
  } catch {
  }
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
