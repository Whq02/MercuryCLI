import { logForDebugging } from './debug.js'
import { passedOverSoFar, setPassedOverSink } from './passedOver.js'

export function sendPassedOverToDebugLog(): void {
  setPassedOverSink(error => logForDebugging(`passed over (${passedOverSoFar().count}): ${error instanceof Error ? error.message : String(error)}`, { level: 'verbose' }))
}
