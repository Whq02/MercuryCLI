import { chmodSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { DurablePublishError, durableAtomicPublishSync } from '../../../platform/substrate/durablePublish.js'
import { recordSignIn, noteCredentialChange } from './signInLedger.js'
export { signInRecordRestorer } from './signInLedger.js'
import { getAuthConfigHomeDir } from '../../../platform/environment/envUtils.js'
import { errorMessage, getErrnoCode, isENOENT } from '../../../platform/errors/errors.js'
import { logError } from '../../../platform/logs/errorLog.js'
import { refuseProofWriteIntoAccountStore } from '../../roads/proofHomeGuard.js'
import { passedOver } from '../../../platform/errors/passedOver.js'
import { hostEnv } from '../../../platform/environment/hostEnv.js'

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
  meliousApiKey?: string
  orcarouterApiKey?: string
  cerebrasApiKey?: string
  fireworksApiKey?: string
  qwenApiKey?: string
  qwenKeyBase?: string
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
  } catch (error) {
    passedOver(error)
    return null
  }
}

type CredentialJsonProbe =
  | { state: 'absent' }
  | { state: 'ok'; file: Record<string, unknown> }
  | { state: 'unusable'; why: 'not valid JSON' | 'not a JSON object' }
  | { state: 'unreadable'; code: string; message: string }

export function probeCredentialJson(path: string): CredentialJsonProbe {
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
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { state: 'unusable', why: 'not a JSON object' }
    return { state: 'ok', file: parsed as Record<string, unknown> }
  } catch {
    return { state: 'unusable', why: 'not valid JSON' }
  }
}

export function probeProviderSecretsFile(): { path: string; probe: CredentialJsonProbe } {
  const path = secretsPath()
  return { path, probe: probeCredentialJson(path) }
}

function credentialAsidePath(path: string, stamp: number): string {
  return path.endsWith('-auth.json') ? `${path.slice(0, -'-auth.json'.length)}.corrupt.${stamp}-auth.json` : `${path}.corrupt.${stamp}`
}

function keepCredentialFileAside(what: string, store: string, path: string, why: string): string | null {
  const { keepDamagedFileAsideSync } = require('../../../platform/substrate/storeRecovery.js') as typeof import('../../../platform/substrate/storeRecovery.js')
  try {
    return keepDamagedFileAsideSync({ store, path, reason: why, by: 'copy', asideAt: stamp => credentialAsidePath(path, stamp) })
  } catch (error) {
    if (isENOENT(error)) return null
    const code = getErrnoCode(error) ?? errorMessage(error)
    throw Object.assign(new Error(`${what} at ${path} is ${why} and could not be kept aside (${code}); nothing was written. Move it away, then try again.`), { code })
  }
}

export function credentialJsonToWriteOver(what: string, store: string, path: string): Record<string, unknown> | null {
  const probe = probeCredentialJson(path)
  if (probe.state === 'ok') return probe.file
  if (probe.state === 'unreadable') {
    throw Object.assign(
      new Error(`${what} at ${path} exists but could not be read (${probe.code}); nothing was written. Make it readable, or move it away to start a new one, then try again.`),
      { code: probe.code },
    )
  }
  if (probe.state === 'unusable') {
    const aside = keepCredentialFileAside(what, store, path, probe.why)
    if (aside !== null) credentialAsideWords.set(path, `${what} at ${path} was ${probe.why} and is kept aside at ${aside}; no credential could be read from it.`)
  }
  return null
}

const credentialAsideWords = new Map<string, string>()

export function takeCredentialKeptAside(path: string): string | undefined {
  const words = credentialAsideWords.get(path)
  credentialAsideWords.delete(path)
  return words
}

export function credentialFileUnwritten(what: string | null, path: string, error: unknown): Error {
  const code = (error instanceof DurablePublishError ? error.fsCode : getErrnoCode(error)) ?? 'EUNKNOWN'
  return Object.assign(new Error(`${what === null ? path : `${what} at ${path}`} could not be written (${code}); nothing was written. Close what holds the file, then try again.`), { code })
}

export function credentialFileRestorer(path: string): () => void {
  let before: Buffer | 'absent' | undefined
  try {
    before = readFileSync(path)
  } catch (error) {
    if (isENOENT(error)) before = 'absent'
  }
  return () => {
    if (before === undefined) return
    try {
      if (before !== 'absent') durableAtomicPublishSync(path, before, { mode: 0o600 })
      else unlinkSync(path)
    } catch (error) {
      if (!isENOENT(error)) logError(error)
    }
    noteCredentialChange()
  }
}

