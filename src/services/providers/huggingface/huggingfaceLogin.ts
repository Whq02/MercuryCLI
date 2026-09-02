// ============================================================================
//  providers/huggingface/huggingfaceLogin — the /logins card's Hugging Face
//  legs as ONE driver each (the moonshotLogin shape), shared
//  by the connect surface (which only paints the phases), the Boot face's
//  logins layer, and the prover (which drives the same code path with fakes):
//
//    · runHuggingfaceDeviceLogin — the Hub's RFC 8628 flow: start, show the
//      code, poll until authorized (transport faults keep polling until the
//      code expires, the fault named), prove the fresh token live through
//      whoami, store tokens WITH the identity, kick the router catalogue,
//      and say what everything answered;
//    · storeHuggingfaceTokenLogin — the token leg: prove the token live
//      through whoami FIRST (a REFUSED token is never stored — it is
//      invalid; an UNREACHABLE Hub stores it unverified with the network
//      fault named — the two are different facts), then store auth-scoped
//      and kick the catalogue.
//
//  Receipts name facts the operator can act on and never a token value.
//  The browser open stays the SKIN's move (the first waiting event) — this
//  driver performs no live side effect a proof could not fake.
// ============================================================================
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
  /** The wait between polls (injectable so a prover never sleeps for real). */
  sleep?: (ms: number) => Promise<void>
  /** The caller's cancel flag, read between polls. */
  cancelled?: () => boolean
  onEvent?: (event: HuggingfaceDeviceLoginEvent) => void
  /** The catalogue kick's seam (the live default forces the real refresh). */
  refreshCatalogue?: () => Promise<{ models: unknown[]; lastError?: string } | null>
}

export type HuggingfaceDeviceLoginOutcome =
  | {
      ok: true
      receipt: string
      username: string | null
      /** The disclose-not-unwind ruling: the operator cancelled while the
       *  authorize answer was in flight — the vendor-approved grant is
       *  STORED (dropping it would orphan a live grant) and the receipt
       *  says so with the removal door; the surface must paint this even
       *  on an abandoned run, never drop it as a stale settle. */
      settledAfterCancel?: true
    }
  | {
      ok: false
      receipt: string
      code: 'start-failed' | 'expired' | 'denied' | 'refused' | 'cancelled' | 'store-failed'
    }

/** The mid-wait esc receipt (the poll's answer may already be in flight —
 *  the disclose-not-unwind law: a landed approval is stored and shown,
 *  never orphaned). The pre-flow cancel keeps the plain nothing-stored
 *  truth (the driver's own cancelled arms, which run before any poll). */
export const HUGGINGFACE_CONNECT_STOPPED_RECEIPT =
  'Hugging Face sign-in cancelled — if the approval was already in flight it still lands; /accounts shows and removes it.'

/** The disclosure a landed-then-cancelled sign-in answers — ONE spelling for
 *  every window (the pre-store re-check AND the whoami/catalogue stretch): a
 *  landed credential is never a silent settle, wherever the esc fell. */
export const HUGGINGFACE_SETTLED_AFTER_CANCEL_RECEIPT =
  'Hugging Face sign-in completed after cancel — the approval landed while this flow was being cancelled, so the account IS signed in (an unstored copy would orphan the live grant). ⌫ on its /accounts row signs it out.'

const RFC_SLOW_DOWN_STEP_SEC = 5

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** The catalogue line every settled leg appends — proven, never assumed. */
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
      // A transport fault settles NOTHING — keep polling until the code
      // expires, with the fault named on the surface (a dead loop under
      // a "waiting" line was the silent-hang class).
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
    // The operator may have cancelled while THIS poll's answer was on the
    // wire — the Hub approved the grant, so it exists server-side. The
    // ruling: store it (an unwound copy orphans a live grant) and DISCLOSE,
    // skipping the whoami/catalogue kicks (no extra wire spend on an
    // abandoned flow); the cancelled-before-poll arms above store nothing.
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
      // A landed grant is a sign-in on both arms (the refresh leg in
      // huggingfaceAccounts never records): the ledger the computed
      // default orders by.
      recordSignIn('huggingface', 'oauth')
      return {
        ok: true,
        settledAfterCancel: true,
        username: null,
        receipt: HUGGINGFACE_SETTLED_AFTER_CANCEL_RECEIPT,
      }
    }
    // Prove the fresh token live through whoami — never "connected" on a
    // token write alone; an unreachable Hub stores it identity-less.
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
    // The esc may have landed while whoami or the catalogue kick was on the
    // wire — past the pre-store re-check, with the store landing anyway. The
    // same disclose-not-unwind law answers it: a plain ok here would be
    // dropped by the caller's abandoned run and the landed sign-in would go
    // silent.
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
  /** True when the token reached the store (a refused token never does). */
  stored: boolean
  receipt: string
}

/** The token leg: probe, then store, then report — the token value never
 *  rides the receipt. A REFUSED token is corrected at the prompt, never
 *  stored; an UNREACHABLE Hub stores it unverified with the fault named. */
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
