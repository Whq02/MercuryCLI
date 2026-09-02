// ============================================================================
//  providers/moonshot/moonshotLogin — the /logins card's Kimi legs as ONE
//  driver each, shared by the connect surface (which only paints the phases)
//  and the loopback prover (which drives the same code path end to end):
//
//    · runKimiDeviceLogin — the RFC 8628 sign-in in a region: start, show the
//      code, poll until authorized (transport faults keep polling until the
//      code expires), store the tokens WITH the region, then prove the fresh
//      bearer live through GET {coding base}/usages and say what it answered;
//    · storeMoonshotApiKeyLogin — the key leg: prove the key live through the
//      platform balance endpoint FIRST (a refused key is never stored; a dead
//      platform stores it unverified with the fault named), then store it
//      auth-scoped and report the balance.
//
//  Receipts name facts the operator can act on (the region, the base turns
//  ride, what outranks what) and never a token or key value.
// ============================================================================
import { errorMessageWithCause } from '../../../utils/errors.js'
import { writeStoredMoonshotApiKey } from '../../../utils/router/providerSecrets.js'
import {
  kimiCodingBase,
  kimiRegionLabel,
  moonshotStoredTokens,
  pollMoonshotDeviceToken,
  startMoonshotDeviceAuth,
  writeMoonshotRegion,
  writeMoonshotTokens,
  type KimiRegion,
  type MoonshotDeviceAuthStart,
  type MoonshotOauthIo,
} from './moonshotAccounts.js'
import { recordSignIn } from '../../../utils/accounts/signInLedger.js'
import {
  fetchKimiManagedUsage,
  fetchMoonshotBalance,
  type KimiManagedUsage,
  type MoonshotUsageIo,
} from './moonshotUsageState.js'

export type KimiDeviceLoginEvent =
  | { phase: 'starting' }
  | { phase: 'waiting'; start: MoonshotDeviceAuthStart; polls: number; note?: string }
  | { phase: 'finishing' }

export interface KimiDeviceLoginArgs {
  region: KimiRegion
  io?: MoonshotOauthIo & MoonshotUsageIo
  /** The wait between polls (injectable so a prover never sleeps for real). */
  sleep?: (ms: number) => Promise<void>
  /** The caller's cancel flag, read between polls. */
  cancelled?: () => boolean
  onEvent?: (event: KimiDeviceLoginEvent) => void
}

