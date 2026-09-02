
import { registerAttentionGatherer } from '../../services/attention/store.js'
import type { AttentionFact } from '../../services/attention/contracts.js'
import { getOperatorName } from '../../utils/cockpit/presenceLive.js'
import { logForDebugging } from '../../utils/debug.js'
import { openObligations, subscribeObligations, type ObligationV1 } from './obligations.js'

let cachedOpen: ObligationV1[] = []
let reportedOpen = new Map<string, { sinceMs: number; title: string }>()

export function obligationFacts(
  open: readonly ObligationV1[],
  principal: string,
  nowMs: number,
): AttentionFact[] {
  const facts: AttentionFact[] = []
  const current = new Map<string, { sinceMs: number; title: string }>()
  for (const o of open) {
    if (o.principals.length > 0 && !o.principals.includes(principal)) continue
    current.set(o.obligationId, { sinceMs: o.createdAtMs, title: o.question })
    facts.push({
      subjectId: `obligation:${o.obligationId}`,
      owner: 'obligations',
      sourceEventId: `obl:${o.obligationId}:r${o.revision}`,
      bucket: 'needs-you',
      reasonCode: 'question-pending',
      reasonLabel: o.question,
      sinceMs: o.createdAtMs,
      atMs: o.updatedAtMs,
      urgency: o.urgency === 'high' ? 0 : o.expiresAtMs !== undefined && o.expiresAtMs < nowMs ? 0 : 1,
      title: o.question,
    })
  }
  for (const [obligationId, info] of reportedOpen) {
    if (current.has(obligationId)) continue
    facts.push({
      subjectId: `obligation:${obligationId}`,
      owner: 'obligations',
      sourceEventId: `obl:${obligationId}:settled:${nowMs}`,
      bucket: 'completed',
      reasonCode: 'settled',
      reasonLabel: 'the obligation settled at its owner',
      sinceMs: info.sinceMs,
      atMs: nowMs,
      urgency: 2,
      title: info.title,
    })
  }
  reportedOpen = current
  return facts
}

export function _resetObligationsBridgeForTesting(): void {
  cachedOpen = []
  reportedOpen = new Map()
}

function refreshCache(notify?: () => void): void {
  void openObligations({ scope: 'switchboard' })
    .then(rows => {
      cachedOpen = rows
      notify?.()
    })
    .catch(e => logForDebugging(`[obligations] bridge cache refresh failed: ${e}`))
}

registerAttentionGatherer(
  () => ({ attention: obligationFacts(cachedOpen, getOperatorName(), Date.now()) }),
  {
    subscribe: cb => {
      refreshCache(cb)
      const unsub = subscribeObligations(() => refreshCache(cb), { scope: 'switchboard' })
      return () => {
        unsub()
      }
    },
  },
)
