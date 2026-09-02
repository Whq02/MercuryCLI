import { chmodSync, copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DurablePublishError, durableAtomicPublishSync } from '../../substrate/durablePublish.js'
import { recordSignIn } from '../accounts/signInLedger.js'
import { getAuthConfigHomeDir } from '../envUtils.js'
import { getErrnoCode } from '../errors.js'

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
  compatApiKey?: string
  huggingfaceApiKey?: string
  localApiKey?: string
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
  }
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

export function providerSecretsPathForDisplay(): string {
  return secretsPath()
}

export function signInLedgerPath(fileName: string): string {
  return join(getAuthConfigHomeDir(), fileName)
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
    'MERCURY_COMPAT_API_KEY',
    'HF_TOKEN',
    'MERCURY_LOCAL_API_KEY',
    'BRAVE_API_KEY',
    'TAVILY_API_KEY',
  ]
}
