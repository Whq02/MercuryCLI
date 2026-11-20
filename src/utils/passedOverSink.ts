import { logForDebugging } from './debug.js'
import { passedOverSoFar, setPassedOverSink } from './passedOver.js'

function wordsOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : Object.prototype.toString.call(error)
}

export function sendPassedOverToDebugLog(): void {
  setPassedOverSink(error => logForDebugging(`passed over (${passedOverSoFar().count}): ${wordsOf(error)}`, { level: 'verbose' }))
}
