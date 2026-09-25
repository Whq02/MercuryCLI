import { MODEL_ALIASES } from '../../utils/model/aliases.js'

export type CallModelRoute =
  | 'anthropic'
  | 'zai'
  | 'openai'
  | 'moonshot'
  | 'deepseek'
  | 'openai-compat'
  | 'openrouter'
  | 'gemini'
  | 'huggingface'
  | 'local'

export interface ProviderIdSpace {
  route: Exclude<CallModelRoute, 'anthropic'>
  qualifiedPrefix?: string
  barePrefixes?: readonly string[]
  bareAliases?: readonly string[]
  innerGrammar?: 'segments-2' | 'named'
}

export const PROVIDER_ID_SPACES: readonly ProviderIdSpace[] = [
  { route: 'openai-compat', qualifiedPrefix: 'compat/', innerGrammar: 'named' },
  { route: 'openrouter', qualifiedPrefix: 'openrouter/', innerGrammar: 'segments-2' },
  { route: 'huggingface', qualifiedPrefix: 'huggingface/', innerGrammar: 'segments-2' },
  { route: 'local', qualifiedPrefix: 'local/', innerGrammar: 'named' },
  { route: 'zai', barePrefixes: ['glm-'], bareAliases: ['glm'] },
  { route: 'openai', barePrefixes: ['gpt-'], bareAliases: ['gpt'] },
  { route: 'moonshot', barePrefixes: ['kimi-', 'moonshot-'], bareAliases: ['kimi'] },
  { route: 'deepseek', barePrefixes: ['deepseek-'], bareAliases: ['deepseek'] },
  { route: 'gemini', barePrefixes: ['gemini-'], bareAliases: ['gemini'] },
]

export const COMPAT_MODEL_PREFIX = 'compat/'

export type LiveListFamily = 'moonshot' | 'deepseek' | 'openai' | 'gemini'

export const LIVE_LIST_FAMILIES: readonly LiveListFamily[] = ['moonshot', 'deepseek', 'openai', 'gemini']

type LiveIdsReader = { cachedLiveIds?: (env?: NodeJS.ProcessEnv) => ReadonlySet<string> }

function liveIdsReaderOf(family: LiveListFamily): LiveIdsReader {
  switch (family) {
    case 'moonshot':
      return require('./moonshot/moonshotCatalogue.js') as LiveIdsReader
    case 'deepseek':
      return require('./deepseek/deepseekCatalogue.js') as LiveIdsReader
    case 'openai':
      return require('./openai/openaiCatalogue.js') as LiveIdsReader
    case 'gemini':
      return require('./gemini/geminiCatalogue.js') as LiveIdsReader
  }
}

export function cachedLiveIdsOf(family: LiveListFamily, env: Record<string, string | undefined> = process.env): ReadonlySet<string> | undefined {
  try {
    return liveIdsReaderOf(family).cachedLiveIds?.(env as NodeJS.ProcessEnv)
  } catch {
    return undefined
  }
}

export function liveListedRouteOf(
  model: string,
  env: Record<string, string | undefined> = process.env,
): LiveListFamily | undefined {
  const lowered = model.trim().replace(ANNOTATION_RE, '').toLowerCase()
  if (lowered === '' || lowered.includes('/')) return undefined
  for (const family of LIVE_LIST_FAMILIES) {
    if (cachedLiveIdsOf(family, env)?.has(lowered)) return family
  }
  return undefined
}

export function qualifiedIdSpaceOf(model: string): ProviderIdSpace | undefined {
  const lowered = model.trim().toLowerCase()
  return PROVIDER_ID_SPACES.find(
    space => space.qualifiedPrefix !== undefined && lowered.startsWith(space.qualifiedPrefix),
  )
}

export function isQualifiedProviderId(model: string): boolean {
  return qualifiedIdSpaceOf(model) !== undefined
}

export function isCarrierShapedId(model: string): boolean {
  return model.includes('/') || qualifiedIdSpaceOf(model) !== undefined
}


export const FIRST_PARTY_ID_MARK = 'claude-'

const FIRST_PARTY_ALIASES: ReadonlySet<string> = new Set([
  ...MODEL_ALIASES.map(alias => alias.replace(/\[1m\]$/i, '')),
  'sonnet5',
  'opus5',
  'opus55',
])

