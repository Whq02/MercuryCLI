// ============================================================================
//  src/query/deps.ts — the turn loop's injectable I/O dependencies, so
//  tests pass fakes instead of patching modules. Every field is typed FROM
//  the real implementation so signatures stay in step automatically.
// ============================================================================
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

/**
 * The production wiring: the PROVIDER-ROUTED model call (GLM-family ids on
 * their native runtime, GPT-family on the native OpenAI responses runtime,
 * everything else the Anthropic path byte-identically — the routing law is
 * the router's), the two real compaction functions, and the platform UUID
 * generator.
 *
 * MERCURY_SCRIPTED_STREAM (a registered flag) names a script: a recognised
 * name swaps the model call for a bounded synthetic stream with a
 * deterministic active window (rendered-capture choreography). Unset or
 * unrecognised falls back to the router — never a dead lane.
 */
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
