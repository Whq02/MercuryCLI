import { APIConnectionTimeoutError } from '../../../api/sdkErrors.js'
import type { AnthropicStream } from '../anthropicStream.js'
import { randomUUID } from 'crypto'
import { logForDebugging } from 'src/utils/debug.js'
import { headlessProfilerCheckpoint } from 'src/utils/headlessProfiler.js'
import { isFirstPartyAnthropicBaseUrl } from 'src/utils/model/providers.js'
import { noteRunPhase } from 'src/utils/runPhases.js'
import { noteRequestOnWire } from '../prefixLedger.js'
import type { SystemAPIErrorMessage } from '../../../../types/message.js'
import { isTurnOwningQuerySource } from '../../../../utils/effort.js'
import { getPublicModelDisplayName } from '../../../../utils/model/model.js'
import { anthropicLimitVerdict } from '../../../anthropicLimits.js'
import { refreshProviderUsage } from '../../providerUsage.js'
import { CLIENT_REQUEST_ID_HEADER, getAnthropicClient } from '../../../api/client.js'
import {
  recordPromptState,
  type NeutralSystemBlock,
  type NeutralToolSchema,
} from '../../../api/promptCacheBreakDetection.js'
import { withRetry } from '../../../api/withRetry.js'
import {
  coldPrefixOf,
  estimateRequestTokens,
  firstByteBudgetMs,
  firstByteTimeoutLine,
  retryReasonWords,
  streamActivityFetchOptions,
  streamIdleTimeoutMsForRoute,
  type RequestWaitV1,
} from '../../streamIdleBudget.js'
import { isFirstByteTimeout } from './nonStreaming.js'
import type { CallState, QueryCtx, QueryYield, StreamPass } from './state.js'

export async function* openStream(ctx: QueryCtx, call: CallState, pass: StreamPass): AsyncGenerator<QueryYield, AnthropicStream> {
  const { messages, thinkingConfig, signal, options, captureModelRequest, rosterOwnerKey, paramsFromContext, heldWaitDoor } = ctx
  const { firstByte } = pass
  const generator = withRetry(
    () =>
      getAnthropicClient({
        maxRetries: 0,
        fetchOverride: options.fetchOverride,
        source: options.querySource,
      }),
    async (anthropic, attempt, context) => {
      if (attempt > 1 || anthropicLimitVerdict().status === 'rejected') await refreshProviderUsage('anthropic', { force: true, reason: 'operator' })
      call.start = Date.now()

      const params = paramsFromContext(context)
      captureModelRequest(params)

      recordPromptState({
        system: params.system as unknown as NeutralSystemBlock[],
        toolSchemas: params.tools as unknown as NeutralToolSchema[],
        querySource: options.querySource,
        model: options.model,
        agentId: options.agentId,
        betas: params.betas ?? [],
        effortValue: params.output_config?.effort as string | undefined,
        lane: 'anthropic',
        callReference: options.callReference,
      })

      call.maxOutputTokens = params.max_tokens

      const promptTokens = estimateRequestTokens({ system: params.system, tools: params.tools, messages: params.messages })
      const cold = coldPrefixOf(messages, options.model)
      const wait: Extract<RequestWaitV1, { kind: 'first-byte' }> = {
        kind: 'first-byte',
        cold,
        promptTokens,
        model: getPublicModelDisplayName(context.model) ?? context.model,
        budgetMs: firstByteBudgetMs({ cold, promptTokens, idleMs: streamIdleTimeoutMsForRoute('anthropic') }),
        sinceMs: Date.now(),
        attempt,
      }
      firstByte.wait = wait
      pass.transportSawByte = false
      options.onWait?.(wait)

      if (!options.agentId) {
        headlessProfilerCheckpoint('api_request_sent')
        noteRunPhase('dispatch')
      }

      call.clientRequestId = isFirstPartyAnthropicBaseUrl() ? randomUUID() : undefined

      const dispatch = () =>
        anthropic.beta.messages
          .create(
            { ...params, stream: true },
            {
              signal,
              timeout: wait.budgetMs,
              fetchOptions: streamActivityFetchOptions(() => {
                pass.transportSawByte = true
                pass.noteTransportActivity?.()
              }) as never,
              ...(call.clientRequestId && {
                headers: { [CLIENT_REQUEST_ID_HEADER]: call.clientRequestId },
              }),
            },
          )
          .withResponse()
      let result: Awaited<ReturnType<typeof dispatch>>
      try {
        result = await dispatch()
      } catch (sent) {
        if (!signal.aborted && isFirstByteTimeout(sent)) {
          logForDebugging(`first-byte budget fired: ${firstByteTimeoutLine(wait)}`, { level: 'warn' })
          throw new APIConnectionTimeoutError({ message: firstByteTimeoutLine(wait), requestDeadline: (sent as { requestDeadline?: unknown }).requestDeadline === true })
        }
        throw sent
      }
      options.onWait?.(null)
      call.streamRequestId = result.request_id
      call.streamResponse = result.response
      if (isTurnOwningQuerySource(options.querySource)) noteRequestOnWire(rosterOwnerKey)
      return result.data
    },
    {
      model: options.model,
      fallbackModel: options.fallbackModel,
      thinkingConfig,
      signal,
      querySource: options.querySource,
      ...(heldWaitDoor !== undefined ? { onHeldWait: heldWaitDoor } : {}),
      healClientContract: true,
    },
  )

  let e
  do {
    e = await generator.next()
    if (!('controller' in e.value)) {
      const notice = e.value as SystemAPIErrorMessage
      if (notice.type === 'system' && notice.subtype === 'api_error') {
        const retryWait: RequestWaitV1 = {
          kind: 'retry',
          attempt: notice.retryAttempt,
          of: notice.maxRetries,
          reason: retryReasonWords(notice.errorDetail?.status ?? (notice.error as { status?: number | null } | undefined)?.status, notice.error?.message),
          delayMs: notice.retryInMs,
          sinceMs: Date.now(),
        }
        options.onWait?.(retryWait)
      }
      yield e.value
    }
  } while (!e.done)
  call.stream = e.value as AnthropicStream
  return call.stream
}
