import { randomUUID } from 'node:crypto'
import type { AssistantMessage } from '../../types/message.js'
type CompletionRequest = { model: string; system: string; prompt: string; signal: AbortSignal }
type CompletionReply = { model: string; costUsd: number | null; inputTokens: number; outputTokens: number } & ({ ok: true; text: string } | { ok: false; error: string })

export const completeExternal = async (request: CompletionRequest): Promise<CompletionReply> => {
  const [{ routedCallModel, settleAssistantTurn }, { asSystemPrompt }, { createUserMessage }, { getEmptyToolPermissionContext }, { sessionThinkingConfig }, { runWithWorkload }, { getWorkloadUsage, getWorkloadUnpricedTurns }] = await Promise.all([
    import('../providers/callModelRouter.js'),
    import('../../utils/systemPromptType.js'),
    import('../../utils/messages/factories.js'),
    import('../../Tool.js'),
    import('../../utils/thinking.js'),
    import('../../utils/workloadContext.js'),
    import('../../cost-tracker.js'),
  ])
  const workload = `external_${randomUUID().replaceAll('-', '').slice(0, 27)}`
  const settled: AssistantMessage[] = []
  let error: string | undefined
  let text = ''
  let model = request.model
  await runWithWorkload(workload, async () => {
    try {
      request.signal.throwIfAborted()
      for await (const message of routedCallModel({
        messages: [createUserMessage({ content: request.prompt })],
        systemPrompt: asSystemPrompt([request.system]),
        thinkingConfig: sessionThinkingConfig(),
        tools: [],
        signal: request.signal,
        options: {
          model: request.model,
          querySource: 'sdk',
          isNonInteractiveSession: true,
          agents: [],
          hasAppendSystemPrompt: false,
          mcpTools: [],
          getToolPermissionContext: async () => getEmptyToolPermissionContext(),
        },
      })) {
        if (message.type === 'assistant') {
          if (message.isApiErrorMessage) error = message.message.content.filter(b => b.type === 'text').map(b => b.text).join('') || 'The model refused the request.'
          else settled.push(message)
        } else if (message.type === 'system' && message.subtype === 'stream_cut') error = message.content
      }
      const answer = settleAssistantTurn(settled, request.signal.aborted)
      model = answer.message.model || request.model
      text = answer.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
      if (!error && answer.message.stop_reason !== 'end_turn' && answer.message.stop_reason !== 'stop_sequence') error = 'The model did not finish the response.'
      if (!error && !text.trim()) error = 'The model returned no response.'
    } catch (failure) {
      error ??= failure instanceof Error ? failure.message : String(failure)
    }
  })
  const metered = Object.values(getWorkloadUsage()[workload] ?? {})
  const unpriced = Object.values(getWorkloadUnpricedTurns()[workload] ?? {}).some(count => count > 0)
  const usage = {
    model,
    costUsd: !metered.length || unpriced ? null : metered.reduce((sum, row) => sum + row.costUSD, 0),
    inputTokens: metered.reduce((sum, row) => sum + row.inputTokens + row.cacheReadInputTokens + row.cacheCreationInputTokens, 0),
    outputTokens: metered.reduce((sum, row) => sum + row.outputTokens, 0),
  }
  return error ? { ...usage, ok: false, error } : { ...usage, ok: true, text } satisfies CompletionReply
}
