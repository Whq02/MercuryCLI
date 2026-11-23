import type { ApiRequestParams } from '../../../engine/message-shapes/wire.js'

export class ApiCaptureOwner {
  lastAPIRequest: Omit<ApiRequestParams, 'messages'> | null = null
  promptId: string | null = null
  lastMainRequestId: string | undefined = undefined
  lastApiCompletionTimestamp: number | null = null
}
