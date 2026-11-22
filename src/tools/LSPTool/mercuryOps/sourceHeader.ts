import { basename, extname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { MercuryLspOpOutput, OpEnv } from './types.js'
import { displayPathFor, isMethodNotFoundError, syncFileFromDisk } from './shared.js'
import { notBuilt } from '../../../pi/holes.js'

export async function opSwitchSourceHeader(env: OpEnv): Promise<MercuryLspOpOutput> {
  return notBuilt('src/tools/LSPTool/mercuryOps/sourceHeader.ts:6')
}
