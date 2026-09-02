// ============================================================================
//  providers/gemini/geminiLogin — the Gemini legs' shared login door
//  (the zaiLogin/deepseekLogin shape), shared by the
//  /logins card, the Boot face's logins layer, and the prover. The OAuth
//  machinery stays geminiAccounts' connect handles (gated HONESTLY on the
//  operator's own Google Cloud OAuth client); THIS module owns the key leg
//  and the RECEIPT SENTENCES every skin settles with — one spelling.
//  Receipts never carry a key value.
// ============================================================================
import { errorMessageWithCause } from '../../../utils/errors.js'
import { writeStoredGeminiApiKey } from '../../../utils/router/providerSecrets.js'
import { refreshGeminiCatalogue } from './geminiCatalogue.js'

export interface GeminiKeyLoginOutcome {
  ok: boolean
  /** True when the key reached the store (a failed write never does). */
  stored: boolean
  receipt: string
}

/** The key leg: store, then PROVE by forcing the live catalogue for the
 *  api-key source — never "connected" on a store write alone (the landed
 *  law, moved here whole). */
export async function storeGeminiApiKeyLogin(
  key: string,
  io?: { refreshCatalogue?: () => Promise<{ models: unknown[]; lastError?: string } | null> },
): Promise<GeminiKeyLoginOutcome> {
  const refresh =
    io?.refreshCatalogue ?? (() => refreshGeminiCatalogue('api-key', { force: true }).catch(() => null))
  try {
    writeStoredGeminiApiKey(key)
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
    receipt: `Gemini API key stored (auth-scoped, mode 600). Requests ride generativelanguage.googleapis.com.${catalogueNote}`,
  }
}

/** The settled OAuth connect's receipt (the landed settle moved whole):
 *  prove readiness by forcing the catalogue for the oauth source. */
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
    receipt: `Gemini connected: Google account (OAuth)${catalogueNote}. The catalogue rows join /model; /accounts manages the credential.`,
  }
}

/** The failure sentence (one spelling): a remedy-shaped failure (Google's
 *  own refusal) already names the fix and the retry route — never double
 *  the tail onto it. */
export function geminiConnectFailedReceipt(error: unknown): string {
  const message = errorMessageWithCause(error)
  return message.includes('/logins')
    ? `Gemini connect failed: ${message}`
    : `Gemini connect failed: ${message} — retry from /logins.`
}
export const GEMINI_CONNECT_CANCELLED_RECEIPT = 'Gemini connect cancelled — nothing stored.'
/** The mid-wait esc (the exchange may already be completing — the
 *  disclose-not-unwind law). The pre-flow cancel keeps nothing-stored. */
export const GEMINI_CONNECT_STOPPED_RECEIPT =
  'Gemini connect cancelled — if the exchange was already completing, the Google sign-in still lands; /accounts shows and removes it.'