export function dropCredentialFileLeftEmpty(path: string): void {
  const probe = probeCredentialJson(path)
  if (probe.state !== 'ok' || Object.keys(probe.file).some(key => key !== 'version')) return
  try {
    unlinkSync(path)
  } catch (error) {
    if (!isENOENT(error)) logError(error)
  }
  noteCredentialChange()
}

function secretsStoreUnread(path: string, probe: { code: string; message: string }): Error {
  return Object.assign(
    new Error(
      `The provider secrets store at ${path} exists but could not be read (${probe.code}); nothing was written. ${probe.message}`,
    ),
    { code: probe.code },
  )
}

export function refuseUnreadSecretsStore(): void {
  const path = secretsPath()
  const probe = probeCredentialJson(path)
  if (probe.state === 'unreadable') throw secretsStoreUnread(path, probe)
}

function publishSecrets(mutate: (next: ProviderSecretsFile) => void): void {
  const dir = getAuthConfigHomeDir()
  refuseProofWriteIntoAccountStore(dir, 'the provider secrets store')
  mkdirSync(dir, { recursive: true })
  const path = secretsPath()
  const probe = probeCredentialJson(path)
  if (probe.state === 'unreadable') throw secretsStoreUnread(path, probe)
  if (probe.state === 'unusable') keepCredentialFileAside('The provider secrets store', 'provider-secrets', path, probe.why)
  const existing: ProviderSecretsFile = probe.state === 'ok' ? (probe.file as ProviderSecretsFile) : { version: PROVIDER_SECRETS_VERSION }
  const next: ProviderSecretsFile = { ...existing, version: PROVIDER_SECRETS_VERSION }
  mutate(next)
  try {
    durableAtomicPublishSync(path, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  } catch (error) {
    logError(error)
    throw credentialFileUnwritten(null, path, error)
  }
  try {
    chmodSync(path, 0o600)
  } catch (error) {
    passedOver(error)
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
  | 'meliousApiKey'
  | 'orcarouterApiKey'
  | 'cerebrasApiKey'
  | 'fireworksApiKey'
  | 'qwenApiKey'
  | 'braveSearchApiKey'
  | 'tavilyApiKey'
  | 'typesafeApiKey'
  | 'runpodApiKey'
  | 'vastApiKey'
  | 'lambdaApiKey'
  | 'hyperstackApiKey'
  | 'verdaApiKey'
  | 'digitaloceanApiKey'
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
  meliousApiKey: 'melious',
  orcarouterApiKey: 'orcarouter',
  cerebrasApiKey: 'cerebras',
  fireworksApiKey: 'fireworks',
  qwenApiKey: 'qwen',
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

export function readStoredCompatApiKey(name = 'default'): string | undefined {
  if (name === 'default') return readStoredKey('compatApiKey')
  const keys = readFile()?.compatEndpointKeys
  if (typeof keys !== 'object' || keys === null || !Object.hasOwn(keys, name)) return undefined
  const key = (keys as Record<string, unknown>)[name]
  return typeof key === 'string' ? key.trim() || undefined : undefined
}
export function writeStoredCompatApiKey(key: string | null, name?: string): void {
  if (name !== undefined) {
    const { configuredCompatEndpoints } = require('../../../platform/settings/compatEndpoints.js') as typeof import('../../../platform/settings/compatEndpoints.js')
    if (!/^[a-z0-9-]{1,32}$/.test(name) || !configuredCompatEndpoints().some(endpoint => endpoint.name === name)) throw new Error(`compatProvider.${name}: unknown endpoint; no key was stored`)
  }
  if (name === undefined || name === 'default') { writeStoredKey('compatApiKey', key); return }
  publishSecrets(next => {
    const keys = typeof next.compatEndpointKeys === 'object' && next.compatEndpointKeys !== null ? { ...next.compatEndpointKeys as Record<string, unknown> } : {}
    if (key === null || key.trim() === '') delete keys[name]
    else keys[name] = key.trim()
    next.compatEndpointKeys = keys
  })
  if (key?.trim()) recordSignIn('openai-compat', 'api-key')
}
export function clearEveryStoredCompatKey(): void {
  publishSecrets(next => {
    delete next.compatApiKey
    delete next.compatEndpointKeys
  })
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
export function readStoredMeliousApiKey(): string | undefined {
  return readStoredKey('meliousApiKey')
}
export function writeStoredMeliousApiKey(key: string | null): void {
  writeStoredKey('meliousApiKey', key)
}
export function readStoredOrcarouterApiKey(): string | undefined {
  return readStoredKey('orcarouterApiKey')
}
export function writeStoredOrcarouterApiKey(key: string | null): void {
  writeStoredKey('orcarouterApiKey', key)
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
export function readStoredQwenApiKey(): string | undefined {
  return readStoredKey('qwenApiKey')
}
export function readStoredQwenKeyBase(): string | undefined {
  const file = readFile()
  const base = typeof file?.qwenKeyBase === 'string' ? file.qwenKeyBase.trim() : ''
  return base && readStoredQwenApiKey() !== undefined ? base : undefined
}
export function writeStoredQwenApiKey(key: string | null, baseUrl?: string): void {
  publishSecrets(next => {
    if (key === null || key.trim() === '') {
      delete next.qwenApiKey
      delete next.qwenKeyBase
    } else {
      next.qwenApiKey = key.trim()
      if (baseUrl?.trim()) next.qwenKeyBase = baseUrl.trim().replace(/\/+$/, '')
      else delete next.qwenKeyBase
    }
  })
  if (key !== null && key.trim() !== '') recordSignIn('qwen', 'api-key')
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

function hostCredentialPath(home: string, id: string): string {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid host credential reference')
  return join(home, '.host-credentials', id + '.json')
}

export function writeHostCredential(home: string, id: string, key: string): void {
  refuseProofWriteIntoAccountStore(home, 'a host credential')
  mkdirSync(join(home, '.host-credentials'), { recursive: true, mode: 0o700 })
  durableAtomicPublishSync(hostCredentialPath(home, id), JSON.stringify({ key }) + '\n', { mode: 0o600 })
}

export function readHostCredential(home: string, id: string): string | undefined {
  try {
    const row = JSON.parse(readFileSync(hostCredentialPath(home, id), 'utf8')) as { key?: unknown }
    return typeof row.key === 'string' && row.key.trim() ? row.key : undefined
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new Error('The saved host credential could not be read.') }
}

export function removeHostCredential(home: string, id: string): void {
  try { unlinkSync(hostCredentialPath(home, id)) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
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
  refuseProofWriteIntoAccountStore(dir, `the auth file ${fileName}`)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, fileName)
  const existing = credentialJsonToWriteOver('The auth file', fileName.replace(/^\./, '').replace(/\.json$/, ''), path) ?? { version: 1 }
  const next = mutate({ ...existing, version: 1 })
  try {
    durableAtomicPublishSync(path, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  } catch (error) {
    throw credentialFileUnwritten('The auth file', path, error)
  }
  try {
    chmodSync(path, 0o600)
  } catch (error) { passedOver(error) }
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
    'MELIOUS_API_KEY',
    'ORCAROUTER_API_KEY',
    'CEREBRAS_API_KEY',
    'FIREWORKS_API_KEY',
    'DASHSCOPE_API_KEY',
    ...Object.keys(hostEnv()).filter(name => /^MERCURY_COMPAT_[A-Z0-9_]+_API_KEY$/.test(name)),
  ]
}

export function readStoredRunpodApiKey(): string | undefined {
  return readStoredKey('runpodApiKey')
}

export function writeStoredRunpodApiKey(key: string | null): void {
  writeStoredKey('runpodApiKey', key)
}

export function readStoredVastApiKey(): string | undefined {
  return readStoredKey('vastApiKey')
}

export function writeStoredVastApiKey(key: string | null): void {
  writeStoredKey('vastApiKey', key)
}

export function readStoredLambdaApiKey(): string | undefined {
  return readStoredKey('lambdaApiKey')
}

export function writeStoredLambdaApiKey(key: string | null): void {
  writeStoredKey('lambdaApiKey', key)
}
export const readStoredHyperstackApiKey = (): string | undefined => readStoredKey('hyperstackApiKey')
export const writeStoredHyperstackApiKey = (key: string | null): void => writeStoredKey('hyperstackApiKey', key)
export const readStoredVerdaApiKey = (): string | undefined => readStoredKey('verdaApiKey')
export const writeStoredVerdaApiKey = (key: string | null): void => writeStoredKey('verdaApiKey', key)
export const readStoredDigitaloceanApiKey = (): string | undefined => readStoredKey('digitaloceanApiKey')
export const writeStoredDigitaloceanApiKey = (key: string | null): void => writeStoredKey('digitaloceanApiKey', key)
