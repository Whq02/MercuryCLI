import { foregroundNotKeptLine } from '../../../tasks/LocalAgentTask/launchReceipts.js'
import { crewWorktreeLeftoverNoted, crewWorktreeReminderTail } from '../../../services/crew/crewWorktreeReminder.js'
import { RESUME_AGENT_TOOL_NAME } from '../../../constants/tools/resumeAgent.js'
import { PROMOTED_NARRATION_NOTE, structuredResultBlock } from '../agentToolUtils.js'
import { ONE_SHOT_BUILTIN_AGENT_TYPES } from '../../../constants/tools/agent.js'
import { envelopeFor } from '../../../services/agentResults/ingest.js'
import { formatEnvelopeBlock } from '../../../services/agentResults/normalize.js'
import type { AgentToolOutput } from './schema.js'
import { notBuilt, type Unbuilt } from '../../../pi/holes.js'

function usageBlock(data: {
  totalTokens?: number
  totalToolUseCount?: number
  totalDurationMs?: number
}): string {
  const rows = [
    ...(data.totalTokens !== undefined ? [`total_tokens: ${data.totalTokens}`] : []),
    ...(data.totalToolUseCount !== undefined ? [`tool_uses: ${data.totalToolUseCount}`] : []),
    ...(data.totalDurationMs !== undefined ? [`duration_ms: ${data.totalDurationMs}`] : []),
  ]
  return rows.length > 0 ? `<usage>${rows.join('\n')}</usage>` : '<usage>unreported</usage>'
}

function continuationHint(agentId: string, name?: string): string {
  return `agentId: ${agentId} (internal — do not mention it to the user). To continue this crewmate, use ${RESUME_AGENT_TOOL_NAME} addressed to that id${name ? ` or to its name "${name}"` : ''}.`
}

function worktreeKeptLine(data: { worktreePath?: string; worktreeBranch?: string }): string | null {
  if (!data.worktreePath) return null
  const leftover = crewWorktreeLeftoverNoted(data.worktreePath)
  const at = [data.worktreeBranch ? `branch ${data.worktreeBranch}` : '', leftover?.head ? `@ ${leftover.head}` : ''].filter(Boolean).join(' ')
  return `Worktree kept: ${data.worktreePath}${at ? ` (${at})` : ''}${leftover !== null ? ` — ${crewWorktreeReminderTail(leftover, Date.now())}` : ''}`
}

export function agentToolResultBlock(
  output: AgentToolOutput,
  toolUseID: string,
): Unbuilt {
  return notBuilt('src/tools/AgentTool/agent/resultBlock.ts:34')
}
