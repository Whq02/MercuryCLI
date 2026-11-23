import { readFileSync } from 'node:fs'
import { credentialFingerprint } from '../sign-in/account-ledger/credentialIdentity.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { errorMessage } from '../../platform/errors/errors.js'
import { getAuthConfigHomeDir } from '../../platform/environment/envUtils.js'
import { noteCredentialChange, publishSignInRecord, signInRefusalPath } from '../sign-in/account-ledger/signInLedger.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { hostEnv } from '../../platform/environment/hostEnv.js'

export type SignInRefusal = { status: 401 | 403; at: number; message?: string; credential?: 'key' | 'sign-in'; remedy?: string }
type StoredRefusal = SignInRefusal & { identity: string }
type RefusalFile = { version: number; generation: string; refusal?: StoredRefusal }
type Credential = { identity: string; key?: string; matches?: (credential: string) => boolean; noun?: 'key' | 'sign-in' }
type Observation = { family: string; home: string; credential: Credential; generation: string }

const MESSAGE_CEILING = 200

function keyCredential(value: { key: string; source: string } | undefined): Credential | undefined {
  return value && !value.source.startsWith('env') ? { identity: credentialFingerprint(value.key), key: value.key, noun: 'key' } : undefined
}

function serviceMessage(raw: string | undefined): string | undefined {
  const line = raw?.replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ').trim() ?? ''
  if (line === '') return undefined
  return line.length > MESSAGE_CEILING ? `${line.slice(0, MESSAGE_CEILING - 1)}…` : line
}

function currentCredential(family: string): Credential | undefined {
  try {
    if (/^compat-[a-z0-9-]{1,32}$/.test(family)) {
      const owner = require('./openaicompat/compatAccounts.js') as typeof import('./openaicompat/compatAccounts.js')
      return owner.configuredCompatEndpoints().some(endpoint => endpoint.name === family.slice(7)) ? keyCredential(owner.resolveCompatApiKey(hostEnv(), family.slice(7))) : undefined
    }
    switch (family) {
      case 'deepseek': return keyCredential(require('./deepseek/deepseekAccounts.js').resolveDeepseekApiKey())
      case 'openrouter': return keyCredential(require('./openrouter/openrouterAccounts.js').resolveOpenrouterApiKey())
      case 'huggingface': return keyCredential(require('./huggingface/huggingfaceAccounts.js').resolveHuggingfaceApiKey())
      case 'xai': return keyCredential(require('./xai/xaiAccounts.js').resolveXaiCredentialSnapshot())
      case 'meta': return keyCredential(require('./meta/metaAccounts.js').resolveMetaApiKey())
      case 'mistral': return keyCredential(require('./mistral/mistralAccounts.js').resolveMistralApiKey())
      case 'nous': return keyCredential(require('./nous/nousAccounts.js').resolveNousCredentialSnapshot())
      case 'zen': return keyCredential(require('./zen/zenAccounts.js').resolveZenApiKey())
      case 'minimax': return keyCredential(require('./minimax/minimaxAccounts.js').resolveMinimaxApiKey())
      case 'together': return keyCredential(require('./together/togetherAccounts.js').resolveTogetherApiKey())
      case 'cohere': return keyCredential(require('./cohere/cohereAccounts.js').resolveCohereApiKey())
      case 'groq': return keyCredential(require('./groq/groqAccounts.js').resolveGroqApiKey())
      case 'melious': return keyCredential(require('./melious/meliousAccounts.js').resolveMeliousApiKey())
      case 'orcarouter': return keyCredential(require('./orcarouter/orcarouterAccounts.js').resolveOrcarouterApiKey())
      case 'cerebras': return keyCredential(require('./cerebras/cerebrasAccounts.js').resolveCerebrasApiKey())
      case 'fireworks': return keyCredential(require('./fireworks/fireworksAccounts.js').resolveFireworksApiKey())
      case 'qwen': return keyCredential(require('./qwen/qwenAccounts.js').resolveQwenCredentialSnapshot())
      case 'zai': return keyCredential(require('./zai/zaiAccounts.js').resolveZaiDispatch())
      case 'local': return keyCredential(require('./local/localAccounts.js').resolveLocalApiKey())
      case 'openai-compat': {
        const owner = require('./openaicompat/compatAccounts.js') as typeof import('./openaicompat/compatAccounts.js')
        return owner.configuredCompatEndpoints().some(endpoint => endpoint.named) ? undefined : keyCredential(owner.resolveCompatApiKey())
      }
      case 'moonshot': {
        const owner = require('./moonshot/moonshotAccounts.js') as typeof import('./moonshot/moonshotAccounts.js')
        if (owner.resolveMoonshotAccount()?.kind !== 'kimi-oauth') return keyCredential(owner.resolveMoonshotApiKey())
        const tokens = owner.moonshotStoredTokens()
        return tokens ? { identity: credentialFingerprint(tokens.accessToken), key: tokens.accessToken, noun: 'sign-in' } : undefined
      }
      case 'openai': {
        const owner = require('./openai/openaiAccounts.js') as typeof import('./openai/openaiAccounts.js')
        const account = owner.resolveOpenaiAccount()
        if (!account) return undefined
        return account.kind === 'api-key' ? keyCredential(owner.resolveOpenaiApiKey()) : { identity: owner.openaiSourceIdentity(account.kind), matches: credential => owner.openaiSourceMatchesCredential(account.kind, credential), noun: 'sign-in' }
      }
      case 'gemini': {
        const owner = require('./gemini/geminiAccounts.js') as typeof import('./gemini/geminiAccounts.js')
        const account = owner.resolveGeminiAccount()
        if (!account) return undefined
        return account.kind === 'api-key' ? keyCredential(owner.resolveGeminiApiKey()) : { identity: owner.geminiSourceIdentity(account.kind), matches: credential => owner.geminiSourceMatchesCredential(account.kind, credential), noun: 'sign-in' }
      }
      case 'anthropic': {
        const owner = require('../sign-in/credentials/auth.js') as typeof import('../sign-in/credentials/auth.js')
        if (owner.getAuthTokenSource().source === 'claude.ai') {
          const tokens = owner.getClaudeAIOAuthTokens()
          return tokens ? { identity: credentialFingerprint(tokens.accessToken), key: tokens.accessToken, noun: 'sign-in' } : undefined
        }
        const key = owner.getAnthropicApiKeyWithSource()
        return key.source === '/logins managed key' && key.key ? { identity: credentialFingerprint(key.key), key: key.key } : undefined
      }
      default: return undefined
    }
  } catch (error) { passedOver(error); return undefined }
}

