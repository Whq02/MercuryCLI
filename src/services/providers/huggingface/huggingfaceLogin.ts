import { errorMessageWithCause } from '../../../utils/errors.js'
import { recordSignIn } from '../../../utils/accounts/signInLedger.js'
import { writeStoredHuggingfaceApiKey } from '../../../utils/router/providerSecrets.js'
import {
  fetchHuggingfaceIdentity,
  pollHuggingfaceDeviceToken,
  startHuggingfaceDeviceAuth,
  writeHuggingfaceTokenIdentity,
  writeHuggingfaceTokens,
  type HuggingfaceDeviceAuthStart,
  type HuggingfaceIdentity,
  type HuggingfaceOauthIo,
} from './huggingfaceAccounts.js'
import { refreshHuggingfaceCatalogue } from './huggingfaceCatalogue.js'
import { HUGGINGFACE_UNVERIFIED_NOTE } from './huggingfaceCallModel.js'

export type HuggingfaceDeviceLoginEvent =
  | { phase: 'starting' }
  | { phase: 'waiting'; start: HuggingfaceDeviceAuthStart; polls: number; note?: string }
  | { phase: 'finishing' }

export interface HuggingfaceDeviceLoginArgs {
  io?: HuggingfaceOauthIo
  sleep?: (ms: number) => Promise<void>
  cancelled?: () => boolean
  onEvent?: (event: HuggingfaceDeviceLoginEvent) => void
  refreshCatalogue?: () => Promise<{ models: unknown[]; lastError?: string } | null>
}

export type HuggingfaceDeviceLoginOutcome =
  | {
      ok: true
      receipt: string
      username: string | null
      settledAfterCancel?: true
    }
  | {
      ok: false
      receipt: string
      code: 'start-failed' | 'expired' | 'denied' | 'refused' | 'cancelled' | 'store-failed'
    }

export const HUGGINGFACE_CONNECT_STOPPED_RECEIPT =
  'Hugging Face sign-in cancelled — if the approval was already in flight it still lands; /accounts shows and removes it.'

export const HUGGINGFACE_SETTLED_AFTER_CANCEL_RECEIPT =
  'Hugging Face sign-in completed after cancel — the approval landed while this flow was being cancelled, so the account IS signed in (an unstored copy would orphan the live grant). ⌫ on its /accounts row signs it out.'

const RFC_SLOW_DOWN_STEP_SEC = 5

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function catalogueNoteOf(snapshot: { models: unknown[]; lastError?: string } | null): string {
  return snapshot?.lastError
    ? ` · catalogue: unavailable (${snapshot.lastError})`
    : snapshot && snapshot.models.length > 0
      ? ` · live catalogue: ${snapshot.models.length} model(s)`
      : ''
}

