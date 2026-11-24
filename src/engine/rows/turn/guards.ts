import type { getSessionId } from '../../../boot/process-state/processState.js'
import { armWorkerParentWatch } from '../../../daemon/concourse-workers/workerParentWatch.js'
import { engageCommitGate } from '../../../permissions/guards/commitGate.js'
import { registerForcedReadGuard } from '../../../permissions/guards/forcedRead.js'
import { registerRunStopGuard } from '../../../permissions/guards/runStop.js'
import { registerStructuredOutputGuard, releaseStructuredOutputGuard } from '../../../permissions/guards/structuredOutput.js'
import { registerWardsGuard } from '../../../permissions/guards/wardsGuard.js'
import { flagEnv } from '../../../platform/substrate/flagRegistry.js'
import { STRUCTURED_OUTPUT_TOOL_NAME } from '../../../tools/kit/names/structuredOutput.js'
import { assertSingleRole } from '../../../daemon/concourse-workers/workerRole.js'
import type { ConversationConfig } from '../turn.js'

export function armTurnGuards(config: ConversationConfig, sessionId: ReturnType<typeof getSessionId>): void {
  const hasSyntheticOutputTool = config.tools.some(tool => tool.name === STRUCTURED_OUTPUT_TOOL_NAME)
  if (config.jsonSchema && hasSyntheticOutputTool) registerStructuredOutputGuard(sessionId)
  else releaseStructuredOutputGuard(sessionId)
  const forcedReadList = (flagEnv('MERCURY_FORCE_READ_FILES') ?? '')
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0)
  if (forcedReadList.length > 0) registerForcedReadGuard(sessionId, forcedReadList)
  registerWardsGuard(config.setAppState, sessionId)
  registerRunStopGuard(sessionId)
  engageCommitGate(sessionId)
  assertSingleRole()
  armWorkerParentWatch()
}
