import { KEY_PAGES } from '../../../components/loginFamilyRows.js'
import { errorMessageWithCause } from '../../../utils/errors.js'
import { readStoredGeminiApiKey, writeStoredGeminiApiKey } from '../providerSecrets.js'
import { geminiOauthConnected, geminiPlanConnected, geminiPlanFacts, readPreferredGeminiSource, resolveGeminiAccount, resolveGeminiApiKey, writePreferredGeminiSource, type GeminiSourceKind } from './geminiAccounts.js'
import { geminiPlanTierWords } from './geminiPlanAccess.js'
import { geminiGenerateModels, refreshGeminiCatalogue, type GeminiCatalogueSnapshot } from './geminiCatalogue.js'

type GeminiStoredSourceKind = GeminiSourceKind

interface GeminiStoredSourceFacts {
  keySource?: 'env-google' | 'env-gemini' | 'stored'
  oauthConnected: boolean
  planConnected?: boolean
  active?: GeminiStoredSourceKind
}

const GEMINI_KEY_RIDES = 'requests ride generativelanguage.googleapis.com'
const GEMINI_ACCOUNT_RIDES = "requests ride Google's native generation endpoint"
const GEMINI_PLAN_RIDES = "requests ride Google's Code Assist endpoint under Google's own Antigravity client, on your plan's quota"

function keyWords(keySource: GeminiStoredSourceFacts['keySource']): string {
  return keySource === 'env-google' ? 'the API key (GOOGLE_API_KEY)' : keySource === 'env-gemini' ? 'the API key (GEMINI_API_KEY)' : 'the API key'
}

function sourceWords(kind: GeminiStoredSourceKind, facts: GeminiStoredSourceFacts): string {
  return kind === 'api-key' ? keyWords(facts.keySource) : kind === 'plan' ? 'the Google sign-in' : 'the Google account'
}

function storedKinds(facts: GeminiStoredSourceFacts): GeminiStoredSourceKind[] {
  const kinds: GeminiStoredSourceKind[] = []
  if (facts.planConnected) kinds.push('plan')
  if (facts.oauthConnected) kinds.push('oauth')
  if (facts.keySource !== undefined) kinds.push('api-key')
  return kinds
}

function otherStoredWords(kind: GeminiStoredSourceKind): string {
  return kind === 'api-key' ? 'an API key' : kind === 'plan' ? 'the Google sign-in' : 'the Google account'
}

export function geminiStoredSourcesNote(facts: GeminiStoredSourceFacts): string | undefined {
  const kinds = storedKinds(facts)
  if (facts.active === undefined || kinds.length < 2 || !kinds.includes(facts.active)) return undefined
  const others = kinds.filter(kind => kind !== facts.active).map(otherStoredWords)
  const stored = others.length === 1 ? `${others[0]} is also stored` : `${others.slice(0, -1).join(', ')} and ${others[others.length - 1]} are also stored`
  return `Active source: ${sourceWords(facts.active, facts)} · ${stored} — ↵ on its /logins gemini row makes it active`
}

export function liveGeminiStoredSourceFacts(): GeminiStoredSourceFacts {
  const key = resolveGeminiApiKey()
  const active = resolveGeminiAccount()?.kind
  return {
    ...(key ? { keySource: key.source } : {}),
    oauthConnected: geminiOauthConnected(),
    planConnected: geminiPlanConnected(),
    ...(active !== undefined ? { active } : {}),
  }
}

