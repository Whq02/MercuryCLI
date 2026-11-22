import { z } from 'zod'
import { semanticBoolean } from '../../../utils/semanticBoolean.js'
import { EFFORT_LEVELS, type EffortLevel } from '../../../utils/effort.js'
import { lazySchema } from '../../../utils/lazySchema.js'
import { agentToolResultSchema } from '../agentToolUtils.js'
import { MERCURY_CREW_AGENT_TYPE } from '../../../constants/tools/agent.js'
import type { AgentToolProgress, ShellProgress } from '../../../types/tools.js'
import type { describeAgentRuntimeRef } from '../../../services/providers/primaryBackend.js'
import { unbuilt, type Unbuilt } from '../../../pi/holes.js'

export type Progress = Unbuilt

export const BACKGROUND_TASKS_DISABLED: Unbuilt = unbuilt('src/tools/AgentTool/agent/schema.ts:12')

export const DEFAULT_AGENT_TYPE: Unbuilt = unbuilt('src/tools/AgentTool/agent/schema.ts:14')

export type AgentToolInput = Unbuilt

const CWD_PARAM_DESCRIPTION =
  "Absolute starting directory. Starting outside the session's folder asks for permission; with isolation, its repository supplies the worktree that becomes the child's directory."

export const inputSchema: Unbuilt = unbuilt('src/tools/AgentTool/agent/schema.ts:42')

export const outputSchema: Unbuilt = unbuilt('src/tools/AgentTool/agent/schema.ts:110')

export type AgentToolOutput = z.infer<ReturnType<typeof outputSchema>> & {
  isAsync?: true
  agentName?: string
  runtimeRef?: ReturnType<typeof describeAgentRuntimeRef>
}
