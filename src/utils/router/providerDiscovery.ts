// ============================================================================
//  router/providerDiscovery — the ASYNC bounded-cache discovery owner for the
//  specialist engines.
//
//  The registry/adapter surface (`status()`/`describe()`) is contractually
//  cheap+sync+never-network. Everything that touches the real world lives
//  HERE instead, behind an explicit async refresh:
//
// OpenAI: ACCOUNT-SOURCE presence — the Mercury-owned auth store
//      (.openai-auth.json subscription tokens) and/or an API key
//      (OPENAI_API_KEY env > the auth-scoped secret store). Local file/env
//      reads only — no executable, no probe, no network (the retired external
//      engine lane owned an executable pin + version probing; deleted it
//      with the runtime). Secret VALUES never enter a record — presence +
//      source labels only.
//    - Z.AI: API-key PRESENCE (env `ZAI_API_KEY` > the auth-scoped secret
//      store). Same value-never-recorded law.
//
//  Laws:
//    - Bounded cache: one record per provider, TTL'd (default 5 min),
//      single-flight.
//    - Reads are sync + free: `getCachedProviderDiscovery` returns the cached
//      record (possibly stale, labeled by `probedAtMs`) or null. Both probes
//      are local-only, so `primeZaiDiscovery`/`primeOpenaiDiscovery` let
//      status() self-serve a CURRENT record synchronously — there is no
//      'discovery-pending' state for either engine anymore.
//    - Deterministic in proofs: the `io` seam injects env; the auth-file read
//      follows the auth scope (setAuthScope), so proofs point at a
//      hermetic home. Explicit test reset; no module-load side effects.
// ============================================================================
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
  /** The resolved active account source — absent when none is connected.
   *  Never carries a secret (label/kind/plan facts only). */
  account?: OpenaiAccountRef
}

export interface ZaiDiscovery {
  provider: 'zai'
  probedAtMs: number
  keyPresent: boolean
  keySource?: 'env' | 'stored'
  /** A stored GLM Coding Plan key (dispatches on the Coding Plan base);
   *  absent for the general key and for an env key. */
  keyPlan?: 'coding'
}

/** OpenRouter — key PRESENCE across
 *  env OPENROUTER_API_KEY > the OAuth-minted key (.openrouter-auth.json) >
 *  the auth-scoped manual store. Local env/file reads only; the VALUE never
 *  enters a record. */
export interface OpenrouterDiscovery {
  provider: 'openrouter'
  probedAtMs: number
  keyPresent: boolean
  keySource?: 'env' | 'oauth' | 'stored'
}

/** Gemini — credential PRESENCE across
 *  Google OAuth tokens (.gemini-auth.json) and the key ladder (GOOGLE_API_KEY
 *  > GEMINI_API_KEY > stored — the documented client-library precedence).
 *  Same local-only + value-never-recorded laws. */
export interface GeminiDiscovery {
  provider: 'gemini'
  probedAtMs: number
  /** The resolved active account source — absent when none. Non-secret. */
  account?: { kind: 'oauth' | 'api-key'; label: string }
}

/** Provider-08-21 — the key-lane families share one record shape
 *  (presence + source label, never a value); moonshot adds the OAuth
 *  identity axis, the compat slot adds its configured/keyless axes. */
export interface MoonshotDiscovery {
  provider: 'moonshot'
  probedAtMs: number
  keyPresent: boolean
  keySource?: 'env' | 'stored'
  /** The account a dispatch would bill (env key > Kimi sign-in > stored
   *  key, from the OWNING resolver) — absent when none. Never a secret. */
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
  /** A base URL exists (the slot's configured axis). */
  configured: boolean
  keyPresent: boolean
  keySource?: 'env' | 'stored'
  /** The operator's display label for the slot (config words, no secret). */
  label?: string
}

/** Hugging Face — credential PRESENCE across env HF_TOKEN > the OAuth
 *  tokens (.huggingface-auth.json) > the auth-scoped pasted store. Local
 *  env/file reads only; the VALUE never enters a record. */
export interface HuggingfaceDiscovery {
  provider: 'huggingface'
  probedAtMs: number
  keyPresent: boolean
  keySource?: 'env' | 'oauth' | 'stored'
  /** The owning resolver's display words (identity, never a value). */
  accountLabel?: string
}

/** Locally served models — the record mirrors the localDiscovery SNAPSHOT
 *  (a network probe, bounded, owned there): serverPresent is "a server
 *  answered"; the async refresh here kicks that probe. */
