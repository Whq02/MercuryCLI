
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
  }
}

export function projectRuntimeBusy(owner: OwnerKey, language: WorkshopLanguage): void {
  try {
    const id = workshopExecutionId(language)
    const current = getExecution(owner, id)
    if (!current || isTerminalExecutionState(current.state)) return
    if (current.state === 'starting' || current.state === 'ready') {
      transitionExecution(owner, id, 'running')
    }
  } catch {
  }
}

export function projectRuntimeIdle(owner: OwnerKey, language: WorkshopLanguage): void {
  try {
    const id = workshopExecutionId(language)
    const current = getExecution(owner, id)
    if (!current || isTerminalExecutionState(current.state)) return
    if (current.state === 'running' || current.state === 'starting') {
      transitionExecution(owner, id, 'ready')
    }
  } catch {
  }
}

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
  }
}

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
  }
}


const CELL_RING_CAP = 32

const cellStore = new OwnerScopedStore<{ cells: WorkshopCellResult[] }>({
  name: 'workshop-cells',
  create: () => ({ cells: [] }),
  cap: 16,
})
registerOwnerScopedStore(cellStore)

export function recordWorkshopCell(owner: OwnerKey, result: WorkshopCellResult): void {
  const ring = cellStore.get(owner)
  ring.cells.push(result)
  if (ring.cells.length > CELL_RING_CAP) {
    ring.cells.splice(0, ring.cells.length - CELL_RING_CAP)
  }
  try {
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
  }
}

export function recentWorkshopCells(owner: OwnerKey): readonly WorkshopCellResult[] {
  return cellStore.peek(owner)?.cells ?? []
}
