import { isDebugMode, logForDebugging } from './debug.js'
import { passedOverSoFar, setPassedOverSink } from './passedOver.js'

const SAID_AT_MOST = 4096

function wordsOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : Object.prototype.toString.call(error)
}

export function sendPassedOverToDebugLog(): void {
  const said = new Set<string>()
  setPassedOverSink(error => {
    if (!isDebugMode()) return
    const words = wordsOf(error)
    if (said.has(words)) return
    if (said.size >= SAID_AT_MOST) said.clear()
    said.add(words)
    logForDebugging(`passed over (${passedOverSoFar().count}): ${words}`, { level: 'debug' })
  })
}
