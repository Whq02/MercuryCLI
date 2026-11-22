import { randomUUID } from 'node:crypto'
import { toolMatchesName, type ToolPermissionContext, type ToolUseContext } from '../../Tool.js'
import { asAgentId } from '../../types/ids.js'
import { ALL_AGENT_DISALLOWED_TOOLS } from '../../constants/tools.js'
import { clearGuards } from '../../guards/guards.js'
import { registerStructuredOutputGuard } from '../../guards/structuredOutput.js'
import { readCatalogueIfPending } from '../providers/catalogueOnDemand.js'
import { declaredRouteOf } from '../providers/routeLaw.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from '../../constants/tools/syntheticOutput.js'
import { createSyntheticOutputTool } from '../../tools/SyntheticOutputTool/SyntheticOutputTool.js'
import { createAbortController } from '../../utils/abortController.js'
import { createCombinedAbortSignal } from '../../utils/combinedAbortSignal.js'
import { errorMessage } from '../../utils/errors.js'
import { createUserMessage, handleMessageFromStream } from '../messages.js'
import { stripExplicitNulls } from '../../utils/messages/structuredOutputDialect.js'
import { forgetAgentEffortWord, noteAgentEffortWord } from '../../utils/effort.js'
import { getEngineModel } from '../model/model.js'
import { utilityCallFor } from '../model/utilityModel.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { hookAnswerJsonSchema, hookBrief, type ModelHookEnd, type ModelHookRun } from './questionRunner.js'
import { toolPermissionForHooks } from '../../utils/hooks/toolPermission.js'
import { passedOver } from '../../utils/passedOver.js'
import { notBuilt } from '../../pi/holes.js'

const CREWMATE_HOOK_TURN_CAP = 50

export async function runCrewmateHook(run: ModelHookRun): Promise<ModelHookEnd> {
  return notBuilt('src/services/hooks/crewmateRunner.ts:38')
}
