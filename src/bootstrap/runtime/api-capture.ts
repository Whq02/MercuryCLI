import type { ApiRequestParams } from '../../types/wire.js'

export class ApiCaptureOwner {
  lastAPIRequest: Omit<ApiRequestParams, 'messages'> | null = null
  lastAPIRequestMessages: ApiRequestParams['messages'] | null = null
  lastClassifierRequests: unknown[] | null = null
  cachedInstructionPrompt: string | null = null
  promptId: string | null = null
  lastMainRequestId: string | undefined = undefined
  lastApiCompletionTimestamp: number | null = null
  pendingPostCompaction = false

  markPostCompaction(): void {
    this.pendingPostCompaction = true
  }

  consumePostCompaction(): boolean {
    const was = this.pendingPostCompaction
    this.pendingPostCompaction = false
    return was
  }
}
