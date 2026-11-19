import type { AgentId } from '../../../types/ids.js'
import { type ToolUseContext, readToolCallChain } from '../../../Tool.js'
import { fireHooks } from '../../../utils/hooks/fire.js'
import { hasHooksFor } from '../../../utils/hooks/matching.js'
import { worktreeReadyOf } from '../../../utils/worktreeReadiness.js'
import { bankHookOutcomes } from '../../../utils/hooks/background.js'
import { HOOK_CUT_BUDGET_MS } from '../../../utils/hooks/contract.js'
import { EMPTY_USAGE } from '../../../services/api/emptyUsage.js'
import { type OutcomeStatus, usageOf } from '../../../rows/vocabulary.js'
import { turnCutOf } from '../../../utils/messages/rejectionText.js'
import { agentStopReasonOf } from '../../../tasks/LocalAgentTask/LocalAgentTask.js'
import { logForDebugging } from '../../../utils/debug.js'
import { errorMessage } from '../../../utils/errors.js'
import { getAgentTranscriptPath } from '../../../utils/sessionStorage.js'
import type { RunAgentParams } from '../runAgent.js'

interface CrewmateEndNeeds {
  abortController: AbortController
  crewmateRun: { usage: typeof EMPTY_USAGE; steps: number; answer: string | undefined; endedBy: OutcomeStatus; reason: string | undefined }
  startedAt: number
  hookScope: { sessionId: string; crewmateId: AgentId }
  toolUseContext: RunAgentParams['toolUseContext']
  agentId: AgentId
  childContextRef: { current: ToolUseContext | undefined }
  agentDefinition: RunAgentParams['agentDefinition']
  name: RunAgentParams['name']
  worktreePath: RunAgentParams['worktreePath']
}

export async function fireCrewmateEndOf({ abortController, crewmateRun, startedAt, hookScope, toolUseContext, agentId, childContextRef, agentDefinition, name, worktreePath }: CrewmateEndNeeds): Promise<void> {
  const aborted = abortController.signal.aborted
  const status: OutcomeStatus = aborted && crewmateRun.endedBy === 'completed' ? 'interrupted' : crewmateRun.endedBy
  const cut = aborted ? turnCutOf(abortController.signal.reason) : null
  const usage = usageOf(crewmateRun.usage)
  const wallMs = Date.now() - startedAt
  try {
    if (hasHooksFor('turn.end', hookScope, toolUseContext.getAppState()) || hasHooksFor('crewmate.end', hookScope, toolUseContext.getAppState())) await worktreeReadyOf(agentId)
    await fireHooks(
      'turn.end',
      {
        turn_id: readToolCallChain(childContextRef.current)?.key ?? agentId,
        status,
        ...(crewmateRun.reason !== undefined && status === 'failed' ? { error: { message: crewmateRun.reason, class: 'internal' } } : {}),
        ...(cut !== null ? { cut: { reason: cut.kind, ...(cut.detail !== undefined ? { detail: cut.detail } : {}), tools: [] } } : {}),
        steps: crewmateRun.steps,
        wall_ms: wallMs,
        usage,
        ...(crewmateRun.answer !== undefined ? { answer: crewmateRun.answer } : {}),
      },
      { scope: hookScope, toolUseContext: childContextRef.current ?? toolUseContext, crewmateType: agentDefinition.agentType, ...(cut !== null ? { budgetMs: HOOK_CUT_BUDGET_MS } : {}) },
    )
    const ended = await fireHooks(
      'crewmate.end',
      {
        ...(name !== undefined ? { name } : {}),
        status: status === 'failed' ? 'failed' : aborted ? 'stopped' : 'finished',
        ...(crewmateRun.reason !== undefined ? { reason: crewmateRun.reason } : aborted ? { reason: agentStopReasonOf(abortController.signal.reason) ?? 'stopped' } : {}),
        ...(crewmateRun.answer !== undefined ? { answer: crewmateRun.answer } : {}),
        ...(worktreePath !== undefined ? { worktree_path: worktreePath } : {}),
        crewmate_transcript_path: getAgentTranscriptPath(agentId),
        usage,
      },
      { scope: { sessionId: hookScope.sessionId }, toolUseContext, crewmateType: agentDefinition.agentType },
    )
    bankHookOutcomes(ended.outcomes)
  } catch (error) {
    logForDebugging(`runAgent: the end-of-crewmate hooks failed: ${errorMessage(error)}`)
  }
}
