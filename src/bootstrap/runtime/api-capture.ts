import type { ApiRequestParams } from '../../types/wire.js'

export class ApiCaptureOwner {
  lastAPIRequest: Omit<ApiRequestParams, 'messages'> | null = null
  lastAPIRequestMessages: ApiRequestParams['messages'] | null = null
  promptId: string | null = null
  lastMainRequestId: string | undefined = undefined
  lastApiCompletionTimestamp: number | null = null
}
