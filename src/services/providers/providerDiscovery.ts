import { readStoredZaiApiKey, readStoredZaiKeyPlan } from './providerSecrets.js'
import type { MoonshotAccountRef } from './moonshot/moonshotAccounts.js'
import type { ProviderFamilyId } from './providerAdapter.js'
import {
  resolveOpenaiAccount,
  type OpenaiAccountRef,
} from './openai/openaiAccounts.js'
import { openrouterKeySource } from './openrouter/openrouterAccounts.js'
import { resolveGeminiAccount } from './gemini/geminiAccounts.js'

export const PROVIDER_DISCOVERY_TTL_MS = 5 * 60_000

export interface OpenaiDiscovery {
  provider: 'openai'
  probedAtMs: number
  account?: OpenaiAccountRef
}

export interface ZaiDiscovery {
  provider: 'zai'
  probedAtMs: number
  keyPresent: boolean
  keySource?: 'env' | 'stored'
  keyPlan?: 'coding'
}

export interface OpenrouterDiscovery {
  provider: 'openrouter'
  probedAtMs: number
  keyPresent: boolean
  keySource?: 'env' | 'oauth' | 'stored'
}

export interface GeminiDiscovery {
  provider: 'gemini'
  probedAtMs: number
  account?: { kind: 'oauth' | 'api-key' | 'plan'; label: string }
}

export interface MoonshotDiscovery {
  provider: 'moonshot'
  probedAtMs: number
  keyPresent: boolean
  keySource?: 'env' | 'stored'
  account?: MoonshotAccountRef
}

export interface DeepseekDiscovery {
  provider: 'deepseek'
  probedAtMs: number
  keyPresent: boolean
  keySource?: 'env' | 'stored'
}

export interface XaiDiscovery {
  provider: 'xai'
  probedAtMs: number
  keyPresent: boolean
  keySource?: 'env' | 'stored' | 'oauth'
}

export interface MetaDiscovery {
  provider: 'meta'
  probedAtMs: number
  keyPresent: boolean
  keySource?: 'env' | 'stored' | 'muse-code'
}
export interface MistralDiscovery {
  provider: 'mistral'
  probedAtMs: number
  keyPresent: boolean
  keySource?: 'env' | 'stored'
}

export interface NousDiscovery {
  provider: 'nous'
  probedAtMs: number
  keyPresent: boolean
  keySource?: 'env' | 'stored' | 'signin'
}
export interface ZenDiscovery {
  provider: 'zen'
  probedAtMs: number
  keyPresent: boolean
  keySource?: 'env' | 'stored'
}
export interface MinimaxDiscovery {
  provider: 'minimax'
  probedAtMs: number
  keyPresent: boolean
  keySource?: 'env' | 'stored'
}
export interface TogetherDiscovery {
  provider: 'together'
  probedAtMs: number
  keyPresent: boolean
  keySource?: 'env' | 'stored'
}
export interface CohereDiscovery {
  provider: 'cohere'
  probedAtMs: number
  keyPresent: boolean
  keySource?: 'env' | 'stored'
}
export interface GroqDiscovery {
  provider: 'groq'
  probedAtMs: number
  keyPresent: boolean
  keySource?: 'env' | 'stored'
}
export interface CerebrasDiscovery {
  provider: 'cerebras'
  probedAtMs: number
  keyPresent: boolean
  keySource?: 'env' | 'stored'
}
export interface CompatDiscovery {
  provider: 'openai-compat'
  probedAtMs: number
  configured: boolean
  keyPresent: boolean
  keySource?: 'env' | 'stored'
  label?: string
}

export interface HuggingfaceDiscovery {
  provider: 'huggingface'
  probedAtMs: number
  keyPresent: boolean
  keySource?: 'env' | 'oauth' | 'stored'
  accountLabel?: string
}

export interface LocalDiscovery {
  provider: 'local'
  probed: boolean
  probedAtMs: number
  serverPresent: boolean
  keyPresent: boolean
  keySource?: 'env' | 'stored'
  serverCount: number
  modelCount: number
  label?: string
}

