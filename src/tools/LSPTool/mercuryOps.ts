
import type { MercuryLspOpOutput, OpEnv } from './mercuryOps/types.js'
import { opServerStatus } from './mercuryOps/serverStatus.js'
import { opDiagnostics } from './mercuryOps/diagnostics.js'
import { opSwitchSourceHeader } from './mercuryOps/sourceHeader.js'
import { opRename } from './mercuryOps/rename.js'
import { opCodeActions } from './mercuryOps/codeActions.js'
import { opTypeDefinition } from './mercuryOps/typeDefinition.js'
import { opWorkspaceDiagnostics } from './mercuryOps/workspaceDiagnostics.js'
import { opPathRename } from './mercuryOps/pathRename.js'
import { opFixDiagnostic } from './mercuryOps/fixDiagnostic.js'
import { opFormatFamily } from './mercuryOps/format.js'
import { opMoveSymbol } from './mercuryOps/moveSymbol.js'
import { opCapabilities, opRawRequest } from './mercuryOps/rawRequest.js'
import { passedOver } from '../../utils/passedOver.js'
export type { MercuryLspOpInput, MercuryLspOpOutput } from './mercuryOps/types.js'
export { clearDiagnosticsBaselines } from './mercuryOps/pull.js'
export { syncServersAfterWrite, awaitDiagnosticStabilization } from './mercuryOps/afterWrite.js'
export { NO_LSP_SERVERS_CONFIGURED, serverStatusLines } from './mercuryOps/serverStatus.js'
export { actionIdentity } from './mercuryOps/codeActions.js'

export async function runMercuryLspOp(env: OpEnv): Promise<MercuryLspOpOutput> {
  try {
    await env.manager.revalidateOpenDocuments()
  } catch (error) {
    passedOver(error)
  }
  switch (env.input.operation) {
    case 'capabilities':
      return opCapabilities(env)
    case 'rawRequest':
      return opRawRequest(env)
    case 'diagnostics':
      return opDiagnostics(env)
    case 'switchSourceHeader':
      return opSwitchSourceHeader(env)
    case 'rename':
      return opRename(env)
    case 'codeActions':
      return opCodeActions(env)
    case 'typeDefinition':
      return opTypeDefinition(env)
    case 'serverStatus':
      return opServerStatus(env)
    case 'workspaceDiagnostics':
      return opWorkspaceDiagnostics(env)
    case 'pathRename':
      return opPathRename(env)
    case 'fixDiagnostic':
      return opFixDiagnostic(env)
    case 'formatDocument':
      return opFormatFamily(env, 'formatDocument')
    case 'formatRange':
      return opFormatFamily(env, 'formatRange')
    case 'organizeImports':
      return opFormatFamily(env, 'organizeImports')
    case 'moveSymbol':
      return opMoveSymbol(env)
  }
}
