import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type WorkspaceEditLike } from '../../../services/lsp/workspaceEditApply.js'
import type { MercuryLspOpOutput, OpEnv } from './types.js'
import { syncFileFromDisk } from './shared.js'
import { prepareApply } from './prepare.js'
import { previewOf } from './preview.js'
import { applyPrepared } from './apply.js'
import { notBuilt } from '../../../pi/holes.js'

export async function opRename(env: OpEnv): Promise<MercuryLspOpOutput> {
  return notBuilt('src/tools/LSPTool/mercuryOps/rename.ts:10')
}
