import { useEffect } from 'react'
import type { TerminalNotification } from '../ink/useTerminalNotification.js'
import { getOperatorName } from '../utils/cockpit/presenceLive.js'
import { logForDebugging } from '../utils/debug.js'
import { sendNotification } from '../services/notifier.js'
import { emitConcourseSignal } from '../services/notificationPolicy.js'
import { openObligations, subscribeObligations } from '../services/crew/obligations.js'
import { notePendingActivation } from '../services/concourse/pendingActivation.js'
import { isCrossProjectFinishedRef } from '../services/concourse/crossProjectPings.js'

export function useObligationSignals(terminal: TerminalNotification): void {
  useEffect(() => {
    let cancelled = false
    const sweep = (): void => {
      void openObligations({ principal: getOperatorName(), scope: 'switchboard' })
        .then(async rows => {
          if (cancelled) return
          for (const o of rows) {
            const outcome = await emitConcourseSignal(
              {
                kind: 'needs-you',
                targetId: o.obligationId,
                revision: o.revision,
                title: isCrossProjectFinishedRef(o.ref) ? 'an agent finished in another project — switch to see it' : 'a session needs you',
                detail: o.question,
                deepLink: { sessionId: o.sessionId, obligationId: o.obligationId },
                obligationBacked: true,
              },
              { send: opts => sendNotification(opts, terminal) },
            )
            if (outcome.emitted) {
              notePendingActivation({ sessionId: o.sessionId, obligationId: o.obligationId })
            }
          }
        })
        .catch(e => logForDebugging(`[obligation-signals] sweep failed: ${e}`))
    }
    sweep()
    const unsub = subscribeObligations(sweep, { scope: 'switchboard' })
    return () => {
      cancelled = true
      unsub()
    }
  }, [terminal])
}
