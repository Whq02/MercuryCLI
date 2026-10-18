import { chmodSync, copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DurablePublishError, durableAtomicPublishSync } from '../../substrate/durablePublish.js'
import { recordSignIn, noteCredentialChange } from '../../utils/accounts/signInLedger.js'
import { getAuthConfigHomeDir } from '../../utils/envUtils.js'
import { getErrnoCode } from '../../utils/errors.js'

const PROVIDER_SECRETS_VERSION = 1
const FILE_NAME = '.provider-secrets.json'

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
  xaiApiKey?: string
  xaiManagementApiKey?: string
  metaApiKey?: string
  compatApiKey?: string
  mistralApiKey?: string
  mistralAdminApiKey?: string
  huggingfaceApiKey?: string
  localApiKey?: string
  zenApiKey?: string
  minimaxApiKey?: string
  togetherApiKey?: string
  cohereApiKey?: string
  groqApiKey?: string
  cerebrasApiKey?: string
  fireworksApiKey?: string
  braveSearchApiKey?: string
  tavilyApiKey?: string
  typesafeApiKey?: string
  nousApiKey?: string
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
      }
    } catch {
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
    chmodSync(path, 0o600)
  } catch {
  }  noteCredentialChange()
}


export function readStoredZaiApiKey(): string | undefined {
  const file = readFile()
  const key = typeof file?.zaiApiKey === 'string' ? file.zaiApiKey.trim() : ''
  return key || undefined
}

export function readStoredZaiKeyPlan(): ZaiKeyPlan | undefined {
  const file = readFile()
  return file?.zaiKeyPlan === 'coding' && readStoredZaiApiKey() !== undefined ? 'coding' : undefined
}

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
  if (key !== null && key.trim() !== '') recordSignIn('zai', 'api-key')
}

export function readStoredOpenaiApiKey(): string | undefined {
  const file = readFile()
  const key = typeof file?.openaiApiKey === 'string' ? file.openaiApiKey.trim() : ''
  return key || undefined
}

export function writeStoredOpenaiApiKey(key: string | null): void {
  publishSecrets(next => {
    if (key === null || key.trim() === '') delete next.openaiApiKey
    else next.openaiApiKey = key.trim()
  })
  if (key !== null && key.trim() !== '') recordSignIn('openai', 'api-key')
}


type StoredKeyField =
  | 'moonshotApiKey'
  | 'deepseekApiKey'
  | 'xaiApiKey'
  | 'xaiManagementApiKey'
  | 'metaApiKey'
  | 'compatApiKey'
  | 'openrouterApiKey'
  | 'geminiApiKey'
  | 'huggingfaceApiKey'
  | 'localApiKey'
  | 'zenApiKey'
  | 'groqApiKey'
  | 'cerebrasApiKey'
  | 'fireworksApiKey'
  | 'braveSearchApiKey'
  | 'tavilyApiKey'
  | 'typesafeApiKey'
  | 'mistralApiKey'
  | 'minimaxApiKey'
  | 'togetherApiKey'
  | 'cohereApiKey'
  | 'mistralAdminApiKey'
  | 'nousApiKey'

function readStoredKey(field: StoredKeyField): string | undefined {
  const file = readFile()
  const key = typeof file?.[field] === 'string' ? (file[field] as string).trim() : ''
  return key || undefined
}

const KEY_FIELD_FAMILY: Partial<Record<StoredKeyField, string>> = {
  moonshotApiKey: 'moonshot',
  deepseekApiKey: 'deepseek',
  xaiApiKey: 'xai',
  metaApiKey: 'meta',
  compatApiKey: 'openai-compat',
  openrouterApiKey: 'openrouter',
  geminiApiKey: 'gemini',
  huggingfaceApiKey: 'huggingface',
  localApiKey: 'local',
  mistralApiKey: 'mistral',
  nousApiKey: 'nous',
  zenApiKey: 'zen',
  minimaxApiKey: 'minimax',
  togetherApiKey: 'together',
  cohereApiKey: 'cohere',
  groqApiKey: 'groq',
  cerebrasApiKey: 'cerebras',
  fireworksApiKey: 'fireworks',
}