export type ProviderDiscovery =
  | OpenaiDiscovery
  | ZaiDiscovery
  | OpenrouterDiscovery
  | GeminiDiscovery
  | MoonshotDiscovery
  | DeepseekDiscovery
  | XaiDiscovery
  | MetaDiscovery
  | CompatDiscovery
  | HuggingfaceDiscovery
  | LocalDiscovery
  | MistralDiscovery
  | NousDiscovery
  | ZenDiscovery
  | MinimaxDiscovery
  | TogetherDiscovery
  | CohereDiscovery
  | GroqDiscovery
  | CerebrasDiscovery

export interface DiscoveryIo {
  env: Record<string, string | undefined>
  now(): number
}

function defaultIo(): DiscoveryIo {
  return {
    env: { ...process.env },
    now: () => Date.now(),
  }
}

function probeOpenai(io: DiscoveryIo): OpenaiDiscovery {
  const account = resolveOpenaiAccount(io.env as NodeJS.ProcessEnv)
  return {
    provider: 'openai',
    probedAtMs: io.now(),
    ...(account ? { account } : {}),
  }
}

export function resolveZaiApiKey(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const envKey = env.ZAI_API_KEY?.trim()
  if (envKey) return envKey
  return readStoredZaiApiKey()
}

export function zaiKeySource(
  env: Record<string, string | undefined> = process.env,
): 'env' | 'stored' | undefined {
  if (env.ZAI_API_KEY?.trim()) return 'env'
  return readStoredZaiApiKey() ? 'stored' : undefined
}

export function resolveZaiDispatch(
  env: Record<string, string | undefined> = process.env,
): { key: string; source: 'env' | 'stored'; plan: 'general' | 'coding' } | undefined {
  const envKey = env.ZAI_API_KEY?.trim()
  if (envKey) return { key: envKey, source: 'env', plan: 'general' }
  const stored = readStoredZaiApiKey()
  if (!stored) return undefined
  return { key: stored, source: 'stored', plan: readStoredZaiKeyPlan() === 'coding' ? 'coding' : 'general' }
}

function probeZai(io: DiscoveryIo): ZaiDiscovery {
  const dispatch = resolveZaiDispatch(io.env)
  return {
    provider: 'zai',
    probedAtMs: io.now(),
    keyPresent: dispatch !== undefined,
    ...(dispatch ? { keySource: dispatch.source } : {}),
    ...(dispatch?.plan === 'coding' ? { keyPlan: 'coding' as const } : {}),
  }
}

function probeOpenrouter(io: DiscoveryIo): OpenrouterDiscovery {
  const source = openrouterKeySource(io.env as NodeJS.ProcessEnv)
  return {
    provider: 'openrouter',
    probedAtMs: io.now(),
    keyPresent: source !== undefined,
    ...(source ? { keySource: source } : {}),
  }
}

function probeGemini(io: DiscoveryIo): GeminiDiscovery {
  const account = resolveGeminiAccount(io.env as NodeJS.ProcessEnv)
  return {
    provider: 'gemini',
    probedAtMs: io.now(),
    ...(account ? { account: { kind: account.kind, label: account.label } } : {}),
  }
}

const cache = new Map<ProviderFamilyId, ProviderDiscovery>()
const inFlight = new Map<ProviderFamilyId, Promise<ProviderDiscovery | null>>()

export function getCachedProviderDiscovery(
  id: ProviderFamilyId,
): ProviderDiscovery | null {
  return cache.get(id) ?? null
}

export function primeZaiDiscovery(io?: DiscoveryIo): ZaiDiscovery | null {
  const record = probeZai(io ?? defaultIo())
  cache.set('zai', record)
  return record
}

export function primeOpenaiDiscovery(io?: DiscoveryIo): OpenaiDiscovery | null {
  const record = probeOpenai(io ?? defaultIo())
  cache.set('openai', record)
  return record
}

