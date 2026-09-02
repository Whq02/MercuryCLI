// ============================================================================
//  router/providerSecrets — the engines' secret store (S6; adds
//  the OpenAI API key beside the Z.AI one — same file, same laws).
//
//  Engine API keys at rest. Laws:
//    - the file follows the AUTH SCOPE (getAuthConfigHomeDir — the
//      .credentials.json precedent), so per-home isolation holds and a
//      scoped bracket reads its own store; NEVER the global config monolith
//      (`.mercury<suffix>.json`), never the Anthropic keychain/OAuth machinery
//      (that plane is Anthropic-credential shaped);
//    - mode 600 on every write; the file holds ONLY engine secrets
//      (versioned shape, unknown keys preserved on rewrite);
//    - resolution precedence: explicit env (ZAI_API_KEY) WINS over the
//      store — an env pin is the operator's louder word;
//    - the VALUE never enters logs, errors, discovery records, or UI —
//      presence + source label only (providerDiscovery's law).
//  Recorded follow-up: macOS-keychain residence for this store (the
//  credentials file's keychain-first pattern) is a hardening step, not a
//  correctness gap — the file plane IS the documented secure-storage
//  fallback plane.
// ============================================================================
import { chmodSync, copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DurablePublishError, durableAtomicPublishSync } from '../../substrate/durablePublish.js'
import { recordSignIn } from '../accounts/signInLedger.js'
import { getAuthConfigHomeDir } from '../envUtils.js'
import { getErrnoCode } from '../errors.js'

const PROVIDER_SECRETS_VERSION = 1
const FILE_NAME = '.provider-secrets.json'

/** The Z.AI key's plan — a fact ABOUT the stored key (a GLM Coding Plan key
 *  is valid only on the Coding Plan base), so it lives beside the key and
 *  clears with it; absent = the general API key. */
export type ZaiKeyPlan = 'coding'

interface ProviderSecretsFile {
  version: number
  zaiApiKey?: string
  zaiKeyPlan?: ZaiKeyPlan
  openaiApiKey?: string
  openrouterApiKey?: string
  geminiApiKey?: string
  moonshotApiKey?: string
  deepseekApiKey?: string
  compatApiKey?: string
  huggingfaceApiKey?: string
  localApiKey?: string
  /** Web-search API keys — NON-model credentials, the same store and laws
   *  (the search estate's keyed door; services/search). */
  braveSearchApiKey?: string
  tavilyApiKey?: string
  [k: string]: unknown
}

function secretsPath(): string {
  return join(getAuthConfigHomeDir(), FILE_NAME)
}

function readFile(): ProviderSecretsFile | null {
  try {
    const raw = readFileSync(secretsPath(), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null) return null
    return parsed as ProviderSecretsFile
  } catch {
    return null
  }
}

/** The bytes at rest, read fresh and classified: what a writer may replace. */
type SecretsProbe =
  | { state: 'absent' }
  | { state: 'ok'; file: ProviderSecretsFile }
  | { state: 'unparseable' }
  | { state: 'unreadable'; code: string; message: string }

function probeSecrets(path: string): SecretsProbe {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    const code = getErrnoCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') return { state: 'absent' }
    return {
      state: 'unreadable',
      code: code ?? 'EUNKNOWN',
      message: error instanceof Error ? error.message : String(error),
    }
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null) return { state: 'unparseable' }
    return { state: 'ok', file: parsed as ProviderSecretsFile }
  } catch {
    return { state: 'unparseable' }
  }
}

/**
 * The ONE publish road for every writer below (release-hardening audit
 * rank 15). Each writer is a read-modify-write of one field, and readFile()
 * answers null for ABSENT, UNREADABLE and UNPARSEABLE alike — so a writer
 * that trusted that null rewrote the file with only its own field, dropping
 * every other engine key and both search keys with no message. Here the
 * bytes are read fresh and classified: an existing file that cannot be
 * read REFUSES the write (the errno rides on the thrown error's `code`);
 * unparseable bytes are quarantined beside the store before the rewrite;
 * and the publish is the durable atomic writer at mode 0600 — a flushed
 * temp sibling plus the bounded win32-retry rename — never a truncating
 * in-place write that an interruption leaves empty. Throws on any refusal
 * or write failure — the caller surfaces it (a silent secret-write failure
 * would lie about readiness). The VALUE never enters the message.
 */
