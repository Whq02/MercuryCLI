import { readSignInEntries } from '../../utils/accounts/signInLedger.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  chosenSignIn,
  pocketInUse,
  forgetPocket,
  registerProjectSignInSource,
  pocketEntries,
  setProjectSignIn,
  setSessionSignIn,
  withSignInHome,
  type PocketEntry,
  type SignInChoice,
} from '../../utils/accounts/signInPockets.js'
import { getAuthConfigHomeDir } from '../../utils/envUtils.js'
import { getSecureStorage, removeSecureStorageField } from '../../utils/secureStorage/index.js'
import {
  readStoredCompatApiKey,
  readStoredDeepseekApiKey,
  readStoredGeminiApiKey,
  readStoredHuggingfaceApiKey,
  readStoredLocalApiKey,
  readStoredMetaApiKey,
  readStoredMistralApiKey,
  readStoredMoonshotApiKey,
  readStoredNousApiKey,
  readStoredOpenaiApiKey,
  readStoredOpenrouterApiKey,
  readStoredXaiApiKey,
  readStoredZaiApiKey,
  readStoredZenApiKey,
  writeStoredCompatApiKey,
  writeStoredDeepseekApiKey,
  writeStoredGeminiApiKey,
  writeStoredHuggingfaceApiKey,
  writeStoredLocalApiKey,
  writeStoredMetaApiKey,
  writeStoredMistralApiKey,
  writeStoredMoonshotApiKey,
  writeStoredNousApiKey,
  writeStoredOpenaiApiKey,
  writeStoredOpenrouterApiKey,
  writeStoredXaiApiKey,
  writeStoredZaiApiKey,
  writeStoredZenApiKey,
} from '../../utils/router/providerSecrets.js'
import { credentialFingerprint, maskedKeyTail } from './credentialIdentity.js'
import { providerDisplayName } from './routeLaw.js'

export interface SignInRosterRow {
  family: string
  identity: string
  kind: string
  dir: string | null
  slug?: string
  inUse: boolean
  isDefault: boolean
  at?: number
}

interface HomeSignIn {
  identity: string
  kind: string
  remove: () => void
}

function keyRow(kind: string, key: string | undefined, remove: () => void): HomeSignIn[] {
  if (key === undefined || key.trim() === '') return []
  return [{ identity: maskedKeyTail(key) || credentialFingerprint(key), kind, remove }]
}

