import type { EffortLevel } from '../../utils/effort.js'
import { logForDebugging } from '../../utils/debug.js'
import { runWithWorkload, WORKLOAD_ADVISOR } from '../../utils/workloadContext.js'

export interface AdvisorCallArgs {
  model: string
  system: string
  prompt: string
  effort?: EffortLevel
  signal?: AbortSignal
}

export type AdvisorReply = { ok: true; text: string } | { ok: false; reason: string; empty?: true }

export type AdvisorCall = (args: AdvisorCallArgs) => Promise<AdvisorReply>

export const ADVISOR_EMPTY_REASON = 'the advisor answered with no text'
export const ADVISOR_EMPTY_TWICE_REASON = 'the advisor answered with no text twice'

export function advisorReplyIsEmpty(reply: AdvisorReply): boolean {
  return reply.ok ? reply.text.trim() === '' : reply.empty === true
}

export async function callAdvisorOnceMore(call: AdvisorCall, args: AdvisorCallArgs): Promise<AdvisorReply> {
  const first = await call(args)
  if (!advisorReplyIsEmpty(first) || args.signal?.aborted === true) return first
  logForDebugging(`advisor: ${args.model} answered with no text — asking once more`)
  const second = await call(args)
  if (!advisorReplyIsEmpty(second)) return second
  logForDebugging(`advisor: ${args.model} answered with no text twice`)
  return { ok: false, reason: ADVISOR_EMPTY_TWICE_REASON, empty: true }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => ((block as { type?: string }).type === 'text' ? ((block as { text?: string }).text ?? '') : ''))
    .join('')
}

export const liveAdvisorCall: AdvisorCall = async args => {
  const [{ routedCallModelSettled }, { asSystemPrompt }, { createUserMessage }, { getEmptyToolPermissionContext }] =
    await Promise.all([
      import('../providers/callModelRouter.js'),
      import('../../utils/systemPromptType.js'),
      import('../../utils/messages/factories.js'),
      import('../../Tool.js'),
    ])
  const signal = args.signal ?? new AbortController().signal
  try {
    const settled = await runWithWorkload(WORKLOAD_ADVISOR, () =>
      routedCallModelSettled({
        messages: [createUserMessage({ content: args.prompt })],
        systemPrompt: asSystemPrompt([args.system]),
        thinkingConfig: { type: 'disabled' },
        tools: [] as never,
        signal,
        options: {
          model: args.model,
          querySource: 'advisor',
          agents: [],
          isNonInteractiveSession: true,
          hasAppendSystemPrompt: false,
          mcpTools: [],
          enablePromptCaching: false,
          ...(args.effort !== undefined ? { effortValue: args.effort } : {}),
          async getToolPermissionContext() {
            return getEmptyToolPermissionContext()
          },
        } as never,
      }),
    )
    const text = textOf(settled.message.content).trim()
    if ((settled as { isApiErrorMessage?: boolean }).isApiErrorMessage) {
      const reason = text === '' ? 'the provider refused the advisor call' : text
      logForDebugging(`advisor: ${args.model} refused — ${reason}`)
      return { ok: false, reason }
    }
    if (text === '') {
      logForDebugging(`advisor: ${args.model} answered with no text`)
      return { ok: false, reason: ADVISOR_EMPTY_REASON, empty: true }
    }
    return { ok: true, text }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    logForDebugging(`advisor: ${args.model} call failed — ${reason}`)
    return { ok: false, reason }
  }
}
