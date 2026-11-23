import type { Message } from '../../message-shapes/message.js'
import { createUserMessage } from '../../message-shapes/factories.js'
import { turnCutResultText } from '../../message-shapes/turnCut.js'
import { flushSessionStorage } from '../../../sessions/transcripts/sessionStorage.js'
import type { RowDraft } from '../project.js'
import { passedOver } from '../../../platform/errors/passedOver.js'

interface CutNeeds {
  turnMessages: Message[]
  messages: Message[]
  openCalls: Map<string, string>
  toolOutcomes: Map<string, 'ok' | 'error' | 'aborted'>
  persistenceDisabled: boolean
  recordDelta: () => Promise<void>
  trackCalls: (rows: RowDraft[]) => RowDraft[]
  rowsOfMessage: (message: Message, parentCallId: string | undefined) => RowDraft[]
}

export function openCallsCutter({ turnMessages, messages, openCalls, toolOutcomes, persistenceDisabled, recordDelta, trackCalls, rowsOfMessage }: CutNeeds): (limit: string) => AsyncGenerator<RowDraft> {
  const cutOpenCalls = async function* (limit: string): AsyncGenerator<RowDraft> {
    const words = turnCutResultText({ kind: 'cut', detail: limit })
    for (const reply of [...turnMessages]) {
      if (reply.type !== 'assistant') continue
      for (const block of reply.message.content) {
        if (block.type !== 'tool_use' || !openCalls.has(block.id)) continue
        toolOutcomes.set(block.id, 'aborted')
        const result = createUserMessage({ content: [{ type: 'tool_result', content: words, is_error: true, tool_use_id: block.id }], toolUseResult: words, sourceToolAssistantUUID: reply.uuid })
        messages.push(result)
        turnMessages.push(result)
        await recordDelta()
        for (const row of trackCalls(rowsOfMessage(result, undefined))) yield row
      }
    }
    if (!persistenceDisabled) await flushSessionStorage().catch(passedOver)
  }
  return cutOpenCalls
}
