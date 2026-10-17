import { errorMessageWithCause } from '../../../utils/errors.js'
import { writeStoredOpenaiApiKey } from '../providerSecrets.js'
import type { OpenaiAccountRef } from './openaiAccounts.js'
import { refreshOpenaiCatalogue } from './openaiCatalogue.js'

interface OpenaiKeyLoginOutcome {
  ok: boolean
  stored: boolean
  receipt: string
}

export async function storeOpenaiApiKeyLogin(
  key: string,
  io?: {
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
  const snapshot = await refresh()
  const catalogueNote = snapshot?.lastError
    ? ` The live catalogue did not answer (${snapshot.lastError}) — the key is stored; /logins re-checks readiness.`
    : snapshot && snapshot.models.length > 0
      ? ` Live catalogue: ${snapshot.models.length} model(s) — GPT rows join /model now.`
      : ''
  return {
    ok: true,
    stored: true,
    receipt: `OpenAI API key stored (auth-scoped, mode 600). Requests ride api.openai.com under usage-based billing.${catalogueNote}`,
  }
}

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
    receipt: `OpenAI connected: ${ref.label}${ref.accountId ? ` · account ${ref.accountId.slice(0, 8)}…` : ''}${catalogueNote}. Qualified GPT models now join /model and the Crewmate 'gpt' grammar; /logins shows readiness; /accounts signs out.`,
  }
}

export function openaiConnectFailedReceipt(error: unknown, leg: 'browser' | 'device'): string {
  return leg === 'device'
    ? `OpenAI device connect failed: ${errorMessageWithCause(error)}`
    : `OpenAI connect failed: ${errorMessageWithCause(error)}. Retry from /logins (OpenAI: ChatGPT subscription or API key, the subscription arm; press d while waiting to use a device code).`
}

export const OPENAI_DEVICE_STOPPED_RECEIPT =
  'OpenAI device connect: stopped watching — if you approve the code before it expires, the connection still lands (check /logins).'

export const OPENAI_CONNECT_STOPPED_RECEIPT =
  'OpenAI connect cancelled — if the exchange was already completing, the subscription still lands; /accounts shows and removes it.'
