import { readStoredZaiApiKey, readStoredZaiKeyPlan } from './providerSecrets.js'
import type { MoonshotAccountRef } from '../../services/providers/moonshot/moonshotAccounts.js'
import type { RouterProviderId } from './providers/types.js'
import {
  resolveOpenaiAccount,
  type OpenaiAccountRef,
} from '../../services/providers/openai/openaiAccounts.js'
import { openrouterKeySource } from '../../services/providers/openrouter/openrouterAccounts.js'
import { resolveGeminiAccount } from '../../services/providers/gemini/geminiAccounts.js'

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
  account?: { kind: 'oauth' | 'api-key'; label: string }
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
  | CompatDiscovery
  | HuggingfaceDiscovery
  | LocalDiscovery

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

const cache = new Map<RouterProviderId, ProviderDiscovery>()
const inFlight = new Map<RouterProviderId, Promise<ProviderDiscovery | null>>()

export function getCachedProviderDiscovery(
  id: RouterProviderId,
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
  } = require('../../services/providers/moonshot/moonshotAccounts.js') as typeof import('../../services/providers/moonshot/moonshotAccounts.js')
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

function probeDeepseek(io: DiscoveryIo): DeepseekDiscovery {
  const { resolveDeepseekApiKey } =
    require('../../services/providers/deepseek/deepseekAccounts.js') as typeof import('../../services/providers/deepseek/deepseekAccounts.js')
  const key = resolveDeepseekApiKey(io.env)
  return {
    provider: 'deepseek',
    probedAtMs: io.now(),
    keyPresent: key !== undefined,
    ...(key ? { keySource: key.source } : {}),
  }
}

function probeCompat(io: DiscoveryIo): CompatDiscovery {
  const {
    resolveCompatSlotConfig,
    resolveCompatApiKey,
  } = require('../../services/providers/openaicompat/compatAccounts.js') as typeof import('../../services/providers/openaicompat/compatAccounts.js')
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
    require('../../services/providers/huggingface/huggingfaceAccounts.js') as typeof import('../../services/providers/huggingface/huggingfaceAccounts.js')
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
    require('../../services/providers/local/localAccounts.js') as typeof import('../../services/providers/local/localAccounts.js')
  const { getCachedLocalDiscovery } =
    require('../../services/providers/local/localDiscovery.js') as typeof import('../../services/providers/local/localDiscovery.js')
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
  id: RouterProviderId,
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
          require('../../services/providers/local/localDiscovery.js') as typeof import('../../services/providers/local/localDiscovery.js')
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
                  : id === 'openai-compat'
                    ? probeCompat(io)
                    : id === 'huggingface'
                      ? probeHuggingface(io)
                      : id === 'local'
                        ? probeLocal(io)
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
