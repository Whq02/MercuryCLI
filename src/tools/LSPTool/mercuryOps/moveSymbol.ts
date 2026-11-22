import { extname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type WorkspaceEditLike } from '../../../services/lsp/workspaceEditApply.js'
import { expandPath } from '../../../utils/path.js'
import type { MercuryLspOpOutput, OpEnv } from './types.js'
import { displayPathFor, isMethodNotFoundError, syncFileFromDisk } from './shared.js'
import { remedyForUnclaimedExtension } from './pull.js'
import { prepareApply } from './prepare.js'
import { previewOf } from './preview.js'
import { applyPrepared } from './apply.js'
import { notBuilt } from '../../../pi/holes.js'

export async function opMoveSymbol(env: OpEnv): Promise<MercuryLspOpOutput> {
  return notBuilt('src/tools/LSPTool/mercuryOps/moveSymbol.ts:12')
}
