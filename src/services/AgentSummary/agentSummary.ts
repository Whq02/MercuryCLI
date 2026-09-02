import type { Message } from '../../types/message.js'
import { updateAgentSummary } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { filterIncompleteToolCalls } from '../../tools/AgentTool/runAgent.js'
import { logForDebugging } from '../../utils/debug.js'
import { createUserMessage } from '../../utils/messages.js'
import { runForkedAgent, type ForkedAgentParams } from '../../utils/forkedAgent.js'
import { loadSubagentTranscripts } from '../../utils/sessionStorage.js'

/**
 * Periodic background progress summaries for coordinator-mode sub-agents,
 * produced by forking the sub-agent's conversation with the same
 * cache-safe parameters as the parent so the prompt cache is shared.
 * Cache-key discipline: tools are denied via the permission callback (not
 * removed), and no output-token budget is ever set — either change busts
 * the cache and silently doubles prompt cost.
 */

const SUMMARY_INTERVAL_MS = 30_000
const MIN_TRANSCRIPT_MESSAGES = 3

type SetAppState = Parameters<typeof updateAgentSummary>[2]

function summaryInstruction(previousSummary: string | null): string {
  const lines = [
    "Describe this agent's most recent action in 3 to 5 words.",
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
  let stopped = false
  let timer: NodeJS.Timeout | null = null
  let abortController: AbortController | null = null
  let previousSummary: string | null = null

  async function tick(): Promise<void> {
    try {
      if (stopped) return
      const transcripts = await loadSubagentTranscripts([agentId])
      const transcript = transcripts[agentId]
      if (stopped) return
      if (!transcript || transcript.length < MIN_TRANSCRIPT_MESSAGES) return
      // Rebuild the fork context from the LIVE transcript each tick — the
      // originally-supplied context messages must not stay pinned in the
      // closure for the lifetime of the timer.
      const contextMessages = filterIncompleteToolCalls(transcript)
      abortController = new AbortController()
      const instruction = createUserMessage({
        content: summaryInstruction(previousSummary),
        isMeta: true,
      })
      const result = await runForkedAgent({
        promptMessages: [instruction],
        cacheSafeParams: {
          ...cacheSafeParams,
          forkContextMessages: contextMessages,
        },
        // Deny via the callback; removing tools would change the cache key.
        canUseTool: async () => ({ behavior: 'deny', message: 'tools are unavailable to the summariser' }),
        querySource: 'agent_summary',
        forkLabel: 'agent_summary',
        overrides: { abortController },
        skipTranscript: true,
      } as unknown as ForkedAgentParams)
      if (stopped) return
      const messages = (result as { messages?: Message[] }).messages ?? []
      for (const message of messages) {
        if (message.type !== 'assistant') continue
        if ((message as { isApiErrorMessage?: boolean }).isApiErrorMessage) continue
        const content = message.message.content
        if (!Array.isArray(content)) continue
        const first = content[0] as { type?: string; text?: string } | undefined
        if (first?.type === 'text' && typeof first.text === 'string' && first.text.trim() !== '') {
          const summary = first.text.trim()
          previousSummary = summary
          updateAgentSummary(taskId, summary, setAppState)
          break
        }
      }
    } catch (err) {
      if (!stopped && err instanceof Error) {
        logForDebugging(`agentSummary: tick failed: ${String(err)}`)
      }
    } finally {
      abortController = null
      // Reschedule from the completion path only — summaries never overlap.
      if (!stopped) {
        timer = setTimeout(() => void tick(), SUMMARY_INTERVAL_MS)
        timer.unref()
      }
    }
  }

  // The first tick waits one interval too.
  timer = setTimeout(() => void tick(), SUMMARY_INTERVAL_MS)
  timer.unref()

  return {
    stop(): void {
      stopped = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      abortController?.abort()
    },
  }
}
