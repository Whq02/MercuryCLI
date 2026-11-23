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
import { getPublicModelDisplayName } from '../../../model/model.js'
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
import type { AnthropicStream } from '../anthropicStream.js'

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

export function streamPassRetries(
  call: CallState,
  pass: StreamPass,
  {
    messages,
    thinkingConfig,
    signal,
    options,
    paramsFromContext,
    captureModelRequest,
    rosterOwnerKey,
    heldWaitDoor,
  }: PassRetryInputs,
): AsyncGenerator<SystemAPIErrorMessage, AnthropicStream> {
  return withRetry(
    () =>
      getAnthropicClient({
        maxRetries: 0,
        fetchOverride: options.fetchOverride,
        source: options.querySource,
      }),
    async (client, attempt, retryContext) => {
      if (attempt > 1 || anthropicLimitVerdict().status === 'rejected') {
        await refreshProviderUsage('anthropic', { force: true, reason: 'operator' })
      }
      call.start = Date.now()
      const params = paramsFromContext(retryContext)
      captureModelRequest(params)
      recordPromptState({
        system: Array.isArray(params.system)
          ? params.system
          : typeof params.system === 'string'
            ? [{ text: params.system }]
            : [],
        toolSchemas: params.tools ?? [],
        querySource: options.querySource,
        model: options.model,
        agentId: options.agentId,
        betas: params.betas ?? [],
        effortValue: params.output_config?.effort ?? undefined,
        lane: 'anthropic',
        callReference: options.callReference,
      })
      call.maxOutputTokens = params.max_tokens

      const promptTokens = estimateRequestTokens(
        {
          system: params.system,
          tools: params.tools,
          messages: params.messages,
        },
        options.model,
      )
      const cold = coldPrefixOf(messages, options.model)
      const budgetMs = firstByteBudgetMs({
        cold,
        promptTokens,
        idleMs: streamIdleTimeoutMsForRoute('anthropic'),
      })
      const sinceMs = Date.now()
      const wait: Extract<RequestWaitV1, { kind: 'first-byte' }> = {
        kind: 'first-byte',
        cold,
        promptTokens,
        model: getPublicModelDisplayName(retryContext.model) ?? retryContext.model,
        budgetMs,
        sinceMs,
        attempt,
      }
      pass.transportSawByte = false
      pass.firstByte.wait = wait
      options.onWait?.(wait)

      if (!options.agentId) {
        headlessProfilerCheckpoint('api_request_sent')
        noteRunPhase('dispatch')
      }

      const clientRequestId = isFirstPartyAnthropicBaseUrl() ? randomUUID() : undefined
      call.clientRequestId = clientRequestId

      try {
        const {
          data: streamData,
          response,
          request_id,
        } = await client.beta.messages
          .create(
            {
              ...params,
              stream: true,
            },
            {
              signal,
              timeout: budgetMs,
              fetchOptions: streamActivityFetchOptions(() => {
                pass.transportSawByte = true
                pass.noteTransportActivity?.()
              }),
              ...(clientRequestId !== undefined
                ? { headers: { [CLIENT_REQUEST_ID_HEADER]: clientRequestId } }
                : {}),
            },
          )
          .withResponse()
        options.onWait?.(null)
        call.streamResponse = response
        call.streamRequestId = request_id
        if (isTurnOwningQuerySource(options.querySource)) {
          noteRequestOnWire(rosterOwnerKey)
        }
        return streamData
      } catch (error) {
        if (isFirstByteTimeout(error) && !signal.aborted) {
          const requestDeadline =
            (error as { requestDeadline?: unknown } | null)?.requestDeadline === true
          const elapsedMs = requestDeadline
            ? budgetMs
            : Math.min(budgetMs, Math.max(0, Date.now() - wait.sinceMs))
          const line = firstByteTimeoutLine(wait, elapsedMs)
          logForDebugging(`first-byte budget fired: ${line}`, { level: 'warn' })
          throw new APIConnectionTimeoutError({
            message: line,
            ...(requestDeadline ? { requestDeadline: true } : {}),
          })
        }
        noteMessageEffortRefusal(params.messages, error)
        throw error
      }
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
