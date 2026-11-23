import { APIUserAbortError } from '../../../../utils/api/sdkErrors.js'
import { getAssistantMessageFromError } from '../../../api/errors.js'
import type { QueryCtx, QueryYield } from './state.js'

export async function* failedRequestRows(ctx: QueryCtx, thrown: unknown): AsyncGenerator<QueryYield, void> {
  const { error, errorModel } = ctx.logRequestFailure(thrown)
  if (error instanceof APIUserAbortError) {
    yield* ctx.yieldAbortedPartialText()
    return
  }
  if ((error as { status?: number } | null)?.status === 429) {
    await (await import('../../catalogueOnDemand.js')).readCataloguesForOtherFamilies('anthropic')
  }
  yield getAssistantMessageFromError(error, errorModel, {
    messages: ctx.messages,
    messagesForAPI: ctx.messagesForAPI,
    modelRefusalRequest: ctx.modelRefusalRequest.current,
  })
}