export const FIRST_PARTY_MODEL_ENV_PINS = [
  'MERCURY_MODEL',
  'MERCURY_DEFAULT_OPUS_MODEL',
  'MERCURY_DEFAULT_SONNET_MODEL',
  'MERCURY_DEFAULT_HAIKU_MODEL',
  'MERCURY_DEFAULT_FABLE_MODEL',
  'MERCURY_SMALL_FAST_MODEL',
  'MERCURY_CUSTOM_MODEL_OPTION',
] as const

const ANNOTATION_RE = /\[(?:[0-9]+m|served)\]/gi

export type ModelIdRecognition =
  | { kind: 'declared'; route: Exclude<CallModelRoute, 'anthropic'> }
  | { kind: 'first-party'; why: 'claude-mark' | 'alias' | 'env-pin'; envPin?: string }
  | { kind: 'carrier-shaped' }
  | { kind: 'unrecognised' }

export function recognizeModelId(
  model: string,
  env: Record<string, string | undefined> = process.env,
): ModelIdRecognition {
  const bare = model.trim().replace(ANNOTATION_RE, '')
  const lowered = bare.toLowerCase()
  const qualified = qualifiedIdSpaceOf(lowered)
  if (qualified !== undefined) return { kind: 'declared', route: qualified.route }
  const listed = liveListedRouteOf(lowered, env)
  if (listed !== undefined) return { kind: 'declared', route: listed }
  for (const space of PROVIDER_ID_SPACES) {
    if (space.bareAliases?.includes(lowered)) return { kind: 'declared', route: space.route }
    if (space.barePrefixes?.some(prefix => lowered.startsWith(prefix))) {
      return { kind: 'declared', route: space.route }
    }
  }
  if (lowered.includes('/')) return { kind: 'carrier-shaped' }
  for (const pin of FIRST_PARTY_MODEL_ENV_PINS) {
    const value = env[pin]?.trim().replace(ANNOTATION_RE, '').toLowerCase()
    if (value !== undefined && value !== '' && value === lowered) {
      return { kind: 'first-party', why: 'env-pin', envPin: pin }
    }
  }
  if (FIRST_PARTY_ALIASES.has(lowered)) return { kind: 'first-party', why: 'alias' }
  if (lowered.includes(FIRST_PARTY_ID_MARK)) return { kind: 'first-party', why: 'claude-mark' }
  return { kind: 'unrecognised' }
}


export type ModelRouteVerdict =
  | { kind: 'route'; route: CallModelRoute; why?: 'claude-mark' | 'alias' | 'env-pin' }
  | { kind: 'unrecognised'; carrierShaped: boolean }
  | { kind: 'absence' }

export function classifyModelRoute(
  model: string | undefined,
  env: Record<string, string | undefined> = process.env,
): ModelRouteVerdict {
  if (model === undefined || model.trim() === '') return { kind: 'absence' }
  const recognition = recognizeModelId(model, env)
  switch (recognition.kind) {
    case 'declared':
      return { kind: 'route', route: recognition.route }
    case 'first-party':
      return { kind: 'route', route: 'anthropic', why: recognition.why }
    case 'carrier-shaped':
      return { kind: 'unrecognised', carrierShaped: true }
    case 'unrecognised':
      return { kind: 'unrecognised', carrierShaped: false }
  }
}

export function declaredIdSpacesLine(): string {
  const families = PROVIDER_ID_SPACES.map(space =>
    space.qualifiedPrefix !== undefined
      ? `${space.qualifiedPrefix}…`
      : (space.barePrefixes ?? []).map(prefix => `${prefix}*`).join('/'),
  )
  return [`${FIRST_PARTY_ID_MARK}* (and the opus/sonnet/haiku/fable aliases)`, ...families].join(' · ')
}

export function unrecognisedModelIdReason(model: string): string {
  return `'${model.trim()}' is not a model id any provider family declares (${declaredIdSpacesLine()}); only an operator-owned fact puts it on the home wire — an ANTHROPIC_* model pin naming it, or ANTHROPIC_BASE_URL re-pointed at a gateway that serves it`
}