export async function runHuggingfaceDeviceLogin(
  args: HuggingfaceDeviceLoginArgs = {},
): Promise<HuggingfaceDeviceLoginOutcome> {
  const { io, onEvent } = args
  const sleep = args.sleep ?? defaultSleep
  const cancelled = args.cancelled ?? (() => false)
  const refresh = args.refreshCatalogue ?? (() => refreshHuggingfaceCatalogue({ force: true }).catch(() => null))
  const now = (): number => io?.now?.() ?? Date.now()
  onEvent?.({ phase: 'starting' })
  let start: HuggingfaceDeviceAuthStart
  try {
    start = await startHuggingfaceDeviceAuth(io)
  } catch (error) {
    return {
      ok: false,
      code: 'start-failed',
      receipt: `Hugging Face sign-in could not start: ${errorMessageWithCause(error)} — retry from /logins, or paste a token.`,
    }
  }
  let polls = 0
  let intervalSec = start.intervalSec
  let note: string | undefined
  onEvent?.({ phase: 'waiting', start, polls })
  while (true) {
    if (cancelled())
      return { ok: false, code: 'cancelled', receipt: 'Hugging Face sign-in cancelled — nothing stored.' }
    if (now() >= start.expiresAtMs) {
      return {
        ok: false,
        code: 'expired',
        receipt: 'Hugging Face sign-in expired before the code was entered — retry from /logins.',
      }
    }
    await sleep(intervalSec * 1000)
    if (cancelled())
      return { ok: false, code: 'cancelled', receipt: 'Hugging Face sign-in cancelled — nothing stored.' }
    polls += 1
    const result = await pollHuggingfaceDeviceToken(start, io)
    if (result.state === 'unreachable') {
      note = `the Hub did not answer (${result.message}) — still trying until the code expires`
      onEvent?.({ phase: 'waiting', start, polls, note })
      continue
    }
    note = undefined
    if (result.state === 'pending') {
      onEvent?.({ phase: 'waiting', start, polls })
      continue
    }
    if (result.state === 'slow-down') {
      intervalSec += RFC_SLOW_DOWN_STEP_SEC
      onEvent?.({ phase: 'waiting', start, polls })
      continue
    }
    if (result.state === 'denied') {
      if (result.code === 'expired_token') {
        return {
          ok: false,
          code: 'expired',
          receipt: 'Hugging Face sign-in expired before the code was entered — retry from /logins.',
        }
      }
      if (result.code === 'access_denied') {
        return {
          ok: false,
          code: 'denied',
          receipt: 'Hugging Face sign-in was denied on the Hub — nothing stored.',
        }
      }
      return {
        ok: false,
        code: 'refused',
        receipt: `Hugging Face sign-in refused (${result.code}${result.description ? `: ${result.description}` : ''}) — nothing stored.`,
      }
    }
    onEvent?.({ phase: 'finishing' })
    if (cancelled()) {
      try {
        writeHuggingfaceTokens(result.tokens)
      } catch (error) {
        return {
          ok: false,
          code: 'store-failed',
          receipt: `Hugging Face authorized but the tokens could not be stored: ${errorMessageWithCause(error)} — retry from /logins.`,
        }
      }
      recordSignIn('huggingface', 'oauth')
      return {
        ok: true,
        settledAfterCancel: true,
        username: null,
        receipt: HUGGINGFACE_SETTLED_AFTER_CANCEL_RECEIPT,
      }
    }
    const probe = await fetchHuggingfaceIdentity(result.tokens.accessToken, io)
    const identity = probe.state === 'confirmed' ? probe.identity : undefined
    try {
      writeHuggingfaceTokens(result.tokens, identity)
    } catch (error) {
      return {
        ok: false,
        code: 'store-failed',
        receipt: `Hugging Face authorized but the tokens could not be stored: ${errorMessageWithCause(error)} — retry from /logins.`,
      }
    }
    recordSignIn('huggingface', 'oauth')
    const snapshot = await refresh()
    if (cancelled()) {
      return {
        ok: true,
        settledAfterCancel: true,
        username: identity?.username ?? null,
        receipt: HUGGINGFACE_SETTLED_AFTER_CANCEL_RECEIPT,
      }
    }
    return {
      ok: true,
      username: identity?.username ?? null,
      receipt: `Hugging Face connected${identity ? ` as ${identity.username}` : ''} (OAuth device flow${result.tokens.refreshToken ? ', refresh token stored' : ''})${catalogueNoteOf(snapshot)}. The rows join /model; /accounts manages the sign-in. Dispatch is ${HUGGINGFACE_UNVERIFIED_NOTE} until the first live turn settles.`,
    }
  }
}

export interface HuggingfaceTokenLoginOutcome {
  ok: boolean
  stored: boolean
  receipt: string
}

export async function storeHuggingfaceTokenLogin(
  token: string,
  io?: HuggingfaceOauthIo,
  refreshCatalogue?: () => Promise<{ models: unknown[]; lastError?: string } | null>,
): Promise<HuggingfaceTokenLoginOutcome> {
  const refresh = refreshCatalogue ?? (() => refreshHuggingfaceCatalogue({ force: true }).catch(() => null))
  const probe = await fetchHuggingfaceIdentity(token, io)
  if (probe.state === 'refused') {
    return {
      ok: false,
      stored: false,
      receipt: `The Hub refused this token (HTTP ${probe.status}) — it is not a valid Hugging Face token; check huggingface.co/settings/tokens and paste again.`,
    }
  }
  const identity: HuggingfaceIdentity | undefined = probe.state === 'confirmed' ? probe.identity : undefined
  try {
    writeStoredHuggingfaceApiKey(token)
    writeHuggingfaceTokenIdentity(token, identity ?? null)
  } catch (error) {
    return {
      ok: false,
      stored: false,
      receipt: `Could not store the token: ${String((error as Error).message ?? error)}`,
    }
  }
  const snapshot = await refresh()
  const catalogueNote = snapshot?.lastError
    ? ` The live catalogue did not answer (${snapshot.lastError}) — the token is stored; /model retries readiness.`
    : snapshot && snapshot.models.length > 0
      ? ` Live catalogue: ${snapshot.models.length} model(s) — the Hugging Face rows join /model now.`
      : ''
  return {
    ok: true,
    stored: true,
    receipt: identity
      ? `Hugging Face token stored for ${identity.username} (auth-scoped, mode 600). Requests bill your Hugging Face credits, then pay-as-you-go.${catalogueNote} Dispatch is ${HUGGINGFACE_UNVERIFIED_NOTE} until the first live turn settles.`
      : `Hugging Face token stored UNVERIFIED (auth-scoped, mode 600) — the Hub could not be reached to confirm it${probe.state === 'unreachable' ? ` (${probe.message})` : ''}; the lane refuses at dispatch if the token is wrong.${catalogueNote}`,
  }
}
