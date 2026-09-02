import { randomUUID } from 'node:crypto'
import { routedCallModel } from '../services/providers/callModelRouter.js'
import { microcompactMessages } from '../services/compact/microCompact.js'
import { autoCompactIfNeeded } from '../services/compact/autoCompact.js'
import { scriptedCallModel } from './scriptedStream.js'
import { flagEnv } from '../substrate/flagRegistry.js'

export type QueryDeps = {
  callModel: typeof routedCallModel
  microcompact: typeof microcompactMessages
  autocompact: typeof autoCompactIfNeeded
  uuid: () => string
}

export function productionDeps(): QueryDeps {
  const script = flagEnv('MERCURY_SCRIPTED_STREAM')
  const scripted = script ? scriptedCallModel(script) : null
  return {
    callModel: scripted ?? routedCallModel,
    microcompact: microcompactMessages,
    autocompact: autoCompactIfNeeded,
    uuid: () => randomUUID(),
  }
}
