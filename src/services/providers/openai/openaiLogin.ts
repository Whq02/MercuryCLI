// ============================================================================
//  providers/openai/openaiLogin — the OpenAI legs' shared login door
//  (the zaiLogin/deepseekLogin shape), shared by the
//  /logins card, the Boot face's logins layer, and the prover. The
//  subscription flows stay openaiAccounts' connect handles (browser/device);
//  THIS module owns the key leg and the RECEIPT SENTENCES every skin
//  settles with — one spelling, never per-surface wording.
//
//  The key leg: store the key auth-scoped, then PROVE it by forcing the
//  live catalogue for the api-key source and report what it actually
//  answered — never "connected" on a store write alone (the landed law,
//  moved here whole). Receipts never carry a key value.
// ============================================================================
import { errorMessageWithCause } from '../../../utils/errors.js'
import { writeStoredOpenaiApiKey } from '../../../utils/router/providerSecrets.js'
import type { OpenaiAccountRef } from './openaiAccounts.js'
import { refreshOpenaiCatalogue } from './openaiCatalogue.js'

export interface OpenaiKeyLoginOutcome {
  ok: boolean
  /** True when the key reached the store (a failed write never does). */
  stored: boolean
  receipt: string
}

export async function storeOpenaiApiKeyLogin(
  key: string,
  io?: {
    /** The catalogue kick's seam (the live default forces the real refresh). */
    refreshCatalogue?: () => Promise<{ models: unknown[]; lastError?: string } | null>
  },
): Promise<OpenaiKeyLoginOutcome> {
  const refresh =
    io?.refreshCatalogue ?? (() => refreshOpenaiCatalogue('api-key', { force: true }).catch(() => null))
  try {
    writeStoredOpenaiApiKey(key)
  } catch (error) {
    return {
      ok: false,
      stored: false,
      receipt: `Could not store the key: ${String((error as Error).message ?? error)}`,
    }
  }
  // Prove the key live: force the catalogue for the api-key source and
  // report what it actually answered — never "connected" on a store
  // write alone.
  const snapshot = await refresh()
  const catalogueNote = snapshot?.lastError
    ? ` The live catalogue did not answer (${snapshot.lastError}) — the key is stored; /router engines re-checks readiness.`
    : snapshot && snapshot.models.length > 0
      ? ` Live catalogue: ${snapshot.models.length} model(s) — GPT rows join /model now.`
      : ''
  return {
    ok: true,
    stored: true,
    receipt: `OpenAI API key stored (auth-scoped, mode 600). Requests ride api.openai.com under usage-based billing.${catalogueNote}`,
  }
}

/** The settled subscription connect's receipt (A6b — the landed
 *  finishConnected moved whole): prove readiness immediately by forcing
 *  the live catalogue for the subscription source, and say what it
 *  answered. Both skins settle with THIS sentence. */
export async function finishOpenaiSubscriptionConnect(
  ref: OpenaiAccountRef,
  io?: { refreshCatalogue?: () => Promise<{ models: unknown[]; lastError?: string } | null> },
): Promise<{ ok: true; receipt: string }> {
  const refresh =
    io?.refreshCatalogue ??
    (() => refreshOpenaiCatalogue('chatgpt-subscription', { force: true }).catch(() => null))
  const snapshot = await refresh()
  const catalogueNote = snapshot?.lastError
    ? ` · catalogue: unavailable (${snapshot.lastError})`
    : snapshot && snapshot.models.length > 0
      ? ` · live catalogue: ${snapshot.models.length} model(s)`
      : ''
  return {
    ok: true,
    receipt: `OpenAI connected: ${ref.label}${ref.accountId ? ` · account ${ref.accountId.slice(0, 8)}…` : ''}${catalogueNote}. Qualified GPT models now join /model and the Agent 'gpt' grammar; /router engines shows readiness; /accounts signs out.`,
  }
}

/** The failure sentences (one spelling): the browser leg names the retry
 *  road and the d-switch; the device leg names its own. */
export function openaiConnectFailedReceipt(error: unknown, leg: 'browser' | 'device'): string {
  return leg === 'device'
    ? `OpenAI device connect failed: ${errorMessageWithCause(error)}`
    : `OpenAI connect failed: ${errorMessageWithCause(error)} — retry from /logins (OpenAI — ChatGPT subscription or API key, the subscription arm; d on the wait switches to a device code).`
}

/** The device leg's honest esc: stopping the watch leaves the background
 *  poll to land the connection if the code is approved. */
export const OPENAI_DEVICE_STOPPED_RECEIPT =
  'OpenAI device connect: stopped watching — if you approve the code before it expires, the connection still lands (check /router engines).'

/** The browser leg's cancel receipt (the mid-wait esc: the exchange may
 *  already be completing — the disclose-not-unwind law; the landed
 *  answer is stored and shown, never orphaned). */
export const OPENAI_CONNECT_STOPPED_RECEIPT =
  'OpenAI connect cancelled — if the exchange was already completing, the subscription still lands; /accounts shows and removes it.'