function homeSignInsOf(family: string): HomeSignIn[] {
  switch (family) {
    case 'anthropic': {
      const { claudeAiSignInIdentity, revokeOAuthToken } = require('../oauth/client.js') as typeof import('../oauth/client.js')
      const tokens = getSecureStorage('anthropic').read()?.claudeAiOauth
      const identity = claudeAiSignInIdentity(tokens)
      const remove = (): void => {
        const refreshToken = getSecureStorage('anthropic').read()?.claudeAiOauth?.refreshToken
        if (pocketInUse('anthropic') === undefined) removeSecureStorageField('claudeAiOauth', 'anthropic')
        else getSecureStorage('anthropic').delete()
        if (refreshToken) void revokeOAuthToken(refreshToken).catch(() => undefined)
      }
      return identity === undefined ? [] : [{ identity, kind: 'subscription', remove }]
    }
    case 'openai': {
      const openai = require('./openai/openaiAccounts.js') as typeof import('./openai/openaiAccounts.js')
      const sub = openai.storedSubscriptionIdentity()
      return [
        ...(sub === undefined ? [] : [{ identity: sub, kind: 'chatgpt-subscription', remove: () => openai.disconnectOpenaiSubscription() }]),
        ...keyRow('api-key', readStoredOpenaiApiKey(), () => writeStoredOpenaiApiKey(null)),
      ]
    }
    case 'gemini': {
      const gemini = require('./gemini/geminiAccounts.js') as typeof import('./gemini/geminiAccounts.js')
      const plan = gemini.storedGeminiPlanIdentity()
      const oauth = gemini.storedGeminiOauthIdentity()
      return [
        ...(plan === undefined ? [] : [{ identity: plan, kind: 'plan', remove: () => gemini.disconnectGeminiPlan() }]),
        ...(oauth === undefined ? [] : [{ identity: oauth, kind: 'oauth', remove: () => gemini.disconnectGeminiOauth() }]),
        ...keyRow('api-key', readStoredGeminiApiKey(), () => writeStoredGeminiApiKey(null)),
      ]
    }
    case 'huggingface': {
      const hf = require('./huggingface/huggingfaceAccounts.js') as typeof import('./huggingface/huggingfaceAccounts.js')
      const identity = hf.huggingfaceSignInIdentity(hf.huggingfaceStoredTokens(), hf.huggingfaceOauthIdentity())
      return [
        ...(identity === undefined ? [] : [{ identity, kind: 'oauth', remove: () => hf.disconnectHuggingfaceOauth() }]),
        ...keyRow('api-key', readStoredHuggingfaceApiKey(), () => writeStoredHuggingfaceApiKey(null)),
      ]
    }
    case 'moonshot': {
      const kimi = require('./moonshot/moonshotAccounts.js') as typeof import('./moonshot/moonshotAccounts.js')
      const identity = kimi.moonshotSignInIdentity(kimi.moonshotStoredTokens())
      return [
        ...(identity === undefined ? [] : [{ identity, kind: 'oauth', remove: () => kimi.disconnectMoonshotOauth() }]),
        ...keyRow('api-key', readStoredMoonshotApiKey(), () => writeStoredMoonshotApiKey(null)),
      ]
    }
    case 'xai': {
      const xai = require('./xai/xaiOauth.js') as typeof import('./xai/xaiOauth.js')
      const identity = xai.xaiSignInIdentity(xai.xaiStoredTokens())
      return [
        ...(identity === undefined ? [] : [{ identity, kind: 'subscription', remove: () => xai.clearStoredXaiSubscription() }]),
        ...keyRow('api-key', readStoredXaiApiKey(), () => writeStoredXaiApiKey(null)),
      ]
    }
    case 'nous': {
      const nous = require('./nous/nousOauth.js') as typeof import('./nous/nousOauth.js')
      const identity = nous.nousSignInIdentity(nous.nousStoredTokens())
      return [
        ...(identity === undefined ? [] : [{ identity, kind: 'oauth', remove: () => nous.clearStoredNousSignin() }]),
        ...keyRow('api-key', readStoredNousApiKey(), () => writeStoredNousApiKey(null)),
      ]
    }
    case 'meta': {
      const meta = require('./meta/metaAccounts.js') as typeof import('./meta/metaAccounts.js')
      const identity = meta.metaSignInIdentity(meta.readMetaMuseCodeGrant())
      return [
        ...(identity === undefined ? [] : [{ identity, kind: 'muse-code', remove: () => meta.disconnectMetaMuseCode() }]),
        ...keyRow('api-key', readStoredMetaApiKey(), () => writeStoredMetaApiKey(null)),
      ]
    }
    case 'openrouter': {
      const openrouter = require('./openrouter/openrouterAccounts.js') as typeof import('./openrouter/openrouterAccounts.js')
      return [
        ...keyRow('oauth-key', openrouter.readMintedOpenrouterKey()?.key, () => openrouter.disconnectOpenrouterOauthKey()),
        ...keyRow('api-key', readStoredOpenrouterApiKey(), () => writeStoredOpenrouterApiKey(null)),
      ]
    }
    case 'zai':
      return keyRow('api-key', readStoredZaiApiKey(), () => writeStoredZaiApiKey(null))
    case 'deepseek':
      return keyRow('api-key', readStoredDeepseekApiKey(), () => writeStoredDeepseekApiKey(null))
    case 'mistral':
      return keyRow('api-key', readStoredMistralApiKey(), () => writeStoredMistralApiKey(null))
    case 'zen':
      return keyRow('api-key', readStoredZenApiKey(), () => writeStoredZenApiKey(null))
    case 'local':
      return keyRow('api-key', readStoredLocalApiKey(), () => writeStoredLocalApiKey(null))
    case 'openai-compat':
      return keyRow('api-key', readStoredCompatApiKey(), () => writeStoredCompatApiKey(null))
    default:
      return []
  }
}

