import { randomUUID } from 'node:crypto'
import { autoCompactIfNeeded } from '../services/compact/autoCompact.js'
import { microcompactMessages } from '../services/compact/microCompact.js'
import { routedCallModel } from '../services/providers/callModelRouter.js'
import { flagEnv } from '../substrate/flagRegistry.js'
import { scriptedCallModel } from './scriptedStream.js'

export type QueryDeps = {
  uuid: () => string
  callModel: typeof routedCallModel
  autocompact: typeof autoCompactIfNeeded
  microcompact: typeof microcompactMessages
}

export function productionDeps(): QueryDeps {
  const script = flagEnv('MERCURY_SCRIPTED_STREAM')
  return {
    uuid: randomUUID,
    callModel: (script ? scriptedCallModel(script) : null) ?? routedCallModel,
    autocompact: autoCompactIfNeeded,
    microcompact: microcompactMessages,
  }
}
