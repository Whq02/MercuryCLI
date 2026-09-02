// ============================================================================
//  services/pings/pingEngine — a session taps you when it needs you.
//
//  THE PINGS RULES: the moment any
//  session raises a permission ask or a question, or finishes a run you
//  asked for, the terminal bell rings ONCE. This engine is that tap's
//  whole policy, and nothing else:
//    · ONE truth family — it watches the attention view's own state (the
//      same facts the strip badge counts and the boards list); it never
//      invents an event and never reads a second source;
//    · RE-RING NEVER — a needs-you subject rings at most once for as long
//      as the engine lives: a re-raise, a revision bump, or a store-read
//      flap on the SAME subject stays silent (the naive per-revision
//      re-ring is the pinned poison);
//    · finished runs ring per OWNER EVENT (subject + sourceEventId): the
//      same completion replayed is silent, a genuinely new completion of
//      the same lane rings;
//    · COALESCED — taps within one second ring once (the first tap beeps
//      now and opens the window; the rest fold into it);
//    · SEED-SILENT BY OWNER TIME — a fact whose own stamp predates the
//      engine's arm is standing news: it claims its ring without a beep
//      (the badge and the board say it; a boot never beeps for old news).
//      The basis is the OWNER's own timestamp, never a settle-window guess
//      — a slow gatherer load can never turn old news into a boot beep;
//    · QUIET BY CHOICE — with the /pings bell off, events still claim
//      their ring (the rows stay; toggling back on never back-rings a
//      backlog), the beep alone is withheld. The setting is read live at
//      tap time, never cached, never repainted.
//
//  No spend, no network: the engine reads a cached in-process view and
//  writes one byte. The bell byte itself is the caller's (the hook rings
//  through the frame writer's one-door emission path).
// ============================================================================

import type { AttentionState } from '../../services/attention/contracts.js'
import { bucketItems } from '../../services/attention/contracts.js'

/** The two watched slices, in the view's own vocabulary. `atMs` is the
 *  OWNER's own stamp — the seed-silent basis. */
export interface PingViewSlice {
  /** Every needs-you item (a permission ask, a question, a decision). */
  needsYou: ReadonlyArray<{ subjectId: string; atMs: number }>
  /** Finished runs — completed-bucket items whose reason is run-completed. */
  finishedRuns: ReadonlyArray<{ subjectId: string; sourceEventId: string; atMs: number }>
}

/** Derive the watched slices from the attention fold state (the one view
 *  the strip badge and the boards already read). */
export function pingSliceOf(state: AttentionState): PingViewSlice {
  return {
    needsYou: bucketItems(state, 'needs-you'),
    finishedRuns: bucketItems(state, 'completed').filter(
      i => i.reasonCode === 'run-completed',
    ),
  }
}

export interface PingEngineDeps {
  /** Emit the one audible tap (production: the BEL byte through the frame
   *  writer's own emission door; proofs inject a recorder). */
  ringBell: () => void
  /** The /pings setting, read LIVE at tap time (config truth, never a
   *  cached copy — the toggle acts on the very next event). */
  bellEnabled: () => boolean
  /** Clock seam (proofs drive the coalescing window deterministically). */
  nowMs?: () => number
  /** Taps within this window ring once. */
  coalesceMs?: number
}

export interface PingEngine {
  /** Fold one view snapshot: claim the new events, tap for the ones that
   *  arrived after the seed settled. */
  observe(slice: PingViewSlice): void
  /** Proof seam — never product-read. */
  _stateForTesting(): {
    rungNeeds: number
    rungRuns: number
    windowOpen: boolean
  }
}

const COALESCE_MS = 1000
/** Ledger bound — the live sets are tiny (obligations retain ≤200 settled);
 *  the cap only guards a pathological feed. Oldest-first eviction. */
const MAX_LEDGER = 4096

function claimInto(ledger: Set<string>, key: string): boolean {
  if (ledger.has(key)) return false
  ledger.add(key)
  if (ledger.size > MAX_LEDGER) {
    const oldest = ledger.values().next().value
    if (oldest !== undefined) ledger.delete(oldest)
  }
  return true
}

export function createPingEngine(deps: PingEngineDeps): PingEngine {
  const now = deps.nowMs ?? Date.now
  const coalesceMs = deps.coalesceMs ?? COALESCE_MS
  /** The arm instant — a fact whose OWN stamp predates it is standing news
   *  and seeds silently, however late its gatherer's first load lands. */
  const armAtMs = now()
  /** Needs ring per SUBJECT — cumulative, so a revision bump, a re-raise or
   *  a torn-read flap can never re-ring the same need. */
  const rungNeeds = new Set<string>()
  /** Runs ring per OWNER EVENT — a new completion of the same lane rings,
   *  the same completion replayed is silent. */
  const rungRuns = new Set<string>()
  let windowUntil = 0

  const tap = (): void => {
    // The claim above already stands — quiet-by-choice withholds only the
    // beep, so toggling the bell back on never back-rings a backlog.
    if (!deps.bellEnabled()) return
    const at = now()
    if (at < windowUntil) return
    windowUntil = at + coalesceMs
    deps.ringBell()
  }

  return {
    observe(slice: PingViewSlice): void {
      let fresh = 0
      for (const item of slice.needsYou) {
        if (claimInto(rungNeeds, item.subjectId) && item.atMs > armAtMs) fresh += 1
      }
      for (const item of slice.finishedRuns) {
        if (claimInto(rungRuns, `${item.subjectId}|${item.sourceEventId}`) && item.atMs > armAtMs) {
          fresh += 1
        }
      }
      if (fresh === 0) return
      tap()
    },
    _stateForTesting() {
      return {
        rungNeeds: rungNeeds.size,
        rungRuns: rungRuns.size,
        windowOpen: now() < windowUntil,
      }
    },
  }
}
