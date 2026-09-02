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
              notePendingActivation(row.signal.deepLink)
            }
            await markJournalConsumed(row.seq)
          }
        } catch (e) {
          logForDebugging(`[concourse-lifecycle-signals] replay failed: ${e}`)
        }
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
