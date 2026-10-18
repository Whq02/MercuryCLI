import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { credentialFingerprint } from '../../services/providers/credentialIdentity.js'
import { getAuthConfigHomeDir } from '../envUtils.js'
import { noteCredentialChange, publishSignInRecord } from './signInLedger.js'

export type SignInRefusal = { status: 401 | 403; at: number }
type StoredRefusal = SignInRefusal & { identity: string }
type RefusalFile = { version: number; generation: string; refusal?: StoredRefusal }
type Credential = { identity: string; key?: string; matches?: (credential: string) => boolean }
type Observation = { family: string; home: string; credential: Credential; generation: string }

function keyCredential(value: { key: string; source: string } | undefined): Credential | undefined {
  return value && !value.source.startsWith('env') ? { identity: credentialFingerprint(value.key), key: value.key } : undefined
}

function currentCredential(family: string): Credential | undefined {
  try {
    if (/^compat-[a-z0-9-]{1,32}$/.test(family)) {
      const owner = require('../../services/providers/openaicompat/compatAccounts.js') as typeof import('../../services/providers/openaicompat/compatAccounts.js')
      return owner.configuredCompatEndpoints().some(endpoint => endpoint.name === family.slice(7)) ? keyCredential(owner.resolveCompatApiKey(process.env, family.slice(7))) : undefined
    }
    switch (family) {
      case 'deepseek': return keyCredential(require('../../services/providers/deepseek/deepseekAccounts.js').resolveDeepseekApiKey())
      case 'openrouter': return keyCredential(require('../../services/providers/openrouter/openrouterAccounts.js').resolveOpenrouterApiKey())
      case 'huggingface': return keyCredential(require('../../services/providers/huggingface/huggingfaceAccounts.js').resolveHuggingfaceApiKey())
      case 'xai': return keyCredential(require('../../services/providers/xai/xaiAccounts.js').resolveXaiCredentialSnapshot())
      case 'meta': return keyCredential(require('../../services/providers/meta/metaAccounts.js').resolveMetaApiKey())
      case 'mistral': return keyCredential(require('../../services/providers/mistral/mistralAccounts.js').resolveMistralApiKey())
      case 'nous': return keyCredential(require('../../services/providers/nous/nousAccounts.js').resolveNousCredentialSnapshot())
      case 'zen': return keyCredential(require('../../services/providers/zen/zenAccounts.js').resolveZenApiKey())
      case 'minimax': return keyCredential(require('../../services/providers/minimax/minimaxAccounts.js').resolveMinimaxApiKey())
      case 'together': return keyCredential(require('../../services/providers/together/togetherAccounts.js').resolveTogetherApiKey())
      case 'cohere': return keyCredential(require('../../services/providers/cohere/cohereAccounts.js').resolveCohereApiKey())
      case 'groq': return keyCredential(require('../../services/providers/groq/groqAccounts.js').resolveGroqApiKey())
      case 'cerebras': return keyCredential(require('../../services/providers/cerebras/cerebrasAccounts.js').resolveCerebrasApiKey())
      case 'fireworks': return keyCredential(require('../../services/providers/fireworks/fireworksAccounts.js').resolveFireworksApiKey())
      case 'qwen': return keyCredential(require('../../services/providers/qwen/qwenAccounts.js').resolveQwenCredentialSnapshot())
      case 'zai': return keyCredential(require('../../services/providers/zai/zaiAccounts.js').resolveZaiDispatch())
      case 'local': return keyCredential(require('../../services/providers/local/localAccounts.js').resolveLocalApiKey())
      case 'openai-compat': {
        const owner = require('../../services/providers/openaicompat/compatAccounts.js') as typeof import('../../services/providers/openaicompat/compatAccounts.js')
        return owner.configuredCompatEndpoints().some(endpoint => endpoint.named) ? undefined : keyCredential(owner.resolveCompatApiKey())
      }
      case 'moonshot': {
        const owner = require('../../services/providers/moonshot/moonshotAccounts.js') as typeof import('../../services/providers/moonshot/moonshotAccounts.js')
        if (owner.resolveMoonshotAccount()?.kind !== 'kimi-oauth') return keyCredential(owner.resolveMoonshotApiKey())
        const tokens = owner.moonshotStoredTokens()
        return tokens ? { identity: credentialFingerprint(tokens.accessToken), key: tokens.accessToken } : undefined
      }
      case 'openai': {
        const owner = require('../../services/providers/openai/openaiAccounts.js') as typeof import('../../services/providers/openai/openaiAccounts.js')
        const account = owner.resolveOpenaiAccount()
        if (!account) return undefined
        return account.kind === 'api-key' ? keyCredential(owner.resolveOpenaiApiKey()) : { identity: owner.openaiSourceIdentity(account.kind), matches: credential => owner.openaiSourceMatchesCredential(account.kind, credential) }
      }
      case 'gemini': {
        const owner = require('../../services/providers/gemini/geminiAccounts.js') as typeof import('../../services/providers/gemini/geminiAccounts.js')
        const account = owner.resolveGeminiAccount()
        if (!account) return undefined
        return account.kind === 'api-key' ? keyCredential(owner.resolveGeminiApiKey()) : { identity: owner.geminiSourceIdentity(account.kind), matches: credential => owner.geminiSourceMatchesCredential(account.kind, credential) }
      }
      case 'anthropic': {
        const owner = require('../auth.js') as typeof import('../auth.js')
        if (owner.getAuthTokenSource().source === 'claude.ai') {
          const tokens = owner.getClaudeAIOAuthTokens()
          return tokens ? { identity: credentialFingerprint(tokens.accessToken), key: tokens.accessToken } : undefined
        }
        const key = owner.getAnthropicApiKeyWithSource()
        return key.source === '/logins managed key' && key.key ? { identity: credentialFingerprint(key.key), key: key.key } : undefined
      }
      default: return undefined
    }
  } catch { return undefined }
}