function readFile(family: string, home: string): RefusalFile | undefined {
  try {
    const path = signInRefusalPath(family, home)
    if (!path) return undefined
    const value = JSON.parse(readFileSync(path, 'utf8')) as RefusalFile
    return value?.version === 1 && typeof value.generation === 'string' ? value : undefined
  } catch (error) { passedOver(error); return undefined }
}

function readStored(family: string, home: string): StoredRefusal | undefined {
  const value = readFile(family, home)?.refusal
  if (!(value && (value.status === 401 || value.status === 403) && Number.isFinite(value.at) && value.at > 0 && value.at <= 8.64e15 && typeof value.identity === 'string')) return undefined
  const message = typeof value.message === 'string' ? serviceMessage(value.message) : undefined
  const credential = value.credential === 'key' || value.credential === 'sign-in' ? value.credential : undefined
  return { status: value.status, at: value.at, identity: value.identity, ...(message !== undefined ? { message } : {}), ...(credential !== undefined ? { credential } : {}) }
}

function openrouterKeyProbeRefusal(): SignInRefusal | undefined {
  try {
    const owner = require('./openrouter/openrouterAccounts.js') as typeof import('./openrouter/openrouterAccounts.js')
    const refused = owner.openrouterKeyRefusal()
    if (!refused || !(refused.status === 401 || refused.status === 403)) return undefined
    const message = serviceMessage(refused.message)
    return { status: refused.status, at: refused.observedAtMs > 0 ? refused.observedAtMs : Date.now(), ...(message !== undefined ? { message } : {}), credential: 'key', ...(refused.source === 'env' ? { remedy: 'update OPENROUTER_API_KEY' } : {}) }
  } catch (error) { passedOver(error); return undefined }
}

export function readSignInRefusal(family: string): SignInRefusal | undefined {
  const home = getAuthConfigHomeDir()
  const record = readStored(family, home)
  if (!record || record.identity !== currentCredential(family)?.identity) return family === 'openrouter' ? openrouterKeyProbeRefusal() : undefined
  return { status: record.status, at: record.at, ...(record.message !== undefined ? { message: record.message } : {}), ...(record.credential !== undefined ? { credential: record.credential } : {}) }
}

function reconnectWords(family: string): string {
  try {
    const { reconnectDoorFor } = require('./credentialWall.js') as typeof import('./credentialWall.js')
    const door = reconnectDoorFor(family.startsWith('compat-') ? 'openai-compat' : family)
    return door.startsWith('/') ? `${door} reconnects` : `update ${door}`
  } catch (error) { passedOver(error); return '/logins reconnects' }
}

export function signInRefusalWords(refusal: SignInRefusal, family: string): string {
  const reason = `HTTP ${refusal.status}${refusal.message ? `: ${refusal.message}` : ''}`
  return `${refusal.credential ?? 'sign-in'} refused (${reason}) at ${new Date(refusal.at).toISOString().replace(/\.\d{3}Z$/, 'Z')} · ${refusal.remedy ?? reconnectWords(family)}`
}

export function captureSignInRequest(family: string, wireCredential?: string): Observation | undefined {
  const credential = currentCredential(family)
  if (!credential || credential.identity === 'none' || (wireCredential !== undefined && (credential.matches ? !credential.matches(wireCredential) : wireCredential !== credential.key))) return undefined
  return { family, home: getAuthConfigHomeDir(), credential: { identity: credential.identity, ...(credential.noun !== undefined ? { noun: credential.noun } : {}) }, generation: readFile(family, getAuthConfigHomeDir())?.generation ?? '' }
}

export function observeSignInResponse(request: Observation | undefined, status: number | undefined, message?: string): void {
  if (!request || status === undefined || !((status >= 200 && status < 300) || status === 401 || status === 403)) return
  try {
    const { family, home, credential, generation } = request
    if (getAuthConfigHomeDir() !== home || currentCredential(family)?.identity !== credential.identity || (readFile(family, home)?.generation ?? '') !== generation) return
    const previous = readStored(family, home)
    const path = signInRefusalPath(family, home)
    if (!path) return
    if (status >= 200 && status < 300) {
      if (previous?.identity === credential.identity) {
        publishSignInRecord(path, JSON.stringify({ version: 1, generation }) + '\n')
        noteCredentialChange()
      }
      return
    }
    const words = serviceMessage(message)
    const refusal: StoredRefusal = { status: status === 401 ? 401 : 403, at: Date.now(), identity: credential.identity, ...(words !== undefined ? { message: words } : {}), ...(credential.noun !== undefined ? { credential: credential.noun } : {}) }
    publishSignInRecord(path, JSON.stringify({ version: 1, generation, refusal }) + '\n')
    noteCredentialChange()
  } catch (error) {
    logForDebugging(`[accounts] the answer (HTTP ${status}) to the sign-in of ${request.family} could not be recorded: ${errorMessage(error)}`, { level: 'warn' })
  }
}
