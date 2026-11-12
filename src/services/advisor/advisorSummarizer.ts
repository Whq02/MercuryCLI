
export const ADVISOR_SUMMARY_WALL_MS = 60_000

export function deadlineExpired(signal: AbortSignal): boolean {
  return signal.aborted && (signal.reason as { name?: string } | undefined)?.name === 'TimeoutError'
}

export function deadlineWords(signal: AbortSignal, budgetMs: number, what: string, err: unknown): string {
  if (deadlineExpired(signal)) return `${what} hit its ${Math.round(budgetMs / 1000)} s budget before the provider finished`
  return err instanceof Error ? err.message : String(err)
}

export async function liveAdvisorSummarizer(args: {
  systemPrompt: string
  transcript: string
  modelId: string
}): Promise<string> {
  const [{ routedCallModel }, { asSystemPrompt }, { createUserMessage }, { getEmptyToolPermissionContext }] =
    await Promise.all([
      import('../providers/callModelRouter.js'),
      import('../../utils/systemPromptType.js'),
      import('../../utils/messages.js'),
      import('../../Tool.js'),
    ])
  const signal = AbortSignal.timeout(ADVISOR_SUMMARY_WALL_MS)
  const stream = routedCallModel({
    messages: [createUserMessage({ content: `<conversation_to_fold>\n${args.transcript}\n</conversation_to_fold>` })],
    systemPrompt: asSystemPrompt([args.systemPrompt]),
    thinkingConfig: { type: 'disabled' },
    tools: [] as never,
    signal,
    options: {
      model: args.modelId,
      querySource: 'concourse_coordinator_compact',
      agents: [],
      isNonInteractiveSession: true,
      hasAppendSystemPrompt: false,
      mcpTools: [],
      maxOutputTokensOverride: 1500,
      enablePromptCaching: false,
      async getToolPermissionContext() {
        return getEmptyToolPermissionContext()
      },
    } as never,
  })
  const texts: string[] = []
  const failures: string[] = []
  try {
    for await (const ev of stream) {
      const e = ev as { type?: string; isApiErrorMessage?: boolean; message?: { content?: unknown } }
      if (e.type !== 'assistant' || e.message === undefined) continue
      const sink = e.isApiErrorMessage === true ? failures : texts
      const content = e.message.content
      if (typeof content === 'string') {
        sink.push(content)
      } else if (Array.isArray(content)) {
        for (const b of content) {
          if (b && (b as { type?: string }).type === 'text' && typeof (b as { text?: unknown }).text === 'string') {
            sink.push((b as { text: string }).text)
          }
        }
      }
    }
  } catch (err) {
    throw new Error(deadlineWords(signal, ADVISOR_SUMMARY_WALL_MS, 'the summary call', err))
  }
  const failure = failures.join('\n').trim()
  if (failure.length > 0) throw new Error(deadlineWords(signal, ADVISOR_SUMMARY_WALL_MS, 'the summary call', new Error(failure)))
  const summary = texts.join('\n').trim()
  if (summary.length === 0) throw new Error(deadlineExpired(signal) ? deadlineWords(signal, ADVISOR_SUMMARY_WALL_MS, 'the summary call', undefined) : 'the summarizer returned no text')
  return summary
}
