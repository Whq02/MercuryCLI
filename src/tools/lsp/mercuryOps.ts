
import type { MercuryLspOpOutput, OpEnv } from './mercury-ops/types.js'
import { opServerStatus } from './mercury-ops/serverStatus.js'
import { opDiagnostics } from './mercury-ops/diagnostics.js'
import { opSwitchSourceHeader } from './mercury-ops/sourceHeader.js'
import { opRename } from './mercury-ops/rename.js'
import { opCodeActions } from './mercury-ops/codeActions.js'
import { opTypeDefinition } from './mercury-ops/typeDefinition.js'
import { opWorkspaceDiagnostics } from './mercury-ops/workspaceDiagnostics.js'
import { opPathRename } from './mercury-ops/pathRename.js'
import { opFixDiagnostic } from './mercury-ops/fixDiagnostic.js'
import { opFormatFamily } from './mercury-ops/format.js'
import { opMoveSymbol } from './mercury-ops/moveSymbol.js'
import { opCapabilities, opRawRequest } from './mercury-ops/rawRequest.js'
import { passedOver } from '../../platform/errors/passedOver.js'
export type { MercuryLspOpInput, MercuryLspOpOutput } from './mercury-ops/types.js'
export { clearDiagnosticsBaselines } from './mercury-ops/pull.js'
export { syncServersAfterWrite, awaitDiagnosticStabilization } from './mercury-ops/afterWrite.js'
export { NO_LSP_SERVERS_CONFIGURED, serverStatusLines } from './mercury-ops/serverStatus.js'
export { actionIdentity } from './mercury-ops/codeActions.js'

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
