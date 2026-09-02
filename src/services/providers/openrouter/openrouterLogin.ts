import { errorMessageWithCause } from '../../../utils/errors.js'
import { writeStoredOpenrouterApiKey } from '../../../utils/router/providerSecrets.js'
import type { OpenrouterAccountRef } from './openrouterAccounts.js'
import { refreshOpenrouterCatalogue } from './openrouterCatalogue.js'

export interface OpenrouterKeyLoginOutcome {
  ok: boolean
  stored: boolean
  receipt: string
}

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

export function openrouterConnectFailedReceipt(error: unknown): string {
  return `OpenRouter connect failed: ${errorMessageWithCause(error)} — retry from /logins.`
}
export const OPENROUTER_CONNECT_CANCELLED_RECEIPT = 'OpenRouter connect cancelled — nothing stored.'
export const OPENROUTER_CONNECT_STOPPED_RECEIPT =
  'OpenRouter connect cancelled — if the key exchange was already completing, the minted key still lands; /accounts shows and removes it.'
