// ============================================================================
//  providers/openrouter/openrouterLogin — the OpenRouter legs' shared login
//  door (the zaiLogin/deepseekLogin shape), shared by the
//  /logins card, the Boot face's logins layer, and the prover. The OAuth
//  machinery stays openrouterAccounts' connect handles (browser/headless);
//  THIS module owns the key leg and the RECEIPT SENTENCES every skin
//  settles with — one spelling. Receipts never carry a key value.
// ============================================================================
import { errorMessageWithCause } from '../../../utils/errors.js'
import { writeStoredOpenrouterApiKey } from '../../../utils/router/providerSecrets.js'
import type { OpenrouterAccountRef } from './openrouterAccounts.js'
import { refreshOpenrouterCatalogue } from './openrouterCatalogue.js'

export interface OpenrouterKeyLoginOutcome {
  ok: boolean
  /** True when the key reached the store (a failed write never does). */
  stored: boolean
  receipt: string
}

/** The key leg: store, then PROVE by forcing the live catalogue for the
 *  stored source — never "connected" on a store write alone (the landed
 *  law, moved here whole). */
export async function storeOpenrouterApiKeyLogin(
  key: string,
  io?: { refreshCatalogue?: () => Promise<{ models: unknown[]; lastError?: string } | null> },
): Promise<OpenrouterKeyLoginOutcome> {
  const refresh =
    io?.refreshCatalogue ?? (() => refreshOpenrouterCatalogue('stored', { force: true }).catch(() => null))
  try {
    writeStoredOpenrouterApiKey(key)
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
      ? ` Live catalogue: ${snapshot.models.length} model(s) — the OpenRouter rows join /model now.`
      : ''
  return {
    ok: true,
    stored: true,
    receipt: `OpenRouter API key stored (auth-scoped, mode 600). Requests bill OpenRouter credits.${catalogueNote}`,
  }
}

/** The settled OAuth connect's receipt (the landed finishConnected moved
 *  whole): prove readiness by forcing the catalogue for the ref's own key
 *  source, and say what it answered. */
export async function finishOpenrouterConnect(
  ref: OpenrouterAccountRef,
  io?: { refreshCatalogue?: () => Promise<{ models: unknown[]; lastError?: string } | null> },
): Promise<{ ok: true; receipt: string }> {
  const refresh =
    io?.refreshCatalogue ?? (() => refreshOpenrouterCatalogue(ref.keySource, { force: true }).catch(() => null))
  const snapshot = await refresh()
  const catalogueNote = snapshot?.lastError
    ? ` · catalogue: unavailable (${snapshot.lastError})`
    : snapshot && snapshot.models.length > 0
      ? ` · live catalogue: ${snapshot.models.length} model(s)`
      : ''
  return {
    ok: true,
    receipt: `OpenRouter connected: ${ref.label}${catalogueNote}. The catalogue rows join /model; /accounts manages the credential.`,
  }
}

/** The failure/cancel sentences (one spelling). */
export function openrouterConnectFailedReceipt(error: unknown): string {
  return `OpenRouter connect failed: ${errorMessageWithCause(error)} — retry from /logins.`
}
export const OPENROUTER_CONNECT_CANCELLED_RECEIPT = 'OpenRouter connect cancelled — nothing stored.'
/** The mid-wait esc (the exchange may already be completing — the
 *  disclose-not-unwind law: a landed mint is stored and shown, never
 *  orphaned). The pre-flow cancel keeps the plain nothing-stored truth. */
export const OPENROUTER_CONNECT_STOPPED_RECEIPT =
  'OpenRouter connect cancelled — if the key exchange was already completing, the minted key still lands; /accounts shows and removes it.'
