import { APIUserAbortError } from '../../../api/sdkErrors.js'
import { getAssistantMessageFromError } from '../../../api/errors.js'
import type { QueryCtx, QueryYield } from './state.js'

export async function* failedRequestRows(ctx: QueryCtx, thrown: unknown): AsyncGenerator<QueryYield, void> {
  const { messages, messagesForAPI, modelRefusalRequest, yieldAbortedPartialText, logRequestFailure } = ctx
  const { error, errorModel } = logRequestFailure(thrown)

  if (error instanceof APIUserAbortError) {
    yield* yieldAbortedPartialText()
    return
  }

  if ((error as { status?: unknown }).status === 429) {
    await (await import('../../catalogueOnDemand.js')).readCataloguesForOtherFamilies('anthropic')
  }
  yield getAssistantMessageFromError(error, errorModel, {
    messages,
    messagesForAPI,
    modelRefusalRequest: modelRefusalRequest.current,
  })
}
