// ============================================================================
//  useConcourseLifecycleSignals — the VISIBLE
//  process's replay half of the cross-process emission journal.
//
//  The daemon's seams DECIDE lifecycle signals (started at the positive
//  worker start · completed at the explicit release · failed at the crash
//  reconcile) and journal them — a headless daemon has no host toast. This
//  hook replays UNSEEN journal rows through the notification POLICY with
//  the REAL sender: the policy's claim on destination 'host' makes the
//  daemon-decision + visible-replay pair emit EXACTLY ONCE (a crash between
//  replay and cursor advance re-runs into a duplicate-revision refusal,
//  never a second toast). Store-watch driven with a bounded poll backstop;
//  workers are headless and never mount this hook (the sibling
//  useObligationSignals law).
// ============================================================================
import { useEffect } from 'react'
import type { TerminalNotification } from '../ink/useTerminalNotification.js'
import { logForDebugging } from '../utils/debug.js'
import { sendNotification } from '../services/notifier.js'
import {
  emitConcourseSignal,
  markJournalConsumed,
  readUnseenJournalSignals,
  subscribeNotificationJournal,
} from '../services/notificationPolicy.js'
import { notePendingActivation } from '../services/concourse/pendingActivation.js'

const POLL_MS = 15_000

export function useConcourseLifecycleSignals(terminal: TerminalNotification): void {
  useEffect(() => {
    let cancelled = false
    let replaying = false
    const replay = (): void => {
      if (replaying) return
      replaying = true
      void (async () => {
        try {
          const rows = await readUnseenJournalSignals()
          for (const row of rows) {
            if (cancelled) return
            const outcome = await emitConcourseSignal(row.signal, { send: opts => sendNotification(opts, terminal) })
            if (outcome.emitted && row.signal.deepLink !== undefined) {
              // The emitted toast points the activation memory.
              notePendingActivation(row.signal.deepLink)
            }
            await markJournalConsumed(row.seq)
          }
        } catch (e) {
          logForDebugging(`[concourse-lifecycle-signals] replay failed: ${e}`)
        }
        // the SAME cadence folds unseen daemon-side
        // coordinator receipts onto this process's feed through the one
        // registered classifier (foreign-pid rows only; cursor-guarded).
        // INSIDE the re-entrancy guard (FN-017 rank 14): it used to run
        // after the guard cleared, so the journal subscription or the 15 s
        // tick could start a second fold over the same snapshot before the
        // cursor advanced — both ingesting, and the per-fold sourceEventId
        // keeping the two rows from coalescing.
        try {
          const { foldJournaledCoordinatorReceipts } = await import('../services/concourse/coordinatorReceipts.js')
          await foldJournaledCoordinatorReceipts()
        } catch (e) {
          logForDebugging(`[concourse-lifecycle-signals] receipt-journal fold failed: ${e}`)
        } finally {
          replaying = false
        }
      })()
    }
    replay()
    const unsub = subscribeNotificationJournal(replay)
    const timer = setInterval(replay, POLL_MS)
    timer.unref?.()
    return () => {
      cancelled = true
      unsub()
      clearInterval(timer)
    }
  }, [terminal])
}