function writeStoredKey(field: StoredKeyField, key: string | null): void {
  publishSecrets(next => {
    if (key === null || key.trim() === '') delete next[field]
    else next[field] = key.trim()
  })
  const family = KEY_FIELD_FAMILY[field]
  if (family !== undefined && key !== null && key.trim() !== '') recordSignIn(family, 'api-key')
}

export function readStoredOpenrouterApiKey(): string | undefined {
  return readStoredKey('openrouterApiKey')
}

export function writeStoredOpenrouterApiKey(key: string | null): void {
  writeStoredKey('openrouterApiKey', key)
}

export function readStoredGeminiApiKey(): string | undefined {
  return readStoredKey('geminiApiKey')
}

export function writeStoredGeminiApiKey(key: string | null): void {
  writeStoredKey('geminiApiKey', key)
}

export function readStoredMoonshotApiKey(): string | undefined {
  return readStoredKey('moonshotApiKey')
}
export function writeStoredMoonshotApiKey(key: string | null): void {
  writeStoredKey('moonshotApiKey', key)
}

export function readStoredDeepseekApiKey(): string | undefined {
  return readStoredKey('deepseekApiKey')
}
export function writeStoredDeepseekApiKey(key: string | null): void {
  writeStoredKey('deepseekApiKey', key)
}

export function readStoredXaiApiKey(): string | undefined {
  return readStoredKey('xaiApiKey')
}
export function writeStoredXaiApiKey(key: string | null): void {
  writeStoredKey('xaiApiKey', key)
}
export function readStoredXaiManagementApiKey(): string | undefined {
  return readStoredKey('xaiManagementApiKey')
}
export function writeStoredXaiManagementApiKey(key: string | null): void {
  writeStoredKey('xaiManagementApiKey', key)
}

export function readStoredMetaApiKey(): string | undefined {
  return readStoredKey('metaApiKey')
}
export function writeStoredMetaApiKey(key: string | null): void {
  writeStoredKey('metaApiKey', key)
}

export function readStoredMistralApiKey(): string | undefined {
  return readStoredKey('mistralApiKey')
}
export function writeStoredMistralApiKey(key: string | null): void {
  writeStoredKey('mistralApiKey', key)
}
export function readStoredMistralAdminApiKey(): string | undefined {
  return readStoredKey('mistralAdminApiKey')
}
export function writeStoredMistralAdminApiKey(key: string | null): void {
  writeStoredKey('mistralAdminApiKey', key)
}

export function readStoredNousApiKey(): string | undefined {
  return readStoredKey('nousApiKey')
}
export function writeStoredNousApiKey(key: string | null): void {
  writeStoredKey('nousApiKey', key)
}

export function readStoredCompatApiKey(): string | undefined {
  return readStoredKey('compatApiKey')
}
export function writeStoredCompatApiKey(key: string | null): void {
  writeStoredKey('compatApiKey', key)
}

export function readStoredHuggingfaceApiKey(): string | undefined {
  return readStoredKey('huggingfaceApiKey')
}
export function writeStoredHuggingfaceApiKey(key: string | null): void {
  writeStoredKey('huggingfaceApiKey', key)
}

