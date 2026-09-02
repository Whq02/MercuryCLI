// ============================================================================
//  changeTransaction/editOutcomeLedger — the per-model edit-outcome counts
//  (FN-013 LOOP-06).
//
//  Mercury routes ten provider families over three edit surfaces (the Edit
//  tool, ChangeSet, the opt-in anchor-patch dialect), each with a closed
//  typed failure vocabulary — and counted nothing: a model repeatedly
//  emitting unparseable hunks or stale anchors showed up only as slow
//  progress, and the anchor-patch registry row's "real-model shakedown"
//  graduation had no instrument to report against. Every terminal outcome
//  of an edit attempt now counts as (model id, surface, outcome), where
//  outcome is 'applied', 'no-change', or the surface's existing typed
//  failure spelling — no new vocabulary. Counts are owner-scoped and
//  reaped with the owner; no path, edit content or prompt text is ever
//  recorded. Display tier: the off arm (MERCURY_EDIT_LEDGER=0) removes the
//  counters entirely — recording no-ops and every read answers empty.
//
//  Writers: the toolExecution chokepoint (the Edit tool's validation
//  refusals by error code + its terminal effect outcomes) and the
//  ChangeSetTool settle chokepoint (typed refusal codes via the
//  formatter's own grammar readers in changeSetPlan). Reader: /health.
// ============================================================================
import { flagEnv } from '../../substrate/flagRegistry.js'
import { isEnvDefinedFalsy } from '../../utils/envUtils.js'
import type { OwnerKey } from '../run/ownerKey.js'
import { registerOwnerScopedStore } from '../run/ownerLifecycle.js'
import { OwnerScopedStore } from '../run/ownerScopedStore.js'

export type EditSurface = 'edit' | 'changeset' | 'anchor-patch'

type LedgerState = { counts: Map<string, number> }

const SEP = '\x00'
const ledgers = new OwnerScopedStore<LedgerState>({
  name: 'edit-outcomes',
  create: () => ({ counts: new Map() }),
})
registerOwnerScopedStore(ledgers)

/** Display-tier gate (registered as MERCURY_EDIT_LEDGER): default-on;
 *  `=0` removes the counters entirely. Read live per call. */
export function editOutcomeLedgerEnabled(): boolean {
  return !isEnvDefinedFalsy(flagEnv('MERCURY_EDIT_LEDGER'))
}

/** Count one terminal outcome. Never throws; never records content. */
export function recordEditOutcome(
  owner: OwnerKey,
  model: string,
  surface: EditSurface,
  outcome: string,
): void {
  if (!editOutcomeLedgerEnabled()) return
  try {
    const key = `${model}${SEP}${surface}${SEP}${outcome}`
    const state = ledgers.get(owner)
    state.counts.set(key, (state.counts.get(key) ?? 0) + 1)
  } catch {
    /* a counter must never become a tool hazard */
  }
}

export interface EditOutcomeRow {
  model: string
  surface: EditSurface
  outcome: string
  count: number
}

/** The raw rows (peek — a read never creates an owner). */
export function editOutcomeRows(owner: OwnerKey): EditOutcomeRow[] {
  if (!editOutcomeLedgerEnabled()) return []
  const state = ledgers.peek(owner)
  if (!state) return []
  const rows: EditOutcomeRow[] = []
  for (const [key, count] of state.counts) {
    const [model, surface, outcome] = key.split(SEP)
    if (model === undefined || surface === undefined || outcome === undefined) continue
    rows.push({ model, surface: surface as EditSurface, outcome, count })
  }
  return rows
}

export interface EditOutcomeHealthRow {
  model: string
  attempts: number
  applied: number
  topFailure: string | null
  topFailureCount: number
}

/** The /health projection: one row per model that attempted an edit —
 *  attempts, applied, top failure spelling and its count. A session with
 *  no attempts answers no rows (never zeroed rows). */
export function editOutcomeHealthRows(owner: OwnerKey): EditOutcomeHealthRow[] {
  const byModel = new Map<string, { attempts: number; applied: number; failures: Map<string, number> }>()
  for (const row of editOutcomeRows(owner)) {
    let agg = byModel.get(row.model)
    if (!agg) {
      agg = { attempts: 0, applied: 0, failures: new Map() }
      byModel.set(row.model, agg)
    }
    agg.attempts += row.count
    if (row.outcome === 'applied') {
      agg.applied += row.count
    } else if (row.outcome !== 'no-change') {
      agg.failures.set(row.outcome, (agg.failures.get(row.outcome) ?? 0) + row.count)
    }
  }
  return [...byModel.entries()].map(([model, agg]) => {
    let topFailure: string | null = null
    let topFailureCount = 0
    for (const [outcome, count] of agg.failures) {
      if (count > topFailureCount) {
        topFailure = outcome
        topFailureCount = count
      }
    }
    return { model, attempts: agg.attempts, applied: agg.applied, topFailure, topFailureCount }
  })
}

/** TEST-ONLY: whole-store reset (proof harnesses). */
export function _resetEditOutcomeLedgerForTesting(): void {
  ledgers.clearAllForShutdown()
}