export type KimiDeviceLoginOutcome =
  | {
      ok: true
      receipt: string
      region: KimiRegion
      usage: KimiManagedUsage | null
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
export const KIMI_CONNECT_STOPPED_RECEIPT =
  'Kimi sign-in cancelled — if the approval was already in flight it still lands; /accounts shows and removes it.'

/** The disclosure a landed-then-cancelled sign-in answers — ONE spelling for
 *  every window (the pre-store re-check AND the post-store usage probe): a
 *  landed credential is never a silent settle, wherever the esc fell. */
export const KIMI_SETTLED_AFTER_CANCEL_RECEIPT =
  'Kimi sign-in completed after cancel — the approval landed while this flow was being cancelled, so the account IS signed in (an unstored copy would orphan the live grant). ⌫ on its /accounts row signs it out.'

const RFC_SLOW_DOWN_STEP_SEC = 5

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** One usage line for a receipt — the quota when stated, else the first
 *  stated window, else the plain fact that the endpoint answered. */
export function kimiUsageReceiptLine(usage: KimiManagedUsage): string {
  const window = usage.quota ?? usage.windows[0]
  if (!window) return 'usage endpoint answered (no windows stated)'
  const pct = window.limit > 0 ? ` (${Math.round((window.used / window.limit) * 100)}%)` : ''
  const reset = window.resetsAtMs !== undefined ? ` · resets ${new Date(window.resetsAtMs).toLocaleString()}` : ''
  return `usage ${window.used}/${window.limit}${pct}${reset}`
}

export async function runKimiDeviceLogin(args: KimiDeviceLoginArgs): Promise<KimiDeviceLoginOutcome> {
  const { region, io, onEvent } = args
  const sleep = args.sleep ?? defaultSleep
  const cancelled = args.cancelled ?? (() => false)
  const env = io?.env ?? process.env
  const now = (): number => io?.now?.() ?? Date.now()
  onEvent?.({ phase: 'starting' })
  // The choice is remembered BEFORE the flow runs, so an abandoned sign-in
  // still pre-focuses the operator's region next time.
  try {
    writeMoonshotRegion(region)
  } catch {
    /* the token write below reports a store failure honestly */
  }
  let start: MoonshotDeviceAuthStart
  try {
    start = await startMoonshotDeviceAuth({ ...io, region })
  } catch (error) {
    return {
      ok: false,
      code: 'start-failed',
      receipt: `Kimi sign-in could not start (${kimiRegionLabel(region)}): ${errorMessageWithCause(error)} — retry from /logins moonshot, or paste a Moonshot API key.`,
    }
  }
  let polls = 0
  let intervalSec = start.intervalSec
  let note: string | undefined
  onEvent?.({ phase: 'waiting', start, polls })
  while (true) {
    if (cancelled()) return { ok: false, code: 'cancelled', receipt: 'Kimi sign-in cancelled — nothing stored.' }
    if (now() >= start.expiresAtMs) {
      return {
        ok: false,
        code: 'expired',
        receipt: 'Kimi sign-in expired before the code was entered — retry from /logins moonshot.',
      }
    }
    await sleep(intervalSec * 1000)
    if (cancelled()) return { ok: false, code: 'cancelled', receipt: 'Kimi sign-in cancelled — nothing stored.' }
    polls += 1
    const result = await pollMoonshotDeviceToken(start, { ...io, region })
    if (result.state === 'unreachable') {
      // A transport fault settles NOTHING — keep polling until the code
      // expires, with the fault named on the surface.
      note = `the Kimi host did not answer (${result.message}) — still trying until the code expires`
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
          receipt: 'Kimi sign-in expired before the code was entered — retry from /logins moonshot.',
        }
      }
      if (result.code === 'access_denied') {
        return { ok: false, code: 'denied', receipt: 'Kimi sign-in was denied on the Kimi page — nothing stored.' }
      }
      return {
        ok: false,
        code: 'refused',
        receipt: `Kimi sign-in refused (${result.code}${result.description ? `: ${result.description}` : ''}) — nothing stored.`,
      }
    }
    onEvent?.({ phase: 'finishing' })
    // The operator may have cancelled while THIS poll's answer was on the
    // wire — the vendor page approved the grant, so it exists server-side.
    // The ruling: store it (an unwound copy orphans a live grant) and
    // DISCLOSE; the cancelled-before-poll arms above still store nothing.
    const approvedAfterCancel = cancelled()
    try {
      writeMoonshotTokens(result.tokens, region)
    } catch (error) {
      return {
        ok: false,
        code: 'store-failed',
        receipt: `Kimi authorized but the tokens could not be stored: ${errorMessageWithCause(error)} — retry from /logins moonshot.`,
      }
    }
    // The grant landed from a sign-in (the refresh leg in moonshotAccounts
    // never records): the ledger the computed default orders by.
    recordSignIn('moonshot', 'oauth')
    if (approvedAfterCancel) {
      return {
        ok: true,
        settledAfterCancel: true,
        region,
        usage: null,
        receipt: KIMI_SETTLED_AFTER_CANCEL_RECEIPT,
      }
    }
    // Prove the fresh bearer live on the base turns will ride — never
    // "connected" on a token write alone.
    const probe = await fetchKimiManagedUsage(result.tokens.accessToken, region, io)
    const usage = probe.state === 'confirmed' ? probe.usage : null
    // The esc may have landed while the USAGE PROBE was on the wire — past
    // the pre-store re-check, with the store already landed. The same
    // disclose-not-unwind law answers it: a plain ok here would be dropped
    // by the caller's abandoned run and the landed sign-in would go silent.
    if (cancelled()) {
      return { ok: true, settledAfterCancel: true, region, usage, receipt: KIMI_SETTLED_AFTER_CANCEL_RECEIPT }
    }
    const usageNote =
      probe.state === 'confirmed'
        ? kimiUsageReceiptLine(probe.usage)
        : probe.state === 'refused'
          ? `the usage endpoint refused the fresh token (HTTP ${probe.status}) — the sign-in is stored; the first turn says whether it dispatches`
          : `the usage endpoint did not answer (${probe.message}) — the sign-in is stored unverified; the first turn proves it`
    const keyShadow = env.MOONSHOT_API_KEY?.trim()
      ? ' NOTE: a MOONSHOT_API_KEY env pin is set and WINS over the sign-in this session.'
      : ''
    return {
      ok: true,
      region,
      usage,
      receipt: `Kimi connected (device-code sign-in · ${kimiRegionLabel(region)}${result.tokens.refreshToken ? ' · refresh token stored' : ''}) · ${usageNote}. Turns ride ${kimiCodingBase(region, env)} with the sign-in; the Kimi rows join /model; /accounts manages the sign-in.${keyShadow}`,
    }
  }
}

export interface MoonshotKeyLoginOutcome {
  ok: boolean
  /** True when the key reached the store (a refused key never does). */
  stored: boolean
  receipt: string
}

/** The key leg: probe, then store, then report — the key value never rides
 *  the receipt. */
export async function storeMoonshotApiKeyLogin(
  key: string,
  io?: MoonshotUsageIo,
): Promise<MoonshotKeyLoginOutcome> {
  const env = io?.env ?? process.env
  const probe = await fetchMoonshotBalance(key, io)
  if (probe.state === 'refused') {
    return {
      ok: false,
      stored: false,
      receipt: `Moonshot refused this key (HTTP ${probe.status}) — it is not a valid Moonshot API key; check platform.kimi.ai → API keys and paste again.`,
    }
  }
  try {
    writeStoredMoonshotApiKey(key)
  } catch (error) {
    return { ok: false, stored: false, receipt: `Could not store the key: ${errorMessageWithCause(error)}` }
  }
  const shadows: string[] = []
  if (env.MOONSHOT_API_KEY?.trim()) shadows.push('a MOONSHOT_API_KEY env pin is set and WINS over the store this session')
  else if (moonshotStoredTokens()) shadows.push('the Kimi sign-in outranks the stored key — ⌫ on the Kimi slot in /accounts makes the key the active source')
  const shadowNote = shadows.length > 0 ? ` NOTE: ${shadows.join('; ')}.` : ''
  if (probe.state === 'confirmed') {
    return {
      ok: true,
      stored: true,
      receipt: `Moonshot API key stored (auth-scoped, mode 600) · balance USD ${probe.balance.availableBalance} (provider-stated). Requests ride api.moonshot.ai under usage-based billing; the Kimi rows join /model.${shadowNote}`,
    }
  }
  return {
    ok: true,
    stored: true,
    receipt: `Moonshot API key stored UNVERIFIED (auth-scoped, mode 600) — the platform could not be reached to confirm it (${probe.message}); the lane refuses at dispatch if the key is wrong.${shadowNote}`,
  }
}
