// ============================================================================
// crew/obligationsBridge — the durable-obligations
//  attention gatherer. attention/ stays a pure ephemeral projection BY
//  WRITTEN LAW — this bridge translates the durable OPEN rows (the
//  crew-obligations owner) into AttentionFacts and registers with the store
//  carrying the owner's own change seam, exactly the attentionBridge idiom:
//  gathers are sync pure reads over a CACHED snapshot; the cache refreshes
//  through subscribeObligations only while a real attention consumer is
//  armed (solo dormancy survives registration), plus one initial load when
//  the seam arms.
//
// Per-principal projection: the gather filters to rows addressed to
//  THIS process's operator principal (or to nobody in particular — the
//  session-operator default). needs-you facts carry the obligation's OWN
//  row identity + revision as the source event id — an unchanged row
//  replays idempotently; a settled row leaves by owner truth (the fold's
//  retraction rides the settled fact), never by silence.
// ============================================================================

import { registerAttentionGatherer } from '../../services/attention/store.js'
import type { AttentionFact } from '../../services/attention/contracts.js'
import { getOperatorName } from '../../utils/cockpit/presenceLive.js'
import { logForDebugging } from '../../utils/debug.js'
import { openObligations, subscribeObligations, type ObligationV1 } from './obligations.js'

let cachedOpen: ObligationV1[] = []
/** Rows the bridge reported OPEN before — a row that left the open set
 *  settled at the owner; emit its terminal fact exactly once. */
let reportedOpen = new Map<string, { sinceMs: number; title: string }>()

/** The PURE translation — exported for the prover; production and proof run
 *  the same path. */
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
  // The SWITCHBOARD scope — the one home-anchored file every minting side
  // writes (the daemon's asks, the crew's questions) and every other
  // consumer reads (the concourse, the host signals, the route badge). The
  // ambient cwd-hashed read this bridge carried predates the scope: it saw
  // only rows minted by THIS process's cwd and the attention view (the
  // strip badge, the boards, the ping engine) stayed blind to every
  // daemon-minted ask.
  void openObligations({ scope: 'switchboard' })
    .then(rows => {
      cachedOpen = rows
      notify?.()
    })
    .catch(e => logForDebugging(`[obligations] bridge cache refresh failed: ${e}`))
}

/** Module-scope registration (imported beside the workbench bridge by the
 *  attention consumers); arms nothing by itself — the store taps the
 *  subscribe seam only while a real consumer is armed. */
registerAttentionGatherer(
  () => ({ attention: obligationFacts(cachedOpen, getOperatorName(), Date.now()) }),
  {
    subscribe: cb => {
      // Arm: one initial load (the durable rows predate the subscriber),
      // then the owner's change seam keeps the cache live — both on the
      // switchboard scope, the same file the cache reads.
      refreshCache(cb)
      const unsub = subscribeObligations(() => refreshCache(cb), { scope: 'switchboard' })
      return () => {
        unsub()
      }
    },
  },
)