export function primeOpenrouterDiscovery(io?: DiscoveryIo): OpenrouterDiscovery | null {
  const record = probeOpenrouter(io ?? defaultIo())
  cache.set('openrouter', record)
  return record
}

export function primeGeminiDiscovery(io?: DiscoveryIo): GeminiDiscovery | null {
  const record = probeGemini(io ?? defaultIo())
  cache.set('gemini', record)
  return record
}


function probeMoonshot(io: DiscoveryIo): MoonshotDiscovery {
  const {
    resolveMoonshotApiKey,
    resolveMoonshotAccount,
  } = require('./moonshot/moonshotAccounts.js') as typeof import('./moonshot/moonshotAccounts.js')
  const key = resolveMoonshotApiKey(io.env)
  const account = resolveMoonshotAccount(io.env as NodeJS.ProcessEnv)
  return {
    provider: 'moonshot',
    probedAtMs: io.now(),
    keyPresent: key !== undefined,
    ...(key ? { keySource: key.source } : {}),
    ...(account ? { account } : {}),
  }
}

function probeMeta(io: DiscoveryIo): MetaDiscovery {
  const { resolveMetaApiKey } = require('./meta/metaAccounts.js') as typeof import('./meta/metaAccounts.js')
  const key = resolveMetaApiKey(io.env)
  return { provider: 'meta', probedAtMs: io.now(), keyPresent: key !== undefined, ...(key ? { keySource: key.source } : {}) }
}

function probeMistral(io: DiscoveryIo): MistralDiscovery {
  const { resolveMistralApiKey } = require('./mistral/mistralAccounts.js') as typeof import('./mistral/mistralAccounts.js')
  const key = resolveMistralApiKey(io.env)
  return { provider: 'mistral', probedAtMs: io.now(), keyPresent: key !== undefined, ...(key ? { keySource: key.source } : {}) }
}

function probeNous(io: DiscoveryIo): NousDiscovery {
  const { resolveNousCredentialSnapshot } = require('./nous/nousAccounts.js') as typeof import('./nous/nousAccounts.js')
  const key = resolveNousCredentialSnapshot(io.env)
  return { provider: 'nous', probedAtMs: io.now(), keyPresent: key !== undefined, ...(key ? { keySource: key.source } : {}) }
}

export function primeNousDiscovery(io?: DiscoveryIo): NousDiscovery | null {
  const record = probeNous(io ?? defaultIo())
  cache.set('nous', record)
  return record
}

function probeMinimax(io: DiscoveryIo): MinimaxDiscovery {
  const { resolveMinimaxApiKey } = require('../../services/providers/minimax/minimaxAccounts.js') as typeof import('../../services/providers/minimax/minimaxAccounts.js')
  const key = resolveMinimaxApiKey(io.env as NodeJS.ProcessEnv)
  return { provider: 'minimax', probedAtMs: io.now(), keyPresent: key !== undefined, ...(key ? { keySource: key.source } : {}) }
}

function probeTogether(io: DiscoveryIo): TogetherDiscovery {
  const { resolveTogetherApiKey } = require('../../services/providers/together/togetherAccounts.js') as typeof import('../../services/providers/together/togetherAccounts.js')
  const key = resolveTogetherApiKey(io.env as NodeJS.ProcessEnv)
  return { provider: 'together', probedAtMs: io.now(), keyPresent: key !== undefined, ...(key ? { keySource: key.source } : {}) }
}

function probeCohere(io: DiscoveryIo): CohereDiscovery {
  const { resolveCohereApiKey } = require('../../services/providers/cohere/cohereAccounts.js') as typeof import('../../services/providers/cohere/cohereAccounts.js')
  const key = resolveCohereApiKey(io.env as NodeJS.ProcessEnv)
  return { provider: 'cohere', probedAtMs: io.now(), keyPresent: key !== undefined, ...(key ? { keySource: key.source } : {}) }
}

