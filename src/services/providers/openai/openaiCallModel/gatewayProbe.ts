import {
  type OpenaiRequestAuth,
} from '../openaiAccounts.js'
import { streamOpenaiResponses } from '../openaiClient.js'
import {
  type GatewayProbeAnswer,
} from '../../deferralProbe.js'
import type {
  OpenaiResponsesRequest,
} from '../openaiWire.js'

const OPENAI_GATEWAY_PROBE_TIMEOUT_MS = 15_000

export async function sendOpenaiGatewayProbe(
  body: OpenaiResponsesRequest | Record<string, unknown>,
  auth: OpenaiRequestAuth,
  outer: AbortSignal,
): Promise<GatewayProbeAnswer> {
  const controller = new AbortController()
  const onOuterAbort = (): void => controller.abort()
  outer.addEventListener('abort', onOuterAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), OPENAI_GATEWAY_PROBE_TIMEOUT_MS)
  timer.unref?.()
  try {
    const events = streamOpenaiResponses({
      baseUrl: auth.baseUrl,
      headers: auth.headers,
      request: body as unknown as OpenaiResponsesRequest,
      signal: controller.signal,
      idleTimeoutMs: OPENAI_GATEWAY_PROBE_TIMEOUT_MS,
      skipFaultCapture: true,
    })
    for await (const event of events) {
      if (event.type === 'stream-fault') {
        return { status: event.fault.status ?? null, bodyText: event.fault.wireMessage ?? event.fault.message }
      }
      controller.abort()
      return { status: 200, bodyText: '' }
    }
    return { status: 200, bodyText: '' }
  } catch (error) {
    return { status: null, bodyText: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
    outer.removeEventListener('abort', onOuterAbort)
  }
}
