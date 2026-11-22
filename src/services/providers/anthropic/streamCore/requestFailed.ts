import { APIUserAbortError } from '../../../../utils/api/sdkErrors.js'
import { getAssistantMessageFromError } from '../../../api/errors.js'
import type { QueryCtx, QueryYield } from './state.js'
import { notBuilt } from '../../../../pi/holes.js'

export async function* failedRequestRows(ctx: QueryCtx, thrown: unknown): AsyncGenerator<QueryYield, void> {
  return notBuilt('src/services/providers/anthropic/streamCore/requestFailed.ts:5')
}
