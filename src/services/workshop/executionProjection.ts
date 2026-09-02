// ============================================================================
//  workshop/executionProjection — Workshop runtimes on the canonical
//  execution plane.
//
//  The RUNTIME (owner × language) is the execution; cells are that
//  execution's ready↔running transitions plus a bounded recent-cell ring
//  (Δ2 — cells are high-frequency events, never one plane record
//  each). Domain semantics stay in the runtimes: evaluation, the idle-pause
//  law, interrupt-first Python cancellation, TypeScript resolution.
//
//  Generation honesty — two meanings, both true:
//    · the PLANE generation counts OS-runtime instances (register → settle →
//      register = a real replacement);
//    · the DOMAIN generation (workshopGeneration/pythonGeneration) counts
//      state epochs — a soft Python reset clears globals IN PLACE (domain
//      generation bumps, the same process keeps running, no plane
//      settlement). The resource view surfaces both.
//
//  State mapping: spawned → 'starting' · executing a cell → 'running' ·
//  alive between cells → 'ready' · killed/reset/disposed → 'stopped' ·
//  interpreter missing → 'unavailable'.
// ============================================================================

import {
  getExecution,
  registerExecution,
  settleExecution,
  transitionExecution,
} from '../primitives/executionPlane.js'
import { isTerminalExecutionState } from '../primitives/execution.js'
import { registerOwnerScopedStore } from '../run/ownerLifecycle.js'
import type { OwnerKey } from '../run/ownerKey.js'
import { OwnerScopedStore } from '../run/ownerScopedStore.js'
import type { WorkshopCellResult, WorkshopLanguage } from './contracts.js'
import { recordCanonicalEvidence } from '../primitives/evidencePlane.js'

export function workshopExecutionId(language: WorkshopLanguage): string {
  return `workshop:${language}`
}

export function workshopExecutionKind(
  language: WorkshopLanguage,
): 'workshop-js' | 'workshop-python' {
  return language === 'py' ? 'workshop-python' : 'workshop-js'
}

/** A runtime process came up (worker spawned / kernel handshake done). */
export function projectRuntimeSpawned(
  owner: OwnerKey,
  language: WorkshopLanguage,
  domainGeneration: number,
): void {
  try {
    const id = workshopExecutionId(language)
    const current = getExecution(owner, id)
    if (current && !isTerminalExecutionState(current.state)) return
    registerExecution({
      owner,
      id,
      kind: workshopExecutionKind(language),
      label: `workshop ${language}`,
      lifecycle: 'owner',
      metadata: { language, domainGeneration },
      initialState: 'starting',
    })
  } catch {
    /* projection never breaks the runtime */
  }
}

/** A cell began executing on the live runtime. */
export function projectRuntimeBusy(owner: OwnerKey, language: WorkshopLanguage): void {
  try {
    const id = workshopExecutionId(language)
    const current = getExecution(owner, id)
    if (!current || isTerminalExecutionState(current.state)) return
    if (current.state === 'starting' || current.state === 'ready') {
      transitionExecution(owner, id, 'running')
    }
  } catch {
    /* projection never breaks the runtime */
  }
}

/** The cell finished and the runtime is alive, idle, holding state. */
export function projectRuntimeIdle(owner: OwnerKey, language: WorkshopLanguage): void {
  try {
    const id = workshopExecutionId(language)
    const current = getExecution(owner, id)
    if (!current || isTerminalExecutionState(current.state)) return
    if (current.state === 'running' || current.state === 'starting') {
      transitionExecution(owner, id, 'ready')
    }
  } catch {
    /* projection never breaks the runtime */
  }
}

/** The runtime process is absent (timeout kill, cancel escalation, worker
 *  death, explicit reset, owner disposal). Retained state was lost — the
 *  settlement reason SAYS so. */
export function projectRuntimeSettled(
  owner: OwnerKey,
  language: WorkshopLanguage,
  reason: string,
): void {
  try {
    const id = workshopExecutionId(language)
    const current = getExecution(owner, id)
    if (!current || isTerminalExecutionState(current.state)) return
    settleExecution(owner, id, 'stopped', { outcome: { reason } })
  } catch {
    /* projection never breaks the runtime */
  }
}

/** The interpreter for this lane does not exist — honest unavailability. */
export function projectRuntimeUnavailable(
  owner: OwnerKey,
  language: WorkshopLanguage,
  reason: string,
): void {
  try {
    const id = workshopExecutionId(language)
    const current = getExecution(owner, id)
    if (current && !isTerminalExecutionState(current.state)) return
    if (current && current.state === 'unavailable') return
    registerExecution({
      owner,
      id,
      kind: workshopExecutionKind(language),
      label: `workshop ${language}`,
      lifecycle: 'owner',
      metadata: { language },
      initialState: 'queued',
    })
    settleExecution(owner, id, 'unavailable', { outcome: { reason } })
  } catch {
    /* projection never breaks the runtime */
  }
}

// ── the bounded recent-cell ring (Δ2: cells are events, not records) ────────

const CELL_RING_CAP = 32

const cellStore = new OwnerScopedStore<{ cells: WorkshopCellResult[] }>({
  name: 'workshop-cells',
  create: () => ({ cells: [] }),
  cap: 16,
})
registerOwnerScopedStore(cellStore)

/** Record one settled cell result (every path: success, failure, timeout,
 *  cancellation, pre-spawn refusal). Bounded; full output lives at the
 *  cell's artifact ref, never here. */
export function recordWorkshopCell(owner: OwnerKey, result: WorkshopCellResult): void {
  const ring = cellStore.get(owner)
  ring.cells.push(result)
  if (ring.cells.length > CELL_RING_CAP) {
    ring.cells.splice(0, ring.cells.length - CELL_RING_CAP)
  }
  try {
    // the cell result is observed execution evidence bound
    // to the runtime generation; full output stays at the artifact ref.
    recordCanonicalEvidence({
      owner,
      kind: 'execution',
      origin: 'observed',
      claim: `workshop ${result.language} cell ${result.cellId} ${result.state} (gen ${result.generation}${result.runtimeKilled ? ', runtime killed' : ''})`,
      refs: [
        `mercury://execution/workshop:${result.language}`,
        ...(result.artifactRef ? [result.artifactRef] : []),
      ],
      details: {
        cellId: result.cellId,
        state: result.state,
        generation: result.generation,
        durationMs: result.durationMs,
      },
    })
  } catch {
    /* evidence never breaks the cell path */
  }
}

/** Recent cells, oldest first (the slice-6 resource + slice-8 evidence feed). */
export function recentWorkshopCells(owner: OwnerKey): readonly WorkshopCellResult[] {
  return cellStore.peek(owner)?.cells ?? []
}
