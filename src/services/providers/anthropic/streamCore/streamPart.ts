import type {
  ContentBlock as BetaContentBlock,
  ApiStreamEvent as BetaRawMessageStreamEvent,
} from '../../../../types/wire.js'
import { setLastApiCompletionTimestamp } from 'src/bootstrap/state.js'
import { addToTotalSessionCost } from 'src/cost-tracker.js'
import { calculateUSDCost } from 'src/utils/modelCost.js'
import { noteCacheDiagnostics } from '../cacheDiagnostics.js'
import type { ConnectorTextDelta } from '../../../../types/connectorText.js'
import type { AssistantMessage } from '../../../../types/message.js'
import { createAssistantAPIErrorMessage } from '../../../../utils/messages.js'
import { settleTranscriptMessage } from '../../../../utils/sessionStorage/writer.js'
import {
  API_ERROR_MESSAGE_PREFIX,
  getErrorMessageIfRefusal,
  malformedStreamFrameText,
} from '../../../api/errors.js'
import { checkResponseForCacheBreak } from '../../../api/promptCacheBreakDetection.js'
import { toolCallRefusalNote } from '../../toolCallGate.js'
import { safeParseJSON } from '../../../../utils/json.js'
import type { RefusedToolCall } from '../../../../types/message.js'
import { updateUsage } from '../cacheAndUsage.js'
import type { CallState, QueryCtx, QueryYield, StreamPass } from './state.js'

export function cutToolCallOf(block: { type: string; id?: string; name?: string; input?: unknown }): RefusedToolCall | null {
  if (block.type !== 'tool_use' || typeof block.input !== 'string' || block.input.length === 0) return null
  if (safeParseJSON(block.input, false) !== null) return null
  return {
    id: block.id ?? '',
    name: block.name ?? '',
    argumentsRaw: block.input,
    argumentsLength: block.input.length,
    code: 'invalid-json',
    reason: `the arguments were not valid JSON (${block.input.length} characters arrived before the reply ended)`,
  }
}

