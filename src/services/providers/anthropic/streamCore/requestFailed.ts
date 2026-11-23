import { APIUserAbortError } from '../../../../utils/api/sdkErrors.js'
import { getAssistantMessageFromError } from '../../../api/errors.js'
import type { QueryCtx, QueryYield } from './state.js'

export async function* failedRequestRows(ctx: QueryCtx, thrown: unknown): AsyncGenerator<QueryYield, void> {
  const { error, errorModel } = ctx.logRequestFailure(thrown)
  if (error instanceof APIUserAbortError || ctx.signal.aborted) {
    yield* ctx.yieldAbortedPartialText()
    return
  }
  yield getAssistantMessageFromError(error, errorModel, {
    messages: ctx.messages,
    messagesForAPI: ctx.messagesForAPI,
    modelRefusalRequest: ctx.modelRefusalRequest.current,
  })
}
