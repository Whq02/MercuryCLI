import { measuredPrefillMs, silentAfterHeadersWindowMs } from '../../streamIdleBudget.js'
import { getPublicModelDisplayName } from '../../../catalogue/engineModel.js'
import {
  streamCompatChat,
  type CompatStreamOptions,
} from '../compatChatClient.js'
import { localStreamLawFor } from '../../localLiveness.js'
import type { CompatAttemptCtx } from './attempt.js'

export function openCompatEvents(
  ctx: CompatAttemptCtx,
  extraHeaders: Record<string, string> | undefined,
  idleTimeoutMs: number,
  cold: boolean,
  promptTokens: number,
  prefillTokensPerSecond: number | undefined,
) {
  const { profile, request, apiKey, requestUrl, signal, options, modelId } = ctx
  const prefillMs = measuredPrefillMs(promptTokens, prefillTokensPerSecond)
  const pinnedSlot = typeof request.extra?.id_slot === 'number' ? request.extra.id_slot : undefined
  const streamOptions: CompatStreamOptions = {
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(profile.onResponseHeaders ? { onResponseHeaders: profile.onResponseHeaders } : {}),
    ...(extraHeaders && Object.keys(extraHeaders).length > 0 ? { extraHeaders } : {}),
    url: requestUrl,
    ...(profile.wrapFetch ? { wrapFetch: profile.wrapFetch } : {}),
    request,
    signal,
    imagesSupported: ctx.imagesSupported,
    idleTimeoutMs,
    silentAfterHeadersMs: silentAfterHeadersWindowMs({ route: profile.lane, dialect: profile.dialect, cold, promptTokens, idleMs: idleTimeoutMs, prefillTokensPerSecond }),
    ...(profile.liveness !== undefined
      ? {
          liveness: {
            fenceMs: silentAfterHeadersWindowMs({ route: profile.lane, cold, promptTokens, idleMs: idleTimeoutMs }),
            read: () => profile.liveness!(pinnedSlot),
          },
        }
      : {}),
    ...(options.onStreamActivity ? { onStreamActivity: options.onStreamActivity } : {}),
    firstByte: {
      cold,
      promptTokens,
      ...(prefillMs !== undefined ? { prefillMs } : {}),
      model: getPublicModelDisplayName(modelId) ?? modelId,
      ...(options.onWait ? { onWait: options.onWait } : {}),
    },
    ...(ctx.deferral !== undefined ? { deferral: ctx.deferral } : {}),
  }
  if (profile.lane === 'local') {
    const law = localStreamLawFor({ wireModel: request.model, cold: streamOptions.firstByte!.cold, promptTokens: streamOptions.firstByte!.promptTokens })
    if (law !== undefined) streamOptions.local = law
  }
  const transport = profile.streamTransport?.(streamOptions, ctx.preparedMessages)
  const events = transport?.events ?? streamCompatChat(streamOptions)
  return { transport, events }
}