function probeGroq(io: DiscoveryIo): GroqDiscovery {
  const { resolveGroqApiKey } = require('./groq/groqAccounts.js') as typeof import('./groq/groqAccounts.js')
  const key = resolveGroqApiKey(io.env as NodeJS.ProcessEnv)
  return { provider: 'groq', probedAtMs: io.now(), keyPresent: key !== undefined, ...(key ? { keySource: key.source } : {}) }
}
function probeCerebras(io: DiscoveryIo): CerebrasDiscovery {
  const { resolveCerebrasApiKey } = require('./cerebras/cerebrasAccounts.js') as typeof import('./cerebras/cerebrasAccounts.js')
  const key = resolveCerebrasApiKey(io.env as NodeJS.ProcessEnv)
  return { provider: 'cerebras', probedAtMs: io.now(), keyPresent: key !== undefined, ...(key ? { keySource: key.source } : {}) }
}
function probeZen(io: DiscoveryIo): ZenDiscovery {
  const { resolveZenApiKey } = require('./zen/zenAccounts.js') as typeof import('./zen/zenAccounts.js')
  const key = resolveZenApiKey(io.env as NodeJS.ProcessEnv)
  return { provider: 'zen', probedAtMs: io.now(), keyPresent: key !== undefined, ...(key ? { keySource: key.source } : {}) }
}

function probeDeepseek(io: DiscoveryIo): DeepseekDiscovery {
  const { resolveDeepseekApiKey } =
    require('./deepseek/deepseekAccounts.js') as typeof import('./deepseek/deepseekAccounts.js')
  const key = resolveDeepseekApiKey(io.env)
  return {
    provider: 'deepseek',
    probedAtMs: io.now(),
    keyPresent: key !== undefined,
    ...(key ? { keySource: key.source } : {}),
  }
}

function probeXai(io: DiscoveryIo): XaiDiscovery {
  const { resolveXaiCredentialSnapshot } = require('./xai/xaiAccounts.js') as typeof import('./xai/xaiAccounts.js')
  const key = resolveXaiCredentialSnapshot(io.env)
  return { provider: 'xai', probedAtMs: io.now(), keyPresent: key !== undefined, ...(key ? { keySource: key.source } : {}) }
}

export function primeXaiDiscovery(io?: DiscoveryIo): XaiDiscovery | null {
  const record = probeXai(io ?? defaultIo())
  cache.set('xai', record)
  return record
}

function probeCompat(io: DiscoveryIo): CompatDiscovery {
  const {
    resolveCompatSlotConfig,
    resolveCompatApiKey,
  } = require('./openaicompat/compatAccounts.js') as typeof import('./openaicompat/compatAccounts.js')
  const config = resolveCompatSlotConfig(io.env as NodeJS.ProcessEnv)
  const key = resolveCompatApiKey(io.env)
  return {
    provider: 'openai-compat',
    probedAtMs: io.now(),
    configured: config !== undefined,
    keyPresent: key !== undefined,
    ...(key ? { keySource: key.source } : {}),
    ...(config ? { label: config.label } : {}),
  }
}

export function primeMoonshotDiscovery(io?: DiscoveryIo): MoonshotDiscovery | null {
  const record = probeMoonshot(io ?? defaultIo())
  cache.set('moonshot', record)
  return record
}

export function primeDeepseekDiscovery(io?: DiscoveryIo): DeepseekDiscovery | null {
  const record = probeDeepseek(io ?? defaultIo())
  cache.set('deepseek', record)
  return record
}

export function primeCompatDiscovery(io?: DiscoveryIo): CompatDiscovery | null {
  const record = probeCompat(io ?? defaultIo())
  cache.set('openai-compat', record)
  return record
}

function probeHuggingface(io: DiscoveryIo): HuggingfaceDiscovery {
  const { resolveHuggingfaceAccount } =
    require('./huggingface/huggingfaceAccounts.js') as typeof import('./huggingface/huggingfaceAccounts.js')
  const account = resolveHuggingfaceAccount(io.env as NodeJS.ProcessEnv)
  return {
    provider: 'huggingface',
    probedAtMs: io.now(),
    keyPresent: account !== undefined,
    ...(account ? { keySource: account.keySource, accountLabel: account.label } : {}),
  }
}

