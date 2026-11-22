import { rebuildSeenLinesFromTranscript } from '../../services/changeTransaction/seenLines.js'
import { processOwnerForLane } from '../../utils/run/resolveOwner.js'
import { stat, utimes } from 'node:fs/promises'
import { getEngineModel } from '../../services/model/model.js'
import { getAgentModel } from '../../services/model/agent.js'
import { crewmateModelOverride } from '../../services/crew/crewmateModelWord.js'
import { recordAfterResume } from '../../services/crew/crewmateRecord.js'
import type { Message } from '../../types/message.js'
import type { AgentId } from '../../types/ids.js'
import type { CanUseToolFn, ToolUseContext } from '../../Tool.js'
import { assembleToolPool } from '../../tools.js'
import { latchSwarmAgent, settleSwarmAgent, swarmResumeAdmitted } from '../../services/crewBoard/seam.js'
import {
  failAgentTask,
  isLocalAgentTask,
  registerAsyncAgent,
  setAgentWaitLine,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { recordedDescription } from '../../tasks/LocalAgentTask/launchReceipts.js'
import { getTaskOutputPath } from '../../utils/task/diskOutput.js'
import {
  runWithAgentContext,
  type SubagentContext,
} from '../../utils/agentContext.js'
import { runWithCwdOverride } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  filterOrphanedThinkingOnlyMessages,
  filterWhitespaceOnlyAssistantMessages,
} from '../../services/messages.js'
import { settleToolUsesOfEndedRun } from '../../services/messages/apiFilters.js'
import { createUserMessage } from '../../services/messages.js'
import { createAttachmentMessage } from '../../services/attachments/orchestrator.js'
import { errorMessage } from '../../utils/errors.js'
import { getQuerySourceForAgent } from '../../utils/promptCategory.js'
import {
  getAgentTranscript,
  readAgentMetadata,
  writeAgentMetadata,
} from '../../utils/sessionStorage.js'
import { reconstructForSubagentResume } from '../../utils/toolResultStorage.js'
import { recordedRequestContexts, restoreBoundPrefixFromMessages } from '../../services/providers/anthropic/boundPrefixRecord.js'
import { pendingToolRosterRestore } from '../../services/providers/toolEconomy.js'
import { getSchemaBoundStructuredOutputTool, STRUCTURED_OUTPUT_TOOL_NAME } from '../SyntheticOutputTool/structuredOutputTool.js'
import { getCwdState, getSdkAgentProgressSummariesEnabled } from '../../bootstrap/state.js'
import { automaticResumePending, cancelAutomaticResume, resolveWorkerTools, runAsyncAgentLifecycle } from './agentToolUtils.js'
import { operatorPauseGate } from '../../run-core/pauseGate.js'
import { MERCURY_CREW_AGENT_TYPE } from '../../constants/tools/agent.js'
import type { AgentDefinition } from '../../types/agent.js'
import { getAgentDefinitionsWithOverrides } from './loadAgentsDir.js'
import { isBuiltInAgent } from '../../types/agent.js'
import { runAgent } from './runAgent.js'
import { continuationDirectoryNote } from './continuationNote.js'
import { EFFORT_LEVELS, isEffortLevel, resolveStampedEffortTruth, type EffortLevel } from '../../utils/effort.js'
import { liveAgentOwner } from './liveAgentOwner.js'
import { passedOver } from '../../utils/passedOver.js'
import { notBuilt } from '../../pi/holes.js'

export { liveAgentOwner }

type ResumeAgentResult = {
  agentId: string
  description: string
  outputFile: string
  cwdFallback?: 'parent-checkout' | 'parent-directory'
  recordedCwd?: string
  note?: string
}

const RESUMED_AGENT_DESCRIPTION = 'Resumed crewmate'

export class BoardResumeDirectoryError extends Error {
  constructor(readonly directory: string, readonly kind: 'worktree' | 'directory') {
    super(`The recorded ${kind} is unavailable: ${directory}.`)
  }
}

export function definitionForStoredType(
  storedType: string | undefined,
  activeAgents: readonly AgentDefinition[],
): AgentDefinition {
  return (
    activeAgents.find(agent => agent.agentType === storedType) ??
    activeAgents.find(agent => agent.agentType === MERCURY_CREW_AGENT_TYPE) ??
    activeAgents[0]!
  )
}

export function boardResumeRefusal(agentId: string, tasks: Record<string, unknown> | undefined): string | null {
  if (operatorPauseGate.holds('main') || operatorPauseGate.holds(agentId)) return 'The operator pause is still in force.'
  const owner = liveAgentOwner(agentId, tasks)
  if (owner !== null) return owner.words
  const task = tasks?.[agentId]
  if (isLocalAgentTask(task) && (task.status === 'pending' || task.status === 'killed' || task.stopReason !== undefined || task.paused !== undefined)) return 'The crewmate is held; the lead can resume it.'
  if (automaticResumePending(agentId)) return 'The provider recovery already holds this crewmate.'
  return null
}

export class AgentNotRecorded extends Error {}

export async function resumeAgentBackground(args: {
  agentId: string
  prompt: string
  toolUseContext: ToolUseContext
  canUseTool?: CanUseToolFn
  invokingRequestId?: string
  replyTarget?: 'parent' | 'operator'
  model?: string
  effort?: EffortLevel
  automatic?: boolean
  boardEventIds?: string[]
  onAdmitted?: () => void
}): Promise<ResumeAgentResult> {
  return notBuilt('src/tools/AgentTool/resumeAgent.ts:101')
}

export function operatorResumeWords(description: string): string {
  return `Crewmate "${description}" resumed from the crew view · it runs on under the same id`
}
