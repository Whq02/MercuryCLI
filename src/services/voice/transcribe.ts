import type { CallModelRoute } from '../providers/idSpaces.js'
import { fetchWithProviderDeadline } from '../providers/fetchDeadline.js'
import { providerDisplayName } from '../providers/routeLaw.js'

export const NO_TRANSCRIBER_RECEIPT = 'no sign-in transcribes yet — /logins openai (API key) or /logins gemini'

export const OPENAI_TRANSCRIBE_MODELS = ['gpt-4o-transcribe', 'whisper-1'] as const
export const GEMINI_TRANSCRIBE_FALLBACK_MODEL = 'gemini-2.5-flash'
export const GEMINI_TRANSCRIBE_PROMPT = 'Transcribe this audio verbatim. Output only the transcript, no commentary.'

export const TRANSCRIBE_DEADLINE_MS = 120_000

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

export interface TranscriberChoice {
  family: TranscribingFamily
  slot: 'api-key'
  label: string
}

export type TranscriberResolution =
  | { state: 'ok'; choice: TranscriberChoice; skipped: string[] }
  | { state: 'none'; note: string; skipped: string[] }

export interface TranscriberReads {
  openaiApiKeyLabel(): string | null
  geminiApiKeyLabel(): string | null
}

export function pickTranscriber(families: readonly string[], reads: TranscriberReads): TranscriberResolution {
  const skipped: string[] = []
  for (const family of families) {
    const rule = FAMILY_TRANSCRIBER[family as CallModelRoute]
    if (rule === undefined) continue
    if (rule.slot === 'none') {
      skipped.push(`${providerDisplayName(family as CallModelRoute)}: ${rule.why}`)
      continue
    }
    const label = family === 'openai' ? reads.openaiApiKeyLabel() : family === 'gemini' ? reads.geminiApiKeyLabel() : null
    if (label === null) {
      skipped.push(`${providerDisplayName(family as CallModelRoute)}: signed in without an API key (that slot does not transcribe)`)
      continue
    }
    return { state: 'ok', choice: { family: family as TranscribingFamily, slot: 'api-key', label }, skipped }
  }
  return { state: 'none', note: NO_TRANSCRIBER_RECEIPT, skipped }
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
  return pickTranscriber(liveFamilyOrder(), liveTranscriberReads(env))
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
  family: TranscribingFamily
  model: string
}

export class TranscribeError extends Error {
  readonly family: TranscribingFamily
  constructor(family: TranscribingFamily, message: string) {
    super(message)
    this.name = 'TranscribeError'
    this.family = family
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
      return { text: parsed.text.trim(), family: 'openai', model }
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
  return { text, family: 'gemini', model }
}

export async function transcribeWav(wav: Buffer, opts: TranscribeOptions): Promise<Transcript> {
  return opts.choice.family === 'openai' ? transcribeOpenai(wav, opts) : transcribeGemini(wav, opts)
}
