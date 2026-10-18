import { errorMessageWithCause } from '../../../utils/errors.js'
import { writeStoredOpenrouterApiKey } from '../providerSecrets.js'
import { forgetOpenrouterKeyRefusal, type OpenrouterAccountRef } from './openrouterAccounts.js'
import { refreshOpenrouterCatalogue } from './openrouterCatalogue.js'
import { probeOpenrouterKey, type OpenrouterKeyProbe } from './openrouterUsageState.js'

interface OpenrouterKeyLoginOutcome {
  ok: boolean
  stored: boolean
  receipt: string
}

export async function storeOpenrouterApiKeyLogin(
  key: string,
  io?: { refreshCatalogue?: () => Promise<{ models: unknown[]; lastError?: string } | null>; probeKey?: (key: string) => Promise<OpenrouterKeyProbe> },
): Promise<OpenrouterKeyLoginOutcome> {
  key = key.trim()
  if (!key) return { ok: false, stored: false, receipt: 'Paste a non-empty OpenRouter API key.' }
  const refresh =
    io?.refreshCatalogue ?? (() => refreshOpenrouterCatalogue('stored', { force: true }).catch(() => null))
  const probe = await (io?.probeKey ?? probeOpenrouterKey)(key)
  if (probe.state === 'refused') {
    return {
      ok: false,
      stored: false,
      receipt: `OpenRouter refused this key (HTTP ${probe.status}: ${probe.message}) — nothing stored; keys are made at openrouter.ai/settings/keys, paste again.`,
    }
  }
  try {
    writeStoredOpenrouterApiKey(key)
    forgetOpenrouterKeyRefusal()
  } catch (error) {
    return {
      ok: false,
      stored: false,
      receipt: `Could not store the key: ${String((error as Error).message ?? error)}`,
    }
  }
  const keyNote = probe.state === 'accepted'
    ? ` The key endpoint confirmed it${probe.usage.label ? ` (${probe.usage.label})` : ''}.`
    : ` UNVERIFIED — the key endpoint could not confirm it (${probe.message}); the first turn proves it.`
  const snapshot = await refresh()
  const catalogueNote = snapshot?.lastError
    ? ` The live catalogue did not answer (${snapshot.lastError}) — the key is stored; /model retries readiness.`
    : snapshot && snapshot.models.length > 0
      ? ` Live catalogue: ${snapshot.models.length} model(s) — the OpenRouter rows join /model now.`
      : ''
  return {
    ok: true,
    stored: true,
    receipt: `OpenRouter API key stored (auth-scoped, mode 600). Requests bill OpenRouter credits.${keyNote}${catalogueNote}`,
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