function publishSecrets(mutate: (next: ProviderSecretsFile) => void): void {
  const dir = getAuthConfigHomeDir()
  mkdirSync(dir, { recursive: true })
  const path = secretsPath()
  const probe = probeSecrets(path)
  if (probe.state === 'unreadable') {
    throw Object.assign(
      new Error(
        `The provider secrets store at ${path} exists but could not be read (${probe.code}); nothing was written. ${probe.message}`,
      ),
      { code: probe.code },
    )
  }
  if (probe.state === 'unparseable') {
    const copy = `${path}.corrupt.${Date.now()}`
    try {
      copyFileSync(path, copy)
      try {
        chmodSync(copy, 0o600)
      } catch {
        /* best-effort on non-POSIX */
      }
    } catch {
      /* quarantine is best-effort; the rewrite still lands */
    }
  }
  const existing: ProviderSecretsFile = probe.state === 'ok' ? probe.file : { version: PROVIDER_SECRETS_VERSION }
  const next: ProviderSecretsFile = { ...existing, version: PROVIDER_SECRETS_VERSION }
  mutate(next)
  try {
    durableAtomicPublishSync(path, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  } catch (error) {
    const code = error instanceof DurablePublishError ? error.fsCode : getErrnoCode(error)
    throw Object.assign(
      new Error(
        `Could not write the provider secrets store at ${path}${code ? ` (${code})` : ''}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
      code ? { code } : {},
    )
  }
  try {
    chmodSync(path, 0o600) // the temp was created at 0600; belt and braces on an existing inode's replacement
  } catch {
    /* best-effort on non-POSIX */
  }
}

/** The stored Z.AI key, or undefined. Sync + cheap (one small file read). */
export function readStoredZaiApiKey(): string | undefined {
  const file = readFile()
  const key = typeof file?.zaiApiKey === 'string' ? file.zaiApiKey.trim() : ''
  return key || undefined
}

/** The stored Z.AI key's plan: 'coding' for a GLM Coding Plan key, undefined
 *  for the general key (or no key). */
export function readStoredZaiKeyPlan(): ZaiKeyPlan | undefined {
  const file = readFile()
  return file?.zaiKeyPlan === 'coding' && readStoredZaiApiKey() !== undefined ? 'coding' : undefined
}

/** Write (or clear, with null) the stored Z.AI key, with the plan it was
 *  minted under (the plan clears with the key). Mode 600; unknown keys in
 *  the file are preserved. Throws on write failure — the caller surfaces
 *  it (a silent secret-write failure would lie about readiness). */
export function writeStoredZaiApiKey(key: string | null, plan?: ZaiKeyPlan): void {
  publishSecrets(next => {
    if (key === null || key.trim() === '') {
      delete next.zaiApiKey
      delete next.zaiKeyPlan
    } else {
      next.zaiApiKey = key.trim()
      if (plan === 'coding') next.zaiKeyPlan = 'coding'
      else delete next.zaiKeyPlan
    }
  })
  // A landed key IS the family's sign-in (the ledger the computed default
  // orders by); a clear is not, and a failed publish threw before this line.
  if (key !== null && key.trim() !== '') recordSignIn('zai', 'api-key')
}

/** The stored OpenAI API key, or undefined. Env OPENAI_API_KEY wins at
 *  the resolver (openaiAccounts.ts) — this is only the at-rest store. */
export function readStoredOpenaiApiKey(): string | undefined {
  const file = readFile()
  const key = typeof file?.openaiApiKey === 'string' ? file.openaiApiKey.trim() : ''
  return key || undefined
}

/** Write (or clear, with null) the stored OpenAI API key — same laws as the
 *  Z.AI writer (mode 600, unknown keys preserved, throws on write failure). */
export function writeStoredOpenaiApiKey(key: string | null): void {
  publishSecrets(next => {
    if (key === null || key.trim() === '') delete next.openaiApiKey
    else next.openaiApiKey = key.trim()
  })
  if (key !== null && key.trim() !== '') recordSignIn('openai', 'api-key')
}

// ── The key-lane secret slots — same laws
//    (mode 600, unknown keys preserved, env pins win at the owning
//    resolver), one generic read/write pair; each family costs two thin
//    wrappers. ────────

type StoredKeyField =
  | 'moonshotApiKey'
  | 'deepseekApiKey'
  | 'compatApiKey'
  | 'openrouterApiKey'
  | 'geminiApiKey'
  | 'huggingfaceApiKey'
  | 'localApiKey'
  | 'braveSearchApiKey'
  | 'tavilyApiKey'

function readStoredKey(field: StoredKeyField): string | undefined {
  const file = readFile()
  const key = typeof file?.[field] === 'string' ? (file[field] as string).trim() : ''
  return key || undefined
}

/** The model family each stored key credentials — a landed key is that
 *  family's sign-in, recorded in the sign-in ledger the computed default
 *  orders by. The two web-search keys credential no model family, so a
 *  search key never moves the default. */
const KEY_FIELD_FAMILY: Partial<Record<StoredKeyField, string>> = {
  moonshotApiKey: 'moonshot',
  deepseekApiKey: 'deepseek',
  compatApiKey: 'openai-compat',
  openrouterApiKey: 'openrouter',
  geminiApiKey: 'gemini',
  huggingfaceApiKey: 'huggingface',
  localApiKey: 'local',
}

function writeStoredKey(field: StoredKeyField, key: string | null): void {
  publishSecrets(next => {
    if (key === null || key.trim() === '') delete next[field]
    else next[field] = key.trim()
  })
  const family = KEY_FIELD_FAMILY[field]
  if (family !== undefined && key !== null && key.trim() !== '') recordSignIn(family, 'api-key')
}

/** The stored OpenRouter API key (the MANUAL paste store — the OAuth-minted
 *  key rests with openrouterAccounts' own auth file), or undefined. Env
 *  OPENROUTER_API_KEY wins at the resolver (openrouterAccounts.ts). */
export function readStoredOpenrouterApiKey(): string | undefined {
  return readStoredKey('openrouterApiKey')
}

/** Write (or clear, with null) the stored OpenRouter API key. */
export function writeStoredOpenrouterApiKey(key: string | null): void {
  writeStoredKey('openrouterApiKey', key)
}

/** The stored Gemini API key, or undefined. Env wins at the resolver
 *  (geminiAccounts.ts — GOOGLE_API_KEY over GEMINI_API_KEY, the documented
 *  client-library precedence, over the store). */
export function readStoredGeminiApiKey(): string | undefined {
  return readStoredKey('geminiApiKey')
}

/** Write (or clear, with null) the stored Gemini API key. */
export function writeStoredGeminiApiKey(key: string | null): void {
  writeStoredKey('geminiApiKey', key)
}

/** The stored Moonshot key (env MOONSHOT_API_KEY wins at the resolver). */
export function readStoredMoonshotApiKey(): string | undefined {
  return readStoredKey('moonshotApiKey')
}
export function writeStoredMoonshotApiKey(key: string | null): void {
  writeStoredKey('moonshotApiKey', key)
}

/** The stored DeepSeek key (env DEEPSEEK_API_KEY wins at the resolver). */
export function readStoredDeepseekApiKey(): string | undefined {
  return readStoredKey('deepseekApiKey')
}
export function writeStoredDeepseekApiKey(key: string | null): void {
  writeStoredKey('deepseekApiKey', key)
}

/** The stored key for the operator-named OpenAI-compatible endpoint slot
 *  (env MERCURY_COMPAT_API_KEY wins; a keyless slot is legal — local
 *  servers). */
export function readStoredCompatApiKey(): string | undefined {
  return readStoredKey('compatApiKey')
}
export function writeStoredCompatApiKey(key: string | null): void {
  writeStoredKey('compatApiKey', key)
}

/** The stored Hugging Face token — the PASTED store (env HF_TOKEN wins at
 *  the resolver; OAuth tokens rest with huggingfaceAccounts' own auth file). */
export function readStoredHuggingfaceApiKey(): string | undefined {
  return readStoredKey('huggingfaceApiKey')
}
export function writeStoredHuggingfaceApiKey(key: string | null): void {
  writeStoredKey('huggingfaceApiKey', key)
}

/** The stored key for locally served models (env MERCURY_LOCAL_API_KEY wins;
 *  keyless is the normal state — only servers started with an API key need
 *  one). */
export function readStoredLocalApiKey(): string | undefined {
  return readStoredKey('localApiKey')
}
export function writeStoredLocalApiKey(key: string | null): void {
  writeStoredKey('localApiKey', key)
}

/** The stored Brave Search API key — the web-search estate's keyed door
 *  (env BRAVE_API_KEY wins at the resolver, services/search/brave.ts). A
 *  search key is not a model credential, but it is a secret with the same
 *  laws, so it rests in the same store. */
export function readStoredBraveSearchApiKey(): string | undefined {
  return readStoredKey('braveSearchApiKey')
}
export function writeStoredBraveSearchApiKey(key: string | null): void {
  writeStoredKey('braveSearchApiKey', key)
}

/** The stored Tavily API key (env TAVILY_API_KEY wins at the resolver,
 *  services/search/tavily.ts). */
export function readStoredTavilyApiKey(): string | undefined {
  return readStoredKey('tavilyApiKey')
}
export function writeStoredTavilyApiKey(key: string | null): void {
  writeStoredKey('tavilyApiKey', key)
}

/** Proof/diagnostic seam — the path only, never contents. */
export function providerSecretsPathForDisplay(): string {
  return secretsPath()
}

/** The sign-in ledger's path (utils/accounts/signInLedger — `.sign-ins.json`,
 *  no secrets): credential-plane BY DESIGN, it lives beside this store under
 *  the same auth-scope bracket so per-account isolation and in-session
 *  switches hold for it exactly as for the keys. It takes the home from
 *  THIS store's door rather than joining the auth-scope caller floor (the
 *  scope-isolation law reserves that seam for the credential stores). */
export function signInLedgerPath(fileName: string): string {
  return join(getAuthConfigHomeDir(), fileName)
}

/**
 * Every credential ENV spelling the provider estate honors — the env-pin
 * names whose values are secrets (each row's reader is named beside it).
 * This module is the secrets owner, so the enumeration lives HERE, beside
 * the at-rest stores it mirrors; consumers that must EXCLUDE credentials
 * from a child environment (the eval kernels' env filter) derive from this
 * one list, never from a hand-list of their own. prove-env-filter.ts
 * cross-checks each name against a live reader in src so the list can
 * never silently trail the resolvers.
 */
export function credentialEnvNames(): readonly string[] {
  return [
    'ANTHROPIC_API_KEY', // services/api credential resolution
    'ANTHROPIC_AUTH_TOKEN', // services/api bearer override
    'OPENAI_API_KEY', // openaiAccounts resolver
    'ZAI_API_KEY', // zai resolver (wins over this store)
    'OPENROUTER_API_KEY', // openrouterAccounts resolver
    'GOOGLE_API_KEY', // geminiAccounts resolver (documented precedence)
    'GEMINI_API_KEY', // geminiAccounts resolver
    'MOONSHOT_API_KEY', // moonshotAccounts resolver
    'DEEPSEEK_API_KEY', // deepseekAccounts resolver
    'MERCURY_COMPAT_API_KEY', // compatAccounts env pin
    'HF_TOKEN', // huggingfaceAccounts resolver
    'MERCURY_LOCAL_API_KEY', // localAccounts env pin
    'BRAVE_API_KEY', // services/search/brave resolver (the web-search keyed door)
    'TAVILY_API_KEY', // services/search/tavily resolver
  ]
}
