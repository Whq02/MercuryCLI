import { readLocationSourceLines, type Locationish } from '../formatters.js'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type LspRangeLike } from '../../../services/lsp/workspaceEditApply.js'
import type { MercuryLspOpOutput, OpEnv } from './types.js'
import { displayPathFor, isMethodNotFoundError, syncFileFromDisk } from './shared.js'
import { notBuilt } from '../../../pi/holes.js'

export async function opTypeDefinition(env: OpEnv): Promise<MercuryLspOpOutput> {
  return notBuilt('src/tools/LSPTool/mercuryOps/typeDefinition.ts:8')
}
