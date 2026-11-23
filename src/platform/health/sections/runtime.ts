import type { CheckSpec } from '../healthReport.js'
import { versionLocksCheck, crashReportsCheck, runtimeCheck, shellCheck, colorCheck, resourcesCheck, boxLockCheck, sessionKindCheck } from './runtime/host.js'
import { evalKernelsCheck, mcpCheck, extensionsCheck, mediaCheck, vulcanCheck, substrateCheck } from './runtime/services.js'
import { lspCheck, editorDoorCheck } from './runtime/lsp.js'

function editOutcomeHealthChecks(): CheckSpec[] {
  try {
    const { editOutcomeLedgerEnabled } =
      require('../../../tools/engines/change-transaction/editOutcomeLedger.js') as typeof import('../../../tools/engines/change-transaction/editOutcomeLedger.js')
    if (!editOutcomeLedgerEnabled()) return []
  } catch (error) {
    return [{
      id: 'edit-outcomes',
      label: 'Edit outcomes',
      run: () => {
        throw error
      },
    }]
  }
  return [
    {
      id: 'edit-outcomes',
      label: 'Edit outcomes',
      run: async () => {
        const { editOutcomeHealthRows, editOutcomeHealthRowsOf } = await import('../../../tools/engines/change-transaction/editOutcomeLedger.js')
        const { processMainOwner } = await import('../../../engine/run-owner/resolveOwner.js')
        const { getFocusedSessionConnector, hasFocusedSession } = await import('../../../engine/connector/focusedConnector.js')
        const { hasSeatLive } = await import('../../../engine/connector/seatLive.js')
        const focused = hasFocusedSession() ? getFocusedSessionConnector() : null
        const seat = focused !== null && hasSeatLive(focused) ? focused : null
        const sessionRows = seat?.editOutcomes?.()
        if (seat !== null && sessionRows === null) return { status: 'off', evidence: "the session's runner reports no edit ledger (an older runner)" }
        const rows = sessionRows !== undefined && sessionRows !== null ? editOutcomeHealthRowsOf(sessionRows) : editOutcomeHealthRows(processMainOwner())
        if (rows.length === 0) return { status: 'ok', evidence: 'no edit attempts this session' }
        return {
          status: 'info',
          evidence: rows
            .map(
              row =>
                `${row.model}: ${row.attempts} attempt(s), ${row.applied} applied${row.topFailure !== null ? `, top failure ${row.topFailure} ×${row.topFailureCount}` : ''}`,
            )
            .join(' · '),
        }
      },
    },
  ]
}

export function runtimeChecks(): CheckSpec[] {
  return [
    versionLocksCheck(),
    crashReportsCheck(),
    ...editOutcomeHealthChecks(),
    runtimeCheck(),
    shellCheck(),
    evalKernelsCheck(),
    colorCheck(),
    mcpCheck(),
    extensionsCheck(),
    mediaCheck(),
    lspCheck(),
    editorDoorCheck(),
    vulcanCheck(),
    substrateCheck(),
    resourcesCheck(),
    boxLockCheck(),
    sessionKindCheck(),
  ]
}