export function* handleStreamPart(ctx: QueryCtx, call: CallState, pass: StreamPass, part: BetaRawMessageStreamEvent): Generator<QueryYield> {
  const { messages, options, newMessages, contentBlocks, stoppedBlockIndices, noteServedModel, pricingModel, mintAssistantMessage } = ctx
  switch (part.type) {
    case 'message_start': {
      call.partialMessage = part.message
      call.ttftMs = Date.now() - call.start
      call.usage = updateUsage(call.usage, part.message?.usage)
      noteServedModel(part.message?.model)
      noteCacheDiagnostics(part.message, part.message?.usage, call.ledgerFirstDifference)
      break
    }
    case 'content_block_start':
      if (part.content_block == null) {
        throw new Error(malformedStreamFrameText('content_block_start', 'content_block'))
      }
      switch (part.content_block.type) {
        case 'tool_use':
          contentBlocks[part.index] = {
            ...part.content_block,
            input: '',
          }
          break
        case 'server_tool_use':
          contentBlocks[part.index] = {
            ...part.content_block,
            input: '' as unknown as { [key: string]: unknown },
          }
          break
        case 'text':
          contentBlocks[part.index] = {
            ...part.content_block,
            text: '',
          }
          break
        case 'thinking':
          contentBlocks[part.index] = {
            ...part.content_block,
            thinking: '',
            signature: '',
          }
          break
        default:
          contentBlocks[part.index] = { ...part.content_block }
          break
      }
      break
    case 'content_block_delta': {
      const contentBlock = contentBlocks[part.index]
      const delta = part.delta as typeof part.delta | ConnectorTextDelta
      if (!contentBlock) {
        throw new RangeError('Content block not found')
      }
      if (delta == null) {
        throw new Error(malformedStreamFrameText('content_block_delta', 'delta'))
      }
      switch (delta.type) {
        case 'citations_delta':
          break
        case 'input_json_delta':
          if (
            contentBlock.type !== 'tool_use' &&
            contentBlock.type !== 'server_tool_use'
          ) {
            throw new Error('Content block is not a input_json block')
          }
          if (typeof contentBlock.input !== 'string') {
            throw new Error('Content block input is not a string')
          }
          contentBlock.input += delta.partial_json
          break
        case 'text_delta':
          if (contentBlock.type !== 'text') {
            throw new Error('Content block is not a text block')
          }
          contentBlock.text += delta.text
          break
        case 'signature_delta':
          if (contentBlock.type !== 'thinking') {
            throw new Error('Content block is not a thinking block')
          }
          contentBlock.signature = delta.signature
          break
        case 'thinking_delta':
          if (contentBlock.type !== 'thinking') {
            throw new Error('Content block is not a thinking block')
          }
          contentBlock.thinking += delta.thinking
          break
      }
      break
    }
    case 'content_block_stop': {
      const contentBlock = contentBlocks[part.index]
      if (!contentBlock) {
        throw new RangeError('Content block not found')
      }
      if (!call.partialMessage) {
        throw new Error('Message not found')
      }
      const cutCall = cutToolCallOf(contentBlock)
      if (cutCall !== null) {
        const note = mintAssistantMessage(call.partialMessage, [
          { type: 'text', text: toolCallRefusalNote('anthropic', cutCall), citations: null },
        ] as BetaContentBlock[])
        note.refusedToolCalls = [cutCall]
        stoppedBlockIndices.add(part.index)
        newMessages.push(note)
        yield note
        break
      }
      const m = mintAssistantMessage(call.partialMessage, [
        contentBlock,
      ] as BetaContentBlock[])
      stoppedBlockIndices.add(part.index)
      if (contentBlock.type === 'tool_use') {
        pass.streamedToolUse = true
      }
      newMessages.push(m)
      yield m
      break
    }
    case 'message_delta': {
      if (part.delta == null) {
        throw new Error(malformedStreamFrameText('message_delta', 'delta'))
      }
      call.usage = updateUsage(call.usage, part.usage)

      call.stopReason = part.delta.stop_reason

      const lastMsg = newMessages.at(-1)
      if (lastMsg) {
        lastMsg.message.usage = call.usage as AssistantMessage['message']['usage']
        lastMsg.message.stop_reason = call.stopReason
        void settleTranscriptMessage(lastMsg)
      }

      const costUSDForPart = calculateUSDCost(pricingModel(), call.usage)
      addToTotalSessionCost(costUSDForPart, call.usage, pricingModel())
      call.ledgerSettled = true

      void checkResponseForCacheBreak(
        options.querySource,
        call.usage.cache_read_input_tokens,
        call.usage.cache_creation_input_tokens,
        messages,
        options.agentId,
        call.clientRequestId ?? null,
      )

      const refusalMessage = getErrorMessageIfRefusal(
        part.delta.stop_reason,
        options.model,
        { requestId: call.clientRequestId ?? null, raw: part.delta },
      )
      if (refusalMessage) {
        yield { ...refusalMessage, effort: call.effortOnWire }
      }

      if (call.stopReason === 'max_tokens') {
        yield {
          ...createAssistantAPIErrorMessage({
            content: `${API_ERROR_MESSAGE_PREFIX}: Mercury's response exceeded the ${
              call.maxOutputTokens
            } output token maximum. To configure this behavior, set the MERCURY_MAX_OUTPUT_TOKENS environment variable.`,
            apiError: 'max_output_tokens',
            error: 'max_output_tokens',
          }),
          effort: call.effortOnWire,
        }
      }

      if (call.stopReason === 'model_context_window_exceeded') {
        yield {
          ...createAssistantAPIErrorMessage({
            content: `${API_ERROR_MESSAGE_PREFIX}: Mercury's response stopped at the model's context window limit.`,
            apiError: 'max_output_tokens',
            error: 'max_output_tokens',
          }),
          effort: call.effortOnWire,
        }
      }
      break
    }
    case 'message_stop':
      pass.sawMessageStop = true
      setLastApiCompletionTimestamp(Date.now())
      break
  }
}
