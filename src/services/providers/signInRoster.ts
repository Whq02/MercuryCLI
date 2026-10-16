import { readSignInEntries } from '../../utils/accounts/signInLedger.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  chosenSignIn,
  isKeyIdentity,
  KEY_IDENTITY_MARK,
  pocketInUse,
  forgetPocket,
  registerProjectSignInSource,
  pocketEntries,
  setProjectSignIn,
  setSessionSignIn,
  withSignInHome,
  signInsEstate,
  type PocketEntry,
  type SignInChoice,
} from '../../utils/accounts/signInPockets.js'
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

export interface SignInRoad {
  identity: string
  kind: string
  active: boolean
}

export interface SignInRosterRow {
  family: string
  identity: string
  kind: string
  dir: string | null
  slug?: string
  inUse: boolean
  isDefault: boolean
  at?: number
  roads: SignInRoad[]
}

interface HomeSignIn {
  identity: string
  kind: string
  remove: () => void
}

const ROAD_WORDS: Record<string, string> = {
  'chatgpt-subscription': 'ChatGPT subscription',
  subscription: 'subscription',
  plan: 'Google plan',
  oauth: 'sign-in',
  'muse-code': 'Muse Code sign-in',
  'oauth-key': 'OAuth-minted key',
  'api-key': 'API key',
}

export function roadWords(kind: string): string {
  return ROAD_WORDS[kind] ?? kind
}

function activeRoadKind(family: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  switch (family) {
    case 'anthropic':
      return 'subscription'
    case 'openai':
      return (require('./openai/openaiAccounts.js') as typeof import('./openai/openaiAccounts.js')).resolveOpenaiAccount(env)?.kind
    case 'gemini':
      return (require('./gemini/geminiAccounts.js') as typeof import('./gemini/geminiAccounts.js')).resolveGeminiAccount(env)?.kind
    case 'huggingface':
      return (require('./huggingface/huggingfaceAccounts.js') as typeof import('./huggingface/huggingfaceAccounts.js')).resolveHuggingfaceAccount(env)?.kind
    case 'moonshot': {
      const kind = (require('./moonshot/moonshotAccounts.js') as typeof import('./moonshot/moonshotAccounts.js')).resolveMoonshotAccount(env)?.kind
      return kind === 'kimi-oauth' ? 'oauth' : kind
    }
    case 'xai': {
      const kind = (require('./xai/xaiAccounts.js') as typeof import('./xai/xaiAccounts.js')).resolveXaiAccount(env)?.kind
      return kind === 'grok-subscription' ? 'subscription' : kind
    }
    case 'nous': {
      const kind = (require('./nous/nousAccounts.js') as typeof import('./nous/nousAccounts.js')).resolveNousAccount(env)?.kind
      return kind === 'signin' ? 'oauth' : kind
    }
    case 'meta':
      return (require('./meta/metaAccounts.js') as typeof import('./meta/metaAccounts.js')).resolveMetaAccount(env)?.kind
    case 'openrouter':
      return (require('./openrouter/openrouterAccounts.js') as typeof import('./openrouter/openrouterAccounts.js')).resolveOpenrouterAccount(env)?.kind
    default:
      return 'api-key'
  }
}

