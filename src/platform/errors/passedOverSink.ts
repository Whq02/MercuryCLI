import { isDebugMode, logForDebugging } from '../logs/debugLog.js'
import { getErrnoCode } from './errors.js'
import { passedOverSoFar, setPassedOverSink } from './passedOver.js'

const SAID_AT_MOST = 4096
const NOT_THERE: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR'])

function wordsOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : Object.prototype.toString.call(error)
}

export function sendPassedOverToDebugLog(): void {
  const said = new Set<string>()
  setPassedOverSink(error => {
    if (!isDebugMode()) return
    const words = wordsOf(error)
    if (NOT_THERE.has(getErrnoCode(error) ?? '')) {
      logForDebugging(`passed over (${passedOverSoFar().count}): ${words}`, { level: 'verbose' })
      return
    }
    if (said.has(words)) return
    if (said.size >= SAID_AT_MOST) said.clear()
    said.add(words)
    logForDebugging(`passed over (${passedOverSoFar().count}): ${words}`, { level: 'debug' })
  })
}
