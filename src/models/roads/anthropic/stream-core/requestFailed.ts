import { APIError, APIUserAbortError } from '../../../../engine/request-parts/sdkErrors.js'
import { getAssistantMessageFromError } from '../../../../engine/requests/apiErrorRows.js'
import type { QueryCtx, QueryYield } from './callState.js'

export async function* failedRequestRows(ctx: QueryCtx, thrown: unknown): AsyncGenerator<QueryYield, void> {
  const { error, errorModel } = ctx.logRequestFailure(thrown)
  if (error instanceof APIUserAbortError) {
    yield* ctx.yieldAbortedPartialText()
    return
  }
  if (error instanceof APIError && error.status === 429) {
    await (await import('../../catalogueOnDemand.js')).readCataloguesForOtherFamilies('anthropic')
  }
  yield getAssistantMessageFromError(error, errorModel, {
    messages: ctx.messages,
    messagesForAPI: ctx.messagesForAPI,
    modelRefusalRequest: ctx.modelRefusalRequest.current,
  })
}