function otherSourceTail(active: GeminiStoredSourceKind): string {
  const facts = liveGeminiStoredSourceFacts()
  const others = storedKinds(facts).filter(kind => kind !== active)
  if (others.length === 0) return ''
  if (active === 'api-key' && others.length === 1 && others[0] === 'oauth') return ' The Google account stays stored — ↵ on its /logins row makes it active.'
  if (active !== 'api-key' && others.length === 1 && others[0] === 'api-key') return ' An API key is also stored — ↵ on its /logins row makes it active.'
  const words = others.map(otherStoredWords)
  const stored = words.length === 1 ? `${words[0]} stays stored` : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]} stay stored`
  return ` ${stored[0]!.toUpperCase()}${stored.slice(1)} — ↵ on a /logins row makes it active.`
}

function geminiSourceRides(kind: GeminiStoredSourceKind): string {
  return kind === 'api-key' ? GEMINI_KEY_RIDES : kind === 'plan' ? GEMINI_PLAN_RIDES : GEMINI_ACCOUNT_RIDES
}

export function activateGeminiSource(kind: GeminiStoredSourceKind): { ok: true; receipt: string } {
  writePreferredGeminiSource(kind)
  const facts = liveGeminiStoredSourceFacts()
  const named = kind === 'api-key' ? 'the API key' : sourceWords(kind, facts)
  return { ok: true, receipt: `Gemini: ${named} is now the active source — ${geminiSourceRides(kind)}.${otherSourceTail(kind)}` }
}

interface GeminiKeyLoginOutcome {
  ok: boolean
  stored: boolean
  receipt: string
}

export async function storeGeminiApiKeyLogin(
  key: string,
  io?: { refreshCatalogue?: () => Promise<{ models: unknown[]; lastError?: string; lastStatus?: number; lastSaid?: string } | null> },
): Promise<GeminiKeyLoginOutcome> {
  const refresh =
    io?.refreshCatalogue ?? (() => refreshGeminiCatalogue('api-key', { force: true }).catch(() => null))
  const previousKey = readStoredGeminiApiKey() ?? null
  const previousSource = readPreferredGeminiSource()
  try {
    writeStoredGeminiApiKey(key)
    writePreferredGeminiSource('api-key')
  } catch (error) {
    return {
      ok: false,
      stored: false,
      receipt: `Could not store the key: ${String((error as Error).message ?? error)}`,
    }
  }
  const snapshot = await refresh()
  if (snapshot?.lastError?.includes('refused the credential')) {
    writeStoredGeminiApiKey(previousKey)
    writePreferredGeminiSource(previousSource ?? null)
    return {
      ok: false,
      stored: false,
      receipt: `Google refused this key${snapshot.lastStatus !== undefined ? ` (HTTP ${snapshot.lastStatus})` : ''}${snapshot.lastSaid ? ` — ${snapshot.lastSaid}` : ''} — nothing stored${previousKey ? '; the key stored before stays' : ''}; keys are made at ${KEY_PAGES.gemini}, paste again.`,
    }
  }
  const catalogueNote = snapshot?.lastError
    ? ` The live catalogue did not answer (${snapshot.lastError}) — the key is stored; /model retries readiness.`
    : snapshot && snapshot.models.length > 0
      ? ` Live catalogue: ${snapshot.models.length} model(s) — the Gemini rows join /model now.`
      : ''
  return {
    ok: true,
    stored: true,
    receipt: `Gemini API key stored (auth-scoped, mode 600) — the active source: ${GEMINI_KEY_RIDES}.${catalogueNote}${otherSourceTail('api-key')}`,
  }
}

export async function finishGeminiOauthConnect(io?: {
  refreshCatalogue?: () => Promise<{ models: unknown[]; lastError?: string } | null>
}): Promise<{ ok: true; receipt: string }> {
  const refresh =
    io?.refreshCatalogue ?? (() => refreshGeminiCatalogue('oauth', { force: true }).catch(() => null))
  const snapshot = await refresh()
  const catalogueNote = snapshot?.lastError
    ? ` · catalogue: unavailable (${snapshot.lastError})`
    : snapshot && snapshot.models.length > 0
      ? ` · live catalogue: ${snapshot.models.length} model(s)`
      : ''
  return {
    ok: true,
    receipt: `Gemini connected: Google account (OAuth) — the active source, ${GEMINI_ACCOUNT_RIDES}${catalogueNote}. The catalogue rows join /model; /accounts manages the credential.${otherSourceTail('oauth')}`,
  }
}

export async function finishGeminiPlanConnect(io?: {
  refreshCatalogue?: () => Promise<{ models: unknown[]; lastError?: string } | null>
}): Promise<{ ok: true; receipt: string }> {
  const refresh =
    io?.refreshCatalogue ?? (() => refreshGeminiCatalogue('plan', { force: true }).catch(() => null))
  const snapshot = await refresh()
  const facts = geminiPlanFacts()
  const chat = snapshot && !snapshot.lastError ? geminiGenerateModels(snapshot as GeminiCatalogueSnapshot).length : 0
  const rosterNote = snapshot?.lastError
    ? ` · the roster did not answer (${snapshot.lastError}) — /model retries it`
    : snapshot && snapshot.models.length > 0
      ? ` · ${chat} chat model(s) on the roster Google serves this account`
      : ''
  const who = facts?.email ? ` as ${facts.email}` : ''
  return {
    ok: true,
    receipt: `Gemini connected: Google sign-in${who} on ${geminiPlanTierWords(facts?.tier)} — the active source, ${GEMINI_PLAN_RIDES}${rosterNote}. The roster rows join /model; /accounts manages the sign-in.${otherSourceTail('plan')}`,
  }
}

export function geminiConnectFailedReceipt(error: unknown): string {
  const message = errorMessageWithCause(error)
  return message.includes('/logins')
    ? `Gemini connect failed: ${message}`
    : `Gemini connect failed: ${message} — retry from /logins.`
}
export const GEMINI_CONNECT_CANCELLED_RECEIPT = 'Gemini connect cancelled — nothing stored.'
export const GEMINI_CONNECT_STOPPED_RECEIPT =
  'Gemini connect cancelled — if the exchange was already completing, the Google sign-in still lands; /accounts shows and removes it.'
