import { errorMessageWithCause } from '../../../utils/errors.js'
import { writeStoredGeminiApiKey } from '../../../utils/router/providerSecrets.js'
import { geminiOauthConnected, resolveGeminiAccount, resolveGeminiApiKey, writePreferredGeminiSource } from './geminiAccounts.js'
import { refreshGeminiCatalogue } from './geminiCatalogue.js'

export type GeminiStoredSourceKind = 'oauth' | 'api-key'

export interface GeminiStoredSourceFacts {
  keySource?: 'env-google' | 'env-gemini' | 'stored'
  oauthConnected: boolean
  active?: GeminiStoredSourceKind
}

export const GEMINI_KEY_RIDES = 'requests ride generativelanguage.googleapis.com'
export const GEMINI_ACCOUNT_RIDES = "requests ride Google's native generation endpoint"

function keyWords(keySource: GeminiStoredSourceFacts['keySource']): string {
  return keySource === 'env-google' ? 'the API key (GOOGLE_API_KEY)' : keySource === 'env-gemini' ? 'the API key (GEMINI_API_KEY)' : 'the API key'
}

export function geminiStoredSourcesNote(facts: GeminiStoredSourceFacts): string | undefined {
  if (facts.keySource === undefined || !facts.oauthConnected || facts.active === undefined) return undefined
  const activeWords = facts.active === 'api-key' ? keyWords(facts.keySource) : 'the Google account'
  const other = facts.active === 'api-key' ? 'the Google account is also stored' : 'an API key is also stored'
  return `Active source: ${activeWords} · ${other} — ↵ on its /logins gemini row makes it active`
}

export function liveGeminiStoredSourceFacts(): GeminiStoredSourceFacts {
  const key = resolveGeminiApiKey()
  const active = resolveGeminiAccount()?.kind
  return {
    ...(key ? { keySource: key.source } : {}),
    oauthConnected: geminiOauthConnected(),
    ...(active === 'oauth' || active === 'api-key' ? { active } : {}),
  }
}

function otherSourceTail(active: GeminiStoredSourceKind): string {
  const facts = liveGeminiStoredSourceFacts()
  if (active === 'api-key') return facts.oauthConnected ? ' The Google account stays stored — ↵ on its /logins row makes it active.' : ''
  return facts.keySource !== undefined ? ' An API key is also stored — ↵ on its /logins row makes it active.' : ''
}

export function activateGeminiSource(kind: GeminiStoredSourceKind): { ok: true; receipt: string } {
  writePreferredGeminiSource(kind)
  const receipt =
    kind === 'api-key'
      ? `Gemini: the API key is now the active source — ${GEMINI_KEY_RIDES}.${otherSourceTail('api-key')}`
      : `Gemini: the Google account is now the active source — ${GEMINI_ACCOUNT_RIDES}.${otherSourceTail('oauth')}`
  return { ok: true, receipt }
}

export interface GeminiKeyLoginOutcome {
  ok: boolean
  stored: boolean
  receipt: string
}

export async function storeGeminiApiKeyLogin(
  key: string,
  io?: { refreshCatalogue?: () => Promise<{ models: unknown[]; lastError?: string } | null> },
): Promise<GeminiKeyLoginOutcome> {
  const refresh =
    io?.refreshCatalogue ?? (() => refreshGeminiCatalogue('api-key', { force: true }).catch(() => null))
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

export function geminiConnectFailedReceipt(error: unknown): string {
  const message = errorMessageWithCause(error)
  return message.includes('/logins')
    ? `Gemini connect failed: ${message}`
    : `Gemini connect failed: ${message} — retry from /logins.`
}
export const GEMINI_CONNECT_CANCELLED_RECEIPT = 'Gemini connect cancelled — nothing stored.'
export const GEMINI_CONNECT_STOPPED_RECEIPT =
  'Gemini connect cancelled — if the exchange was already completing, the Google sign-in still lands; /accounts shows and removes it.'
