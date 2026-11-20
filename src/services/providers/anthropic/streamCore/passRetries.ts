import { APIConnectionTimeoutError } from '../../../../utils/api/sdkErrors.js'
import type { AnthropicMessageParams as BetaMessageStreamParams } from '../../../../types/anthropicWire.js'
import { randomUUID } from 'crypto'
import { logForDebugging } from 'src/utils/debug.js'
import { headlessProfilerCheckpoint } from 'src/utils/headlessProfiler.js'
import { isFirstPartyAnthropicBaseUrl } from 'src/utils/model/providers.js'
import { noteRunPhase } from 'src/utils/runPhases.js'
import type { ThinkingConfig } from 'src/utils/thinking.js'
import { noteRequestOnWire } from '../prefixLedger.js'
import type {
  Message,
  SystemAPIErrorMessage,
} from '../../../../types/message.js'
import { isTurnOwningQuerySource } from '../../../../utils/effort.js'
import { getPublicModelDisplayName } from '../../../../utils/model/model.js'
import { anthropicLimitVerdict } from '../../../anthropicLimits.js'
import { refreshProviderUsage } from '../../providerUsage.js'
import { CLIENT_REQUEST_ID_HEADER, getAnthropicClient } from '../../../api/client.js'
import { recordPromptState } from '../../../api/promptCacheBreakDetection.js'
import { withRetry } from '../../../api/withRetry.js'
import type { HeldBusyRetryWait } from '../../busyRetry.js'
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
import type { Options } from '../streamCore.js'
import { isFirstByteTimeout } from './nonStreaming.js'
import type { CallState, StreamPass } from './state.js'
import type { wireParamsFor } from './wireParams.js'
import { noteMessageEffortRefusal } from '../messageEffort.js'

type PassRetryInputs = {
  messages: Message[]
  thinkingConfig: ThinkingConfig
  signal: AbortSignal
  options: Options
  paramsFromContext: ReturnType<typeof wireParamsFor>
  captureModelRequest: (params: BetaMessageStreamParams) => void
  rosterOwnerKey: string
  heldWaitDoor: ((wait: HeldBusyRetryWait) => void) | undefined
}

export function streamPassRetries(call: CallState, pass: StreamPass, { messages, thinkingConfig, signal, options, paramsFromContext, captureModelRequest, rosterOwnerKey, heldWaitDoor }: PassRetryInputs) {
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
        system: params.system,
        toolSchemas: params.tools,
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
              }),
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
        noteMessageEffortRefusal(params.messages, sent)
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
  return generator
}

export function retryWaitOf(notice: SystemAPIErrorMessage): RequestWaitV1 {
  return {
    kind: 'retry',
    attempt: notice.retryAttempt,
    of: notice.maxRetries,
    reason: retryReasonWords(notice.errorDetail?.status ?? (notice.error as { status?: number | null } | undefined)?.status, notice.error?.message),
    delayMs: notice.retryInMs,
    sinceMs: Date.now(),
  }
}