function probeLocal(io: DiscoveryIo): LocalDiscovery {
  const { resolveLocalAccount, resolveLocalApiKey } =
    require('./local/localAccounts.js') as typeof import('./local/localAccounts.js')
  const { getCachedLocalDiscovery } =
    require('./local/localDiscovery.js') as typeof import('./local/localDiscovery.js')
  const snapshot = getCachedLocalDiscovery()
  const account = resolveLocalAccount(io.env as NodeJS.ProcessEnv)
  const key = resolveLocalApiKey(io.env)
  return {
    provider: 'local',
    probed: snapshot !== null,
    probedAtMs: snapshot?.probedAtMs ?? 0,
    serverPresent: account !== undefined,
    keyPresent: key !== undefined,
    ...(key ? { keySource: key.source } : {}),
    serverCount: account?.serverCount ?? 0,
    modelCount: account?.modelCount ?? 0,
    ...(account ? { label: account.label } : {}),
  }
}

export function primeHuggingfaceDiscovery(io?: DiscoveryIo): HuggingfaceDiscovery | null {
  const record = probeHuggingface(io ?? defaultIo())
  cache.set('huggingface', record)
  return record
}

export function primeLocalDiscovery(io?: DiscoveryIo): LocalDiscovery | null {
  const record = probeLocal(io ?? defaultIo())
  cache.set('local', record)
  return record
}

export function refreshProviderDiscovery(
  id: ProviderFamilyId,
  opts?: { force?: boolean; io?: DiscoveryIo },
): Promise<ProviderDiscovery | null> {
  if (id === 'anthropic') return Promise.resolve(null)
  const io = opts?.io ?? defaultIo()
  const cached = cache.get(id)
  if (!opts?.force && cached && io.now() - cached.probedAtMs < PROVIDER_DISCOVERY_TTL_MS) {
    return Promise.resolve(cached)
  }
  const existing = inFlight.get(id)
  if (existing) return existing
  const work = (async (): Promise<ProviderDiscovery | null> => {
    await Promise.resolve()
    try {
      if (id === 'local') {
        const { refreshLocalDiscovery } =
          require('./local/localDiscovery.js') as typeof import('./local/localDiscovery.js')
        await refreshLocalDiscovery({ ...(opts?.force ? { force: true } : {}), env: io.env as NodeJS.ProcessEnv }).catch(() => undefined)
      }
      const record =
        id === 'openai'
          ? probeOpenai(io)
          : id === 'openrouter'
            ? probeOpenrouter(io)
            : id === 'gemini'
              ? probeGemini(io)
              : id === 'moonshot'
                ? probeMoonshot(io)
                : id === 'deepseek'
                  ? probeDeepseek(io)
                  : id === 'xai'
                    ? probeXai(io)
                    : id === 'meta'
                      ? probeMeta(io)
                      : id === 'openai-compat'
                        ? probeCompat(io)
                        : id === 'huggingface'
                          ? probeHuggingface(io)
                          : id === 'local'
                            ? probeLocal(io)
                            : id === 'mistral'
                              ? probeMistral(io)
                              : id === 'nous'
                                ? probeNous(io)
                                : id === 'zen'
                                  ? probeZen(io)
                                  : id === 'minimax'
                                    ? probeMinimax(io)
                                    : id === 'together'
                                      ? probeTogether(io)
                                      : id === 'cohere'
                                        ? probeCohere(io)
                                        : id === 'groq'
                                          ? probeGroq(io)
                                          : id === 'cerebras'
                                            ? probeCerebras(io)
                                            : probeZai(io)
      cache.set(id, record)
      return record
    } finally {
      inFlight.delete(id)
    }
  })()
  inFlight.set(id, work)
  return work
}

export function __resetProviderDiscoveryForTest(): void {
  cache.clear()
  inFlight.clear()
}
