import { appendFileSync } from 'node:fs'
import { flagEnv } from '../../../substrate/flagRegistry.js'
import { logForDebugging } from '../../../utils/debug.js'
import { fluxMark } from '../../../utils/flux/fluxProbe.js'

export type Listeners = Set<() => void>

export const ECHO_RETIRE_MS = 10 * 60_000

export function connectorTrace(entry: Record<string, unknown>): void {
  const path = flagEnv('MERCURY_CONNECTOR_TRACE')
  if (!path) return
  try {
    appendFileSync(path, `${JSON.stringify({ t: Date.now(), ...entry })}\n`)
  } catch {
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
