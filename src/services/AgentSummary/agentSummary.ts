import type { Message } from '../../types/message.js'
import { updateAgentSummary } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { filterIncompleteToolCalls } from '../../tools/AgentTool/runAgent.js'
import { logForDebugging } from '../../utils/debug.js'
import { createUserMessage } from '../messages.js'
import { runForkedAgent, type ForkedAgentParams } from '../agents/forkedAgent.js'
import { loadSubagentTranscripts } from '../../utils/sessionStorage.js'
import { startTimeout, stopTimeout } from '../../utils/timers.js'
import { notBuilt } from '../../pi/holes.js'
const MIN_TRANSCRIPT_MESSAGES = 3

type SetAppState = Parameters<typeof updateAgentSummary>[2]

function summaryInstruction(previousSummary: string | null): string {
  const lines = [
    "Describe this crewmate's most recent action in 3 to 5 words.",
    'Use the present progressive tense.',
    'Name the file or function being worked on, never the branch.',
    'Do not use any tools.',
    'Good examples: "Editing worktree janitor tests" · "Reading settings pipeline code" · "Fixing mailbox reaper race".',
    'Bad (past tense): "Edited the tests". Bad (too vague): "Working on code". Bad (too long): "Currently in the process of carefully editing several files". Bad (branch): "Working on feature/foo".',
  ]
  if (previousSummary !== null) {
    lines.push(`The previous summary was "${previousSummary}" — say something different from it.`)
  }
  return lines.join('\n')
}

export function startAgentSummarization(
  taskId: string,
  agentId: string,
  cacheSafeParams: ForkedAgentParams['cacheSafeParams'],
  setAppState: SetAppState,
): { stop(): void } {
  return notBuilt('src/services/AgentSummary/agentSummary.ts:31')
}