export function readStoredZenApiKey(): string | undefined {
  return readStoredKey('zenApiKey')
}
export function writeStoredZenApiKey(key: string | null): void {
  writeStoredKey('zenApiKey', key)
}
export function readStoredMinimaxApiKey(): string | undefined {
  return readStoredKey('minimaxApiKey')
}
export function writeStoredMinimaxApiKey(key: string | null): void {
  writeStoredKey('minimaxApiKey', key)
}
export function readStoredTogetherApiKey(): string | undefined {
  return readStoredKey('togetherApiKey')
}
export function writeStoredTogetherApiKey(key: string | null): void {
  writeStoredKey('togetherApiKey', key)
}
export function readStoredCohereApiKey(): string | undefined {
  return readStoredKey('cohereApiKey')
}
export function writeStoredCohereApiKey(key: string | null): void {
  writeStoredKey('cohereApiKey', key)
}
export function readStoredGroqApiKey(): string | undefined {
  return readStoredKey('groqApiKey')
}
export function writeStoredGroqApiKey(key: string | null): void {
  writeStoredKey('groqApiKey', key)
}
export function readStoredCerebrasApiKey(): string | undefined {
  return readStoredKey('cerebrasApiKey')
}
export function writeStoredCerebrasApiKey(key: string | null): void {
  writeStoredKey('cerebrasApiKey', key)
}
export function readStoredFireworksApiKey(): string | undefined {
  return readStoredKey('fireworksApiKey')
}
export function writeStoredFireworksApiKey(key: string | null): void {
  writeStoredKey('fireworksApiKey', key)
}

export function readStoredLocalApiKey(): string | undefined {
  return readStoredKey('localApiKey')
}
export function writeStoredLocalApiKey(key: string | null): void {
  writeStoredKey('localApiKey', key)
}

export function readStoredBraveSearchApiKey(): string | undefined {
  return readStoredKey('braveSearchApiKey')
}
export function writeStoredBraveSearchApiKey(key: string | null): void {
  writeStoredKey('braveSearchApiKey', key)
}

export function readStoredTavilyApiKey(): string | undefined {
  return readStoredKey('tavilyApiKey')
}
export function writeStoredTavilyApiKey(key: string | null): void {
  writeStoredKey('tavilyApiKey', key)
}

export function readStoredTypesafeApiKey(): string | undefined {
  return readStoredKey('typesafeApiKey')
}
export function writeStoredTypesafeApiKey(key: string | null): void {
  writeStoredKey('typesafeApiKey', key)
}

export function providerSecretsPathForDisplay(): string {
  return secretsPath()
}

export function signInLedgerPath(fileName: string): string {
  return join(getAuthConfigHomeDir(), fileName)
}

export function publishAuthScopedJson(
  fileName: string,
  mutate: (file: Record<string, unknown>) => Record<string, unknown>,
): void {
  const dir = getAuthConfigHomeDir()
  mkdirSync(dir, { recursive: true })
  const path = join(dir, fileName)
  let existing: Record<string, unknown> = { version: 1 }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>
    }
  } catch {}
  const next = mutate({ ...existing, version: 1 })
  durableAtomicPublishSync(path, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {}
  noteCredentialChange()
}

export function credentialEnvNames(): readonly string[] {
  return [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'OPENAI_API_KEY',
    'ZAI_API_KEY',
    'OPENROUTER_API_KEY',
    'GOOGLE_API_KEY',
    'GEMINI_API_KEY',
    'MOONSHOT_API_KEY',
    'DEEPSEEK_API_KEY',
    'XAI_API_KEY',
    'XAI_MANAGEMENT_API_KEY',
    'MODEL_API_KEY',
    'META_API_KEY',
    'MERCURY_COMPAT_API_KEY',
    'MERCURY_COMPAT_BASE_URL',
    'HF_TOKEN',
    'MERCURY_LOCAL_API_KEY',
    'BRAVE_API_KEY',
    'TAVILY_API_KEY',
    'TYPESAFE_API_KEY',
    'MISTRAL_API_KEY',
    'MISTRAL_ADMIN_API_KEY',
    'NOUS_API_KEY',
    'OPENCODE_API_KEY',
    'MINIMAX_API_KEY',
    'TOGETHER_API_KEY',
    'TOGETHER_AI_API_KEY',
    'COHERE_API_KEY',
    'CO_API_KEY',
    'GROQ_API_KEY',
    'CEREBRAS_API_KEY',
    'FIREWORKS_API_KEY',
  ]
}
