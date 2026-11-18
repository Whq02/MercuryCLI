import { logForDebugging } from '../../../utils/debug.js'
import { fluxMark } from '../../../utils/flux/fluxProbe.js'

export type Listeners = Set<() => void>

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
