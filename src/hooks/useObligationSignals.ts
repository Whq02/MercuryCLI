// ============================================================================
// useObligationSignals — the VISIBLE process's
//  host-signal tap for durable needs-you obligations.
//
//  Subscribes to the crew-obligations owner and, on every store change,
//  routes each OPEN row addressed to this operator through the notification
//  POLICY layer (per-user setting → obligation-revision dedup → the
//  notifier). Edge-triggered by construction: the policy's revision claim
//  makes replays free — reconnect/restart/re-mount re-walk the same rows and
//  emit NOTHING for already-emitted (or acknowledged) revisions. Workers are
//  headless and never mount this hook — host emission belongs to the one
//  visible process (worker-terminal-inheritance stays impossible).
//
//  In-app attention is independent (the attention projection renders the
//  rows regardless); this hook only adds the HOST half.
// ============================================================================
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
                // The finished-elsewhere kind (cross-project awareness, law
                // 5) names itself even with the detail preview off.
                title: isCrossProjectFinishedRef(o.ref) ? 'an agent finished in another project — switch to see it' : 'a session needs you',
                detail: o.question,
                deepLink: { sessionId: o.sessionId, obligationId: o.obligationId },
                obligationBacked: true,
              },
              { send: opts => sendNotification(opts, terminal) },
            )
            // a host-EMITTED signal points the activation memory at
            // its exact target (suppressed/deduped signals never re-point).
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
