import { evaluateLaunchAuthority } from '../../services/switchboard/launchAuthority.js'
import { buildTool, type Tool as ToolShape, type ToolDef, type ToolUseContext } from '../../Tool.js'
import { getDenyRuleForAgent } from '../../utils/permissions/decision/rules.js'
import { reasonForRule, refusalWithReason, ruleSentence } from '../../utils/permissions/ruleReason.js'
import { AGENT_TOOL_NAME } from '../../constants/tools/agent.js'
import { agentRosterOf, getPrompt, withoutAgentRoster } from './prompt.js'
import { swarmSessionEnabled } from '../../services/crewBoard/seam.js'
import * as UI from './UI.js'
import { isResultTruncated } from './UI.js'
import type { CanUseToolFn } from '../../Tool.js'
import type { AgentDefinition } from '../../types/agent.js'
import type { AssistantMessage } from '../../types/message.js'
import { type Progress, type AgentToolInput, inputSchema, outputSchema, type AgentToolOutput } from './agent/schema.js'
import { agentCwdQuestion } from './agent/cwd.js'
import { mcpServerNamesWithTools, agentToolCall } from './agent/call.js'
import { agentToolResultBlock } from './agent/resultBlock.js'
import { unbuilt, type Unbuilt } from '../../pi/holes.js'
export type { Progress, AgentToolInput, AgentToolOutput } from './agent/schema.js'
export { inputSchema, outputSchema } from './agent/schema.js'
export { resolveAgentCwd, agentCwdQuestion } from './agent/cwd.js'

const RESULT_SIZE_CAP = 100_000


export const AgentTool: Unbuilt = unbuilt('src/tools/AgentTool/AgentTool.tsx:25')