function pocketRemoval(family: string): () => void {
  return () => {
    for (const row of homeSignInsOf(family)) {
      try {
        row.remove()
      } catch {
        continue
      }
    }
  }
}

export const SIGN_IN_FAMILIES = ['anthropic', 'openai', 'gemini', 'huggingface', 'moonshot', 'xai', 'nous', 'meta', 'openrouter', 'zai', 'deepseek', 'mistral', 'zen', 'local', 'openai-compat'] as const

export function familySignInRoster(family: string, home: string = getAuthConfigHomeDir()): SignInRosterRow[] {
  const choice = chosenSignIn(family)
  const entries = readSignInEntries(family, { home })
  const homeRows: SignInRosterRow[] = withSignInHome(family, home, () => homeSignInsOf(family)).map(row => ({
    family,
    identity: row.identity,
    kind: row.kind,
    dir: null,
    inUse: false,
    isDefault: true,
    ...(entries[row.identity]?.at !== undefined ? { at: entries[row.identity]!.at } : {}),
  }))
  const pocketRows: SignInRosterRow[] = pocketEntries(family, home).map(entry => ({
    family,
    identity: entry.identity,
    kind: withSignInHome(family, entry.dir, () => homeSignInsOf(family))[0]?.kind ?? entry.kind,
    dir: entry.dir,
    slug: entry.slug,
    inUse: false,
    isDefault: false,
    at: entry.at,
  }))
  const rows = [...homeRows, ...pocketRows]
  const inUse = rowInUse(rows, choice)
  return rows.map(row => ({ ...row, inUse: row === inUse }))
}

function rowInUse(rows: SignInRosterRow[], choice: SignInChoice | undefined): SignInRosterRow | undefined {
  if (choice === undefined) return rows.find(row => row.isDefault)
  if (choice.dir !== null) return rows.find(row => row.dir === choice.dir) ?? rows.find(row => row.isDefault)
  return rows.find(row => row.isDefault && (row.kind === choice.kind || row.identity === choice.identity)) ?? rows.find(row => row.isDefault)
}

export function everySignInRoster(home: string = getAuthConfigHomeDir()): SignInRosterRow[] {
  return SIGN_IN_FAMILIES.flatMap(family => familySignInRoster(family, home))
}

export function findSignIn(identity: string, family?: string, home: string = getAuthConfigHomeDir()): { row?: SignInRosterRow; matches: SignInRosterRow[] } {
  const wanted = identity.trim().toLowerCase()
  const rows = (family === undefined ? everySignInRoster(home) : familySignInRoster(family, home)).filter(row => row.identity.toLowerCase() === wanted)
  return rows.length === 1 ? { row: rows[0]!, matches: rows } : { matches: rows }
}

export function knownIdentities(family: string, home: string = getAuthConfigHomeDir()): string[] {
  return familySignInRoster(family, home).map(row => row.identity)
}

export type UseSignInOutcome =
  | { ok: true; row: SignInRosterRow; words: string }
  | { ok: false; words: string }

