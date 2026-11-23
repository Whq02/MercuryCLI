import { appendFileSync } from 'node:fs'
import { flagEnv } from '../../../platform/substrate/flagRegistry.js'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import type { PastedContent } from '../../../platform/config/schema.js'
import { fluxMark } from '../../../integrations/media-flux/fluxProbe.js'
import type { SendReceiptV1 } from '../types.js'
import { passedOver } from '../../../platform/errors/passedOver.js'

export type Listeners = Set<() => void>

export interface SeatSend {
  clientMessageId: string
  text: string
  draftKey?: string
  sentAtMs: number
  state: 'pending' | 'unconfirmed' | 'delivered' | 'queued' | 'taken'
  heldFor?: 'compaction'
  crossedRunner?: true
  mode: 'prompt' | 'bash'
  source?: { text: string; mode: 'prompt' | 'bash'; pastedContents: Record<number, PastedContent> }
  withdrawing?: true
}

export const ECHO_RETIRE_MS = 10 * 60_000
export const REFUSED_EMPTY: SendReceiptV1 = Object.freeze<SendReceiptV1>({ state: 'refused', detail: 'nothing to send' })

export function connectorTrace(entry: Record<string, unknown>): void {
  const path = flagEnv('MERCURY_CONNECTOR_TRACE')
  if (!path) return
  try {
    appendFileSync(path, `${JSON.stringify({ t: Date.now(), ...entry })}\n`)
  } catch (error) {
    passedOver(error)
  }
}

export function emitAll(listeners: Listeners, what: string): void {
  fluxMark(`emit:${what}`)
  for (const l of [...listeners]) {
    try {
      l()
    } catch (e) {
      logForDebugging(`[engine-connector] daemon ${what} listener threw (ignored): ${e}`)
    }
  }
}