function signInOf(family: string, dir: string | null, roads: HomeSignIn[], entries: Record<string, { at: number }>, slug?: string): SignInRosterRow | undefined {
  if (roads.length === 0) return undefined
  const activeKind = activeRoadKind(family)
  const active = roads.find(road => road.kind === activeKind) ?? roads[0]!
  const ats = roads.map(road => entries[road.identity]?.at).filter((at): at is number => at !== undefined)
  return {
    family,
    identity: active.identity,
    kind: active.kind,
    dir,
    ...(slug !== undefined ? { slug } : {}),
    inUse: false,
    isDefault: dir === null,
    ...(ats.length > 0 ? { at: Math.min(...ats) } : {}),
    roads: roads.map(road => ({ identity: road.identity, kind: road.kind, active: road === active })),
  }
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

export function familySignInRoster(family: string, home: string = signInsEstate()): SignInRosterRow[] {
  const choice = chosenSignIn(family)
  const entries = readSignInEntries(family, { home })
  const homeRow = withSignInHome(family, home, () => signInOf(family, null, homeSignInsOf(family), entries))
  const pocketRows = pocketEntries(family, home).flatMap(entry => {
    const row = withSignInHome(family, entry.dir, () => signInOf(family, entry.dir, homeSignInsOf(family), entries, entry.slug))
    return row === undefined ? [] : [{ ...row, at: entry.at }]
  })
  const rows = [...(homeRow === undefined ? [] : [homeRow]), ...pocketRows]
  const inUse = rowInUse(rows, choice)
  return rows.map(row => ({ ...row, inUse: row === inUse }))
}

function rowInUse(rows: SignInRosterRow[], choice: SignInChoice | undefined): SignInRosterRow | undefined {
  if (choice === undefined || choice.dir === null) return rows.find(row => row.isDefault)
  return rows.find(row => row.dir === choice.dir) ?? rows.find(row => row.isDefault)
}

export function everySignInRoster(home: string = signInsEstate()): SignInRosterRow[] {
  return SIGN_IN_FAMILIES.flatMap(family => familySignInRoster(family, home))
}

function spelledIdentity(typed: string): string {
  const word = typed.trim().toLowerCase()
  return word.startsWith('...') ? `${KEY_IDENTITY_MARK}${word.slice(3)}` : word
}

function namesIdentity(identity: string, wanted: string): boolean {
  const own = identity.toLowerCase()
  if (own === wanted) return true
  return isKeyIdentity(identity) && own.slice(KEY_IDENTITY_MARK.length) === wanted
}

function namesRow(row: SignInRosterRow, wanted: string): boolean {
  return namesIdentity(row.identity, wanted) || row.roads.some(road => namesIdentity(road.identity, wanted))
}

function roadNamed(row: SignInRosterRow, typed: string): SignInRoad | undefined {
  const wanted = spelledIdentity(typed)
  return row.roads.find(road => namesIdentity(road.identity, wanted))
}

export function findSignIn(identity: string, family?: string, home: string = signInsEstate()): { row?: SignInRosterRow; matches: SignInRosterRow[] } {
  const wanted = spelledIdentity(identity)
  const rows = (family === undefined ? everySignInRoster(home) : familySignInRoster(family, home)).filter(row => namesRow(row, wanted))
  return rows.length === 1 ? { row: rows[0]!, matches: rows } : { matches: rows }
}

export function knownIdentities(family: string, home: string = signInsEstate()): string[] {
  return familySignInRoster(family, home).map(row => row.identity)
}

export type UseSignInOutcome =
  | { ok: true; row: SignInRosterRow; words: string }
  | { ok: false; words: string }

export function useSignIn(identity: string, family?: string, layer: 'session' | 'project' = 'session', home: string = signInsEstate()): UseSignInOutcome {
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
  return { ok: true, row, words: `${providerDisplayName(row.family)}: this ${layer} now spends ${row.identity}${row.isDefault ? ' (the default)' : ''}${roadClause(row, roadNamed(row, identity))}` }
}

function roadClause(row: SignInRosterRow, named: SignInRoad | undefined): string {
  if (row.roads.length < 2) return ''
  const through = ` through its ${roadWords(row.kind)}`
  if (named === undefined || named.active) return through
  return `${through} — ${named.identity} is its ${roadWords(named.kind)} road — /accounts switches the road`
}

export function roadsWords(row: SignInRosterRow): string | undefined {
  if (row.roads.length < 2) return undefined
  return row.roads.map(road => `${roadWords(road.kind)}${isKeyIdentity(road.identity) ? ` ${road.identity}` : ''}${road.active ? ' (spends)' : ''}`).join(', ')
}

export function useDefaultSignIn(family: string): string {
  setSessionSignIn(family, null)
  return `${providerDisplayName(family)}: this session spends the project's choice or the default again`
}

export type ForgetSignInOutcome = { ok: true; words: string; choiceFell: boolean } | { ok: false; words: string }

export function forgetSignIn(identity: string, family?: string, home: string = signInsEstate()): ForgetSignInOutcome {
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
  const dangling = outcome.fall.project ? ` · .mercury/settings.local.json still names ${row.identity} — remove the line` : ''
  return {
    ok: true,
    choiceFell: outcome.choiceFell,
    words: `${providerDisplayName(row.family)}: ${row.identity} forgotten${outcome.choiceFell ? ` — this session now spends ${fallback?.identity ?? 'the default'}` : ''}${dangling}`,
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

export function applyProjectSignInChoices(choices: Record<string, string> | undefined, home: string = signInsEstate()): ProjectSignInRefusal[] {
  const refused: ProjectSignInRefusal[] = []
  for (const [family, identity] of Object.entries(choices ?? {})) {
    if (typeof identity !== 'string' || identity.trim() === '') continue
    const outcome = useSignIn(identity, family.trim().toLowerCase(), 'project', home)
    if (!outcome.ok) refused.push({ family, identity, known: knownIdentities(family.trim().toLowerCase(), home) })
  }
  lastRefusals = refused
  return refused
}

export function trustedSignInSettings(): { credentials?: { signIns?: Record<string, string> } } {
  const { getSettingsForSource } = require('../../utils/settings/settings.js') as typeof import('../../utils/settings/settings.js')
  return getSettingsForSource('localSettings') ?? {}
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