export function useSignIn(identity: string, family?: string, layer: 'session' | 'project' = 'session', home: string = getAuthConfigHomeDir()): UseSignInOutcome {
  const found = findSignIn(identity, family, home)
  if (found.row === undefined) {
    if (found.matches.length > 1) {
      return { ok: false, words: `${identity} names a sign-in in more than one family (${found.matches.map(row => row.family).join(', ')}) — say which: /logins use <family> ${identity}` }
    }
    const families = family === undefined ? [...SIGN_IN_FAMILIES] : [family]
    const known = families.flatMap(name => knownIdentities(name, home))
    return { ok: false, words: `no sign-in named ${identity}${family === undefined ? '' : ` for ${providerDisplayName(family)}`} — ${known.length === 0 ? 'nothing is signed in yet; /logins signs in' : `the sign-ins are ${known.join(', ')}`}` }
  }
  const row = found.row
  const choice: SignInChoice = { identity: row.identity, dir: row.dir, kind: row.kind }
  if (layer === 'project') setProjectSignIn(row.family, choice)
  else setSessionSignIn(row.family, choice)
  return { ok: true, row, words: `${providerDisplayName(row.family)}: this ${layer} now spends ${row.identity}${row.isDefault ? ' (the default)' : ''}` }
}

export function useDefaultSignIn(family: string): string {
  setSessionSignIn(family, null)
  return `${providerDisplayName(family)}: this session spends the project's choice or the default again`
}

export type ForgetSignInOutcome = { ok: true; words: string; choiceFell: boolean } | { ok: false; words: string }

export function forgetSignIn(identity: string, family?: string, home: string = getAuthConfigHomeDir()): ForgetSignInOutcome {
  const found = findSignIn(identity, family, home)
  if (found.row === undefined) {
    return { ok: false, words: found.matches.length > 1 ? `${identity} names a sign-in in more than one family — say which: /logins forget <family> ${identity}` : `no sign-in named ${identity} — nothing forgotten` }
  }
  const row = found.row
  if (row.dir === null) {
    return { ok: false, words: `${row.identity} is ${providerDisplayName(row.family)}'s default sign-in — ⌫ on its /accounts row signs it out` }
  }
  const entry: Pick<PocketEntry, 'identity' | 'slug' | 'dir'> = { identity: row.identity, slug: row.slug ?? '', dir: row.dir }
  const outcome = forgetPocket(row.family, entry, pocketRemoval(row.family), home)
  if (!outcome.removed) return { ok: false, words: `${row.identity} could not be forgotten — its pocket did not go` }
  const fallback = familySignInRoster(row.family, home).find(candidate => candidate.inUse)
  return {
    ok: true,
    choiceFell: outcome.choiceFell,
    words: `${providerDisplayName(row.family)}: ${row.identity} forgotten${outcome.choiceFell ? ` — this session now spends ${fallback?.identity ?? 'the default'}` : ''}`,
  }
}

export interface ProjectSignInRefusal {
  family: string
  identity: string
  known: string[]
}

let lastRefusals: ProjectSignInRefusal[] = []

export function projectSignInRefusals(): ProjectSignInRefusal[] {
  return lastRefusals
}

export function applyProjectSignInChoices(choices: Record<string, string> | undefined, home: string = getAuthConfigHomeDir()): ProjectSignInRefusal[] {
  const refused: ProjectSignInRefusal[] = []
  for (const [family, identity] of Object.entries(choices ?? {})) {
    if (typeof identity !== 'string' || identity.trim() === '') continue
    const outcome = useSignIn(identity, family.trim().toLowerCase(), 'project', home)
    if (!outcome.ok) refused.push({ family, identity, known: knownIdentities(family.trim().toLowerCase(), home) })
  }
  lastRefusals = refused
  return refused
}

export function bindProjectSignInChoicesToSettings(readSettings: () => { credentials?: { signIns?: Record<string, string> } }): void {
  registerProjectSignInSource(() => {
    for (const refusal of applyProjectSignInChoices(readSettings().credentials?.signIns)) {
      logForDebugging(projectSignInRefusalWords(refusal))
    }
  })
}

export function projectSignInRefusalWords(refusal: ProjectSignInRefusal): string {
  return `.mercury/settings.local.json names ${refusal.identity} for ${providerDisplayName(refusal.family)} but no such sign-in exists — ${refusal.known.length === 0 ? 'nothing is signed in for it' : `the sign-ins are ${refusal.known.join(', ')}`}; the default spends`
}
