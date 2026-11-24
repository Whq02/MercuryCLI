import { randomUUID } from 'node:crypto'
import { autoFoldIfNeeded } from '../compaction/autoFold.js'
import { pruneMessages } from '../compaction/pruneToolResults.js'
import { routedCallModel } from '../../models/roads/callModelRouter.js'
import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import { scriptedCallModel } from './scriptedStream.js'

export type TurnLoopDeps = {
  uuid: () => string
  callModel: typeof routedCallModel
  autocompact: typeof autoFoldIfNeeded
  microcompact: typeof pruneMessages
}

export function productionDeps(): TurnLoopDeps {
  const script = flagEnv('MERCURY_SCRIPTED_STREAM')
  return {
    uuid: randomUUID,
    callModel: (script ? scriptedCallModel(script) : null) ?? routedCallModel,
    autocompact: autoFoldIfNeeded,
    microcompact: pruneMessages,
  }
}