export interface LocalDiscovery {
  provider: 'local'
  /** True once a real loopback discovery has run this process — false means
   *  NOTHING probed yet, and absence is 'discovery-pending', never a
   *  fabricated fresh 'no server' (the never-stale law, w1-f14-03). */
  probed: boolean
  /** The underlying SNAPSHOT's own probe time (0 when never probed) — this
   *  record is a cache read and must not claim a probe of its own. */
  probedAtMs: number
  serverPresent: boolean
  keyPresent: boolean
  keySource?: 'env' | 'stored'
  serverCount: number
  modelCount: number
  /** Display words ('Ollama 0.11.4 (3)'). */
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

/** Injectable real-world seam (proofs pass fakes; production uses defaults). */
export interface DiscoveryIo {
  env: Record<string, string | undefined>
  now(): number
}

function defaultIo(): DiscoveryIo {
  return {
    // child-env law: not a child — an own-process read seam (spawns nothing).
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

/** The ONE Z.AI key resolution: explicit env (ZAI_API_KEY) WINS over the
 *  auth-scoped secret store (providerSecrets.ts, S6). The VALUE never enters
 *  records, logs, or errors. */
export function resolveZaiApiKey(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const envKey = env.ZAI_API_KEY?.trim()
  if (envKey) return envKey
  return readStoredZaiApiKey()
}

/** Source label for display/readiness — never the value. */
export function zaiKeySource(
  env: Record<string, string | undefined> = process.env,
): 'env' | 'stored' | undefined {
  if (env.ZAI_API_KEY?.trim()) return 'env'
  return readStoredZaiApiKey() ? 'stored' : undefined
}

/** The ONE Z.AI dispatch resolution — the key AND the plan it is valid
 *  under (the stored key carries its plan; an env key has no plan record
 *  and rides the general base). The value never enters records. */
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

// ── The bounded cache (one record per provider) + single-flight ─────────────
const cache = new Map<RouterProviderId, ProviderDiscovery>()
const inFlight = new Map<RouterProviderId, Promise<ProviderDiscovery | null>>()

/** Sync cache read — free; null when never probed. */
export function getCachedProviderDiscovery(
  id: RouterProviderId,
): ProviderDiscovery | null {
  return cache.get(id) ?? null
}

/** Sync zai prime: the zai probe is env-only — no fs/exec/network
 *  — so `status()` can self-serve a CURRENT record without the async refresh
 *  dance. */
export function primeZaiDiscovery(io?: DiscoveryIo): ZaiDiscovery | null {
  const record = probeZai(io ?? defaultIo())
  cache.set('zai', record)
  return record
}

/** Sync openai prime: the account probe is local file/env only — same
 *  self-serve contract as zai. */
export function primeOpenaiDiscovery(io?: DiscoveryIo): OpenaiDiscovery | null {
  const record = probeOpenai(io ?? defaultIo())
  cache.set('openai', record)
  return record
}

/** Sync openrouter prime: env/file reads only — same self-serve contract. */
export function primeOpenrouterDiscovery(io?: DiscoveryIo): OpenrouterDiscovery | null {
  const record = probeOpenrouter(io ?? defaultIo())
  cache.set('openrouter', record)
  return record
}

/** Sync gemini prime: env/file reads only — same self-serve contract. */
export function primeGeminiDiscovery(io?: DiscoveryIo): GeminiDiscovery | null {
  const record = probeGemini(io ?? defaultIo())
  cache.set('gemini', record)
  return record
}

// ── Provider-08-21: the three new lanes (all local-only probes,
//    so each status() self-serves a CURRENT record synchronously). ─────────

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

/** The local record reads the discovery CACHE (sync, free); the probe
 *  itself runs through refreshProviderDiscovery('local'). THE HONEST STAMP
 *  (w1-f14-03): probedAtMs is the snapshot's OWN probe time — this reader
 *  never ran a probe, so it never claims one; before the first discovery
 *  the record says probed:false and the TTL compare treats it as stale, so
 *  the next bounded refresh runs a REAL probe. */
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

/** Async refresh honoring the TTL (force bypasses it). Single-flight per
 *  provider. 'anthropic' needs no discovery (main-loop credentials) and
 *  always returns null. */
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
    // Defer one microtask so the body cannot outrun inFlight.set below — a
    // fully-sync probe would otherwise run its finally BEFORE registration,
    // leaving a permanently-settled promise in inFlight that short-circuits
    // every later refresh (including force) to the stale first record.
    await Promise.resolve()
    try {
      if (id === 'local') {
        // The one network probe in this owner: bounded loopback discovery
        // (localDiscovery owns the timeouts); the record then reads its cache.
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

/** Proof seam — clears cache + in-flight state. */
export function __resetProviderDiscoveryForTest(): void {
  cache.clear()
  inFlight.clear()
}
