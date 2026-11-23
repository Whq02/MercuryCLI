import type { Message } from '../../types/message.js'
import { updateAgentSummary } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { filterIncompleteToolCalls } from '../../tools/AgentTool/runAgent.js'
import { logForDebugging } from '../../utils/debug.js'
import { createUserMessage } from '../messages.js'
import { runForkedAgent, type ForkedAgentParams } from '../agents/forkedAgent.js'
import { loadSubagentTranscripts } from '../../utils/sessionStorage.js'
import { startTimeout, stopTimeout } from '../../utils/timers.js'
const MIN_TRANSCRIPT_MESSAGES = 3
const SUMMARY_INTERVAL_MS = 30_000

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

function extractSummaryText(messages: Message[]): string | null {
  for (const msg of messages) {
    if (msg.type !== 'assistant' || msg.isApiErrorMessage) continue
    const content = msg.message.content
    if (!Array.isArray(content) || content.length === 0) continue
    const first = content[0]
    if (!first || first.type !== 'text') continue
    const trimmed = first.text.trim()
    if (trimmed.length > 0) return trimmed
  }
  return null
}

export function startAgentSummarization(
  taskId: string,
  agentId: string,
  cacheSafeParams: ForkedAgentParams['cacheSafeParams'],
  setAppState: SetAppState,
): { stop(): void } {
  let stopped = false
  let timer: NodeJS.Timeout | undefined
  let inflightController: AbortController | null = null
  let previousSummary: string | null = null

  const scheduleNext = (): void => {
    if (stopped) return
    timer = startTimeout(() => {
      timer = undefined
      void runOnce()
    }, SUMMARY_INTERVAL_MS)
    timer.unref?.()
  }

  const runOnce = async (): Promise<void> => {
    if (stopped) return
    try {
      const transcripts = await loadSubagentTranscripts([agentId])
      if (stopped) return
      const rawMessages = transcripts[agentId]
      if (!rawMessages || rawMessages.length < MIN_TRANSCRIPT_MESSAGES) return
      const filtered = filterIncompleteToolCalls(rawMessages)
      const controller = new AbortController()
      inflightController = controller
      const promptMessage = createUserMessage({
        content: summaryInstruction(previousSummary),
        isMeta: true,
      })
      const result = await runForkedAgent({
        promptMessages: [promptMessage],
        cacheSafeParams: {
          ...cacheSafeParams,
          forkContextMessages: filtered,
        },
        canUseTool: async () => ({
          behavior: 'deny',
          message: 'tools are unavailable to the summariser',
          decisionReason: { type: 'other', reason: 'tools are unavailable to the summariser' },
        }),
        querySource: 'agent_summary',
        forkLabel: 'agent_summary',
        skipTranscript: true,
        overrides: {
          abortController: controller,
        },
      })
      if (inflightController === controller) inflightController = null
      if (stopped) return
      const summary = extractSummaryText(result.messages)
      if (summary !== null) {
        previousSummary = summary
        updateAgentSummary(taskId, summary, setAppState)
      }
    } catch (error) {
      if (!stopped && error instanceof Error) {
        logForDebugging(`agentSummary: tick failed: ${String(error)}`)
      }
    } finally {
      inflightController = null
      scheduleNext()
    }
  }

  scheduleNext()

  return {
    stop(): void {
      stopped = true
      if (timer !== undefined) {
        stopTimeout(timer)
        timer = undefined
      }
      if (inflightController !== null) {
        inflightController.abort()
        inflightController = null
      }
    },
  }
}
