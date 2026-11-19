import type { CheckSpec } from '../../healthReport.js'
import '../../runtime/nodePolicy.js'
import '../../cockpit/deviceHeadroom.js'
import '../../observability/invocationTrace.js'
import '../../../services/lsp/mercuryLsp.js'
import '../../../services/lsp/builtinServers.js'
import '../../../services/lsp/clangdLane.js'
import '../../../services/lsp/godotLane.js'
import '../../../services/lsp/manager.js'
import '../../ripgrep.js'
import '../../../ink/colorize.js'
import '../../cockpit/mcpGauge.js'
import '../../cockpit/substrateSnapshot.js'
import '../../../services/mcp/toolPolicy.js'
import '../../../services/mcp/auth.js'
import '../../../services/mcp/protocolRevision.js'
import '../../../extensions/boot.js'
import '../../healthFix.js'
import '../../healthReport.js'
import { versionLocksCheck, crashReportsCheck, runtimeCheck, shellCheck, colorCheck, resourcesCheck, boxLockCheck, sessionKindCheck } from './runtime/host.js'
import { evalKernelsCheck, mcpCheck, extensionsCheck, mediaCheck, vulcanCheck, substrateCheck } from './runtime/services.js'
import { lspCheck, editorDoorCheck } from './runtime/lsp.js'

function editOutcomeHealthChecks(): CheckSpec[] {
  try {
    const { editOutcomeLedgerEnabled } =
      require('../../../services/changeTransaction/editOutcomeLedger.js') as typeof import('../../../services/changeTransaction/editOutcomeLedger.js')
    if (!editOutcomeLedgerEnabled()) return []
  } catch {
    return []
  }
  return [
    {
      id: 'edit-outcomes',
      label: 'Edit outcomes',
      run: async () => {
        const { editOutcomeHealthRows, editOutcomeHealthRowsOf } = await import('../../../services/changeTransaction/editOutcomeLedger.js')
        const { processMainOwner } = await import('../../../services/run/resolveOwner.js')
        const { getFocusedSessionConnector, hasFocusedSession } = await import('../../../services/engine-connector/focusedConnector.js')
        const { hasSeatLive } = await import('../../../services/engine-connector/seatLive.js')
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
