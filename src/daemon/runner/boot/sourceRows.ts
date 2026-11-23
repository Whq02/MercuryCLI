import { type RowScope, type RowDraft, compactionRow, type Unstamped, compactionClearedRow, waitRow, heartbeatRow } from '../../../engine/rows/project.js'
import { getSessionId } from '../../../boot/process-state/processState.js'
import { subscribeHookExecutionEvents } from '../../../integrations/event-hooks/hookEvents.js'
import { hookTaskRow } from '../../../integrations/event-hooks/rows.js'
import type { FoldStatusV1 } from '../../../engine/compaction/foldStatus.js'
import { type OutboundLine, isRowLine } from '../structuredIO.js'
import type { CompactionRow } from '../../../engine/rows/vocabulary.js'
import type { RequestWaitV1 } from '../../../models/roads/streamIdleBudget.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'

function run(ports: RunnerPorts): BootMade<'liveScope' | 'enqueueRow' | 'releaseHookRows' | 'foldLanded' | 'statusRowOf' | 'statusIsProgress' | 'promisedWaitOf'> {
  const { io, live, options, peer } = ports
  const liveScope = (): RowScope => ({ session_id: getSessionId(), ...(live.currentTurn !== null ? { turn: live.currentTurn } : {}) })
  const enqueueRow = (row: RowDraft): void => io.outbound.enqueue(row)
  const hookRowsActive = peer !== null || options.outputFormat === 'rows'
  const releaseHookRows = hookRowsActive
    ? subscribeHookExecutionEvents(event => {
        if (live.currentTurn === null) enqueueRow(hookTaskRow(liveScope(), event))
      })
    : undefined
  const foldRow = (fold: FoldStatusV1 | null): RowDraft | null => {
    if (fold !== null && fold.exit !== undefined) {
      if (fold.exit === 'landed') {
        live.openFold = { trigger: fold.trigger, landing: true }
        return null
      }
      live.openFold = null
      return compactionRow(liveScope(), fold)
    }
    if (live.openFold !== null) return fold === null || fold.stage === null ? null : compactionRow(liveScope(), fold)
    const row = compactionRow(liveScope(), fold)
    live.openFold = { trigger: row.trigger, landing: false }
    return row
  }
  const foldLanded = (row: OutboundLine): void => {
    if (isRowLine(row) && row.type === 'compaction' && (row as Unstamped<CompactionRow>).state === 'ended') live.openFold = null
  }
  const statusRowOf = (status: unknown): RowDraft | null => {
    if (status === 'compacting') return foldRow(null)
    if (status === null) {
      if (live.openFold === null || live.openFold.landing) return null
      const row = compactionClearedRow(liveScope(), live.openFold.trigger)
      live.openFold = null
      return row
    }
    if (typeof status !== 'object') return null
    const record = status as { wait?: RequestWaitV1 | null; streamActivity?: number; compacting?: FoldStatusV1 | string | null }
    if ('wait' in record) {
      const wait = record.wait ?? null
      if (wait !== null && wait.kind === 'retry') return null
      return waitRow(liveScope(), wait)
    }
    if ('streamActivity' in record) return heartbeatRow(liveScope())
    if ('compacting' in record) {
      const fold = record.compacting
      return foldRow(fold !== null && typeof fold === 'object' ? fold : null)
    }
    return null
  }
  const statusIsProgress = (status: unknown): boolean => {
    if (status === 'compacting') return true
    if (typeof status !== 'object' || status === null) return false
    if ('streamActivity' in status || 'compacting' in status) return true
    const wait = (status as { wait?: RequestWaitV1 | null }).wait
    return wait?.kind === 'first-byte' && wait.checkedMs !== undefined
  }
  const promisedWaitOf = (status: unknown): Extract<RequestWaitV1, { kind: 'first-byte' }> | null | undefined => {
    if (typeof status !== 'object' || status === null || !('wait' in status)) return undefined
    const wait = (status as { wait?: RequestWaitV1 | null }).wait
    return wait?.kind === 'first-byte' && wait.promise === true && wait.phase !== 'tokens' ? wait : null
  }
  return { liveScope, enqueueRow, releaseHookRows, foldLanded, statusRowOf, statusIsProgress, promisedWaitOf }
}

export const sourceRows: BootStep<'liveScope' | 'enqueueRow' | 'releaseHookRows' | 'foldLanded' | 'statusRowOf' | 'statusIsProgress' | 'promisedWaitOf'> = { name: 'sourceRows', makes: ['liveScope', 'enqueueRow', 'releaseHookRows', 'foldLanded', 'statusRowOf', 'statusIsProgress', 'promisedWaitOf'], run }
