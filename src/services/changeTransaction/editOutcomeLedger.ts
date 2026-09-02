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

export function editOutcomeLedgerEnabled(): boolean {
  return !isEnvDefinedFalsy(flagEnv('MERCURY_EDIT_LEDGER'))
}

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
  }
}

export interface EditOutcomeRow {
  model: string
  surface: EditSurface
  outcome: string
  count: number
}

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

export function _resetEditOutcomeLedgerForTesting(): void {
  ledgers.clearAllForShutdown()
}
