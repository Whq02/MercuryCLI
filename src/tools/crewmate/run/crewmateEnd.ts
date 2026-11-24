import type { AgentId } from '../../../sessions/transcripts/ids.js'
import { type ToolUseContext, readToolCallChain } from '../../kit/tool.js'
import { fireHooks } from '../../../integrations/event-hooks/fire.js'
import { hasHooksFor } from '../../../integrations/event-hooks/matching.js'
import { worktreeReadyOf } from './worktreeReadiness.js'
import { bankHookOutcomes } from '../../../integrations/event-hooks/background.js'
import { HOOK_CUT_BUDGET_MS } from '../../../integrations/event-hooks/contract.js'
import { EMPTY_USAGE } from '../../../engine/request-parts/emptyUsage.js'
import { type OutcomeStatus, usageOf } from '../../../engine/rows/vocabulary.js'
import { turnCutOf } from '../../../engine/message-shapes/rejectionText.js'
import { crewmateStopReasonOf } from '../../../engine/tasks/local-agent/crewmateTask.js'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import { errorMessage } from '../../../platform/errors/errors.js'
import { getCrewmateTranscriptPath } from '../../../sessions/transcripts/sessionStorage.js'
import type { RunCrewmateParams } from '../runCrewmate.js'

interface CrewmateEndNeeds {
  abortController: AbortController
  crewmateRun: { usage: typeof EMPTY_USAGE; steps: number; answer: string | undefined; endedBy: OutcomeStatus; reason: string | undefined }
  startedAt: number
  hookScope: { sessionId: string; crewmateId: AgentId }
  toolUseContext: RunCrewmateParams['toolUseContext']
  agentId: AgentId
  childContextRef: { current: ToolUseContext | undefined }
  agentDefinition: RunCrewmateParams['agentDefinition']
  name: RunCrewmateParams['name']
  worktreePath: RunCrewmateParams['worktreePath']
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
        ...(crewmateRun.reason !== undefined ? { reason: crewmateRun.reason } : aborted ? { reason: crewmateStopReasonOf(abortController.signal.reason) ?? 'stopped' } : {}),
        ...(crewmateRun.answer !== undefined ? { answer: crewmateRun.answer } : {}),
        ...(worktreePath !== undefined ? { worktree_path: worktreePath } : {}),
        crewmate_transcript_path: getCrewmateTranscriptPath(agentId),
        usage,
      },
      { scope: { sessionId: hookScope.sessionId }, toolUseContext, crewmateType: agentDefinition.agentType },
    )
    bankHookOutcomes(ended.outcomes)
  } catch (error) {
    logForDebugging(`runAgent: the end-of-crewmate hooks failed: ${errorMessage(error)}`)
  }
}
