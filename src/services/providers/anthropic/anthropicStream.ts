import type { ApiStreamEvent } from '../../../types/wire.js'
import { APIError } from '../../api/sdkErrors.js'
import { SseDecoder, type SseDecodeResult } from '../sseDecoder.js'

const MESSAGE_EVENTS = new Set(['message_start', 'message_delta', 'message_stop', 'content_block_start', 'content_block_delta', 'content_block_stop'])

export class AnthropicStream implements AsyncIterable<ApiStreamEvent> {
  private consumed = false

  private constructor(
    private readonly response: Response,
    readonly controller: AbortController,
    private readonly release: () => void,
  ) {}

  static fromSSEResponse(response: Response, controller: AbortController, release: () => void = () => {}): AnthropicStream {
    return new AnthropicStream(response, controller, release)
  }

  private decode(frame: SseDecodeResult): ApiStreamEvent | undefined {
    if (frame.kind === 'fault') return undefined
    const { event, data } = frame.event
    if (event === 'error') {
      let body: unknown
      try { body = JSON.parse(data) } catch { body = data }
      const nested = body && typeof body === 'object' && 'error' in body ? body.error : undefined
      const type = nested && typeof nested === 'object' && 'type' in nested && typeof nested.type === 'string' ? nested.type : undefined
      throw new APIError(undefined, body, undefined, this.response.headers, type)
    }
    if (!event || !MESSAGE_EVENTS.has(event)) return undefined
    return JSON.parse(data) as ApiStreamEvent
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<ApiStreamEvent> {
    if (this.consumed) throw new Error('Cannot iterate over a consumed stream')
    this.consumed = true
    const reader = this.response.body?.getReader()
    if (!reader) {
      this.controller.abort()
      this.release()
      throw new Error('Attempted to iterate over a response with no body')
    }
    const decoder = new SseDecoder()
    const abort = () => { void reader.cancel().catch(() => {}) }
    this.controller.signal.addEventListener('abort', abort, { once: true })
    try {
      while (!this.controller.signal.aborted) {
        const chunk = await reader.read()
        if (chunk.done) break
        for (const frame of decoder.push(Buffer.from(chunk.value))) {
          const part = this.decode(frame)
          if (part) yield part
        }
      }
      decoder.flush()
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) throw error
    } finally {
      this.controller.signal.removeEventListener('abort', abort)
      this.controller.abort()
      await reader.cancel().catch(() => {})
      reader.releaseLock()
      this.release()
    }
  }
}
