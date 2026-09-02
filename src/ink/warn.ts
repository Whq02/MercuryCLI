import { logForDebugging } from '../utils/debug.js'

export function ifNotInteger(value: number | undefined, name: string): void {
  if (value === undefined) return
  if (Number.isInteger(value)) return
  logForDebugging(`${name} should be an integer, got ${value}`, {
    level: 'warn',
  })
}

const onceSeen = new Set<string>()
/** Emit a warning exactly once per message per process (the debug channel —
 *  never stderr, which would corrupt a live frame). */
export function once(message: string): void {
  if (onceSeen.has(message)) return
  onceSeen.add(message)
  logForDebugging(message, { level: 'warn' })
}
