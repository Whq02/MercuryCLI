import type { Message } from '../../types/message.js'
import { getContextWindowForModel } from '../../utils/model/capabilities.js'
import { messageContextFill } from '../../utils/tokens.js'
import { readRequestGauge, requestGaugeFixed } from '../run/requestGauge.js'

export const OUTPUT_FIT_HEADWAY_TOKENS = 1_000
export const OUTPUT_FIT_FLOOR_TOKENS = 3_000

export type OutputFit = { tokens: number; asked: number; room: number; clamped: boolean }

export function fitOutputTokens(input: { asked: number; window: number; promptTokens: number; least?: number }): OutputFit {
  const { asked, window, promptTokens } = input
  const room = window - promptTokens - OUTPUT_FIT_HEADWAY_TOKENS
  const positive = (n: number): boolean => Number.isFinite(n) && n > 0
  if (!positive(asked) || !positive(window) || !positive(promptTokens) || asked <= room) return { tokens: asked, asked, room, clamped: false }
  const tokens = Math.min(asked, Math.max(room, OUTPUT_FIT_FLOOR_TOKENS, input.least ?? 0))
  return { tokens, asked, room, clamped: tokens < asked }
}

export function promptRoomOf(messages: readonly Message[], model: string, fixed: unknown, betas?: string[]): { window: number; promptTokens: number } {
  const gauge = readRequestGauge(messages, model)
  if (gauge !== null) return { window: getContextWindowForModel(model, betas), promptTokens: gauge.tokens }
  const fill = messageContextFill(messages, model)
  const promptTokens = fill.source === 'usage' ? fill.tokens : fill.tokens + requestGaugeFixed(fixed).tokens
  return { window: getContextWindowForModel(model, betas), promptTokens }
}

export function outputRoomOf(messages: readonly Message[], model: string, fixed: unknown, betas?: string[]): number {
  const { window, promptTokens } = promptRoomOf(messages, model, fixed, betas)
  return window - promptTokens - OUTPUT_FIT_HEADWAY_TOKENS
}

export function fitOutputTokensForRequest(input: {
  asked: number
  messages: readonly Message[]
  model: string
  fixed: unknown
  betas?: string[]
  least?: number
}): OutputFit {
  return fitOutputTokens({ asked: input.asked, ...promptRoomOf(input.messages, input.model, input.fixed, input.betas), least: input.least })
}

export function outputFitWords(fit: OutputFit, model: string): string {
  return `output fit on ${model}: asked ${fit.asked} tokens, the window leaves ${Math.max(0, fit.room)} — sending ${fit.tokens}`
}
