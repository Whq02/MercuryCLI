import type { getSessionId } from '../../bootstrap/state.js'
import { armWorkerParentWatch } from '../../daemon/workerParentWatch.js'
import { engageCommitGate } from '../../guards/commitGate.js'
import { registerForcedReadGuard } from '../../guards/forcedRead.js'
import { registerRunStopGuard } from '../../guards/runStop.js'
import { registerStructuredOutputGuard, releaseStructuredOutputGuard } from '../../guards/structuredOutput.js'
import { registerWardsGuard } from '../../guards/wardsGuard.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from '../../tools/SyntheticOutputTool/constants.js'
import { assertSingleRole } from '../../utils/workerRole.js'
import type { ConversationConfig } from '../turn.js'

export function armTurnGuards(config: ConversationConfig, sessionId: ReturnType<typeof getSessionId>): void {
  const hasSyntheticOutputTool = config.tools.some(tool => tool.name === SYNTHETIC_OUTPUT_TOOL_NAME)
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