function pathOf(family: string, home: string): string | undefined {
  return /^(?:[a-z][a-z0-9-]{0,31}|compat-[a-z0-9-]{1,32})$/.test(family) ? join(home, '.sign-in-refusals', `${family}.json`) : undefined
}

function readFile(family: string, home: string): RefusalFile | undefined {
  try {
    const path = pathOf(family, home)
    if (!path) return undefined
    const value = JSON.parse(readFileSync(path, 'utf8')) as RefusalFile
    return value?.version === 1 && typeof value.generation === 'string' ? value : undefined
  } catch { return undefined }
}

function readStored(family: string, home: string): StoredRefusal | undefined {
  const value = readFile(family, home)?.refusal
  return value && (value.status === 401 || value.status === 403) && Number.isFinite(value.at) && value.at > 0 && value.at <= 8.64e15 && typeof value.identity === 'string' ? value : undefined
}

export function clearSignInRefusal(family: string, home = getAuthConfigHomeDir()): void {
  try {
    const path = pathOf(family, home)
    if (!path) return
    publishSignInRecord(path, JSON.stringify({ version: 1, generation: randomUUID() }) + '\n')
  } catch { return }
}

export function readSignInRefusal(family: string): SignInRefusal | undefined {
  const home = getAuthConfigHomeDir()
  const record = readStored(family, home)
  if (!record || record.identity !== currentCredential(family)?.identity) return undefined
  return { status: record.status, at: record.at }
}

export function signInRefusalWords(refusal: SignInRefusal): string {
  return `stored · refused (HTTP ${refusal.status}) at ${new Date(refusal.at).toISOString()} — sign in again`
}

export function captureSignInRequest(family: string, wireCredential?: string): Observation | undefined {
  const credential = currentCredential(family)
  if (!credential || credential.identity === 'none' || (wireCredential !== undefined && (credential.matches ? !credential.matches(wireCredential) : wireCredential !== credential.key))) return undefined
  return { family, home: getAuthConfigHomeDir(), credential: { identity: credential.identity }, generation: readFile(family, getAuthConfigHomeDir())?.generation ?? '' }
}

export function observeSignInResponse(request: Observation | undefined, status: number | undefined): void {
  if (!request || status === undefined || !((status >= 200 && status < 300) || status === 401 || status === 403)) return
  try {
    const { family, home, credential, generation } = request
    if (getAuthConfigHomeDir() !== home || currentCredential(family)?.identity !== credential.identity || (readFile(family, home)?.generation ?? '') !== generation) return
    const previous = readStored(family, home)
    const path = pathOf(family, home)
    if (!path) return
    if (status >= 200 && status < 300) {
      if (previous?.identity === credential.identity) {
        publishSignInRecord(path, JSON.stringify({ version: 1, generation }) + '\n')
        noteCredentialChange()
      }
      return
    }
    publishSignInRecord(path, JSON.stringify({ version: 1, generation, refusal: { status, at: Date.now(), identity: credential.identity } }) + '\n')
    noteCredentialChange()
  } catch { return }
}
