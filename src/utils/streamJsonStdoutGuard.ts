import { registerCleanup } from './cleanupRegistry.js'
import { logForDebugging } from './debug.js'

/**
 * Line-buffered stdout guard for the machine-readable streaming output
 * mode: a stray write from any dependency must not corrupt the client's
 * line-by-line NDJSON parse, so non-JSON lines are diverted to stderr.
 */

/** Prefix on diverted lines; logs and tests grep for it. */
export const STDOUT_GUARD_MARKER = '[stdout-guard]'

let installed = false
let originalWrite: typeof process.stdout.write | null = null
let lineBuffer = ''

function isParseableJson(line: string): boolean {
  try {
    JSON.parse(line)
    return true
  } catch {
    return false
  }
}

export function installStreamJsonStdoutGuard(): void {
  if (installed) return
  installed = true
  const realWrite = process.stdout.write.bind(process.stdout)
  originalWrite = process.stdout.write

  const guardedWrite = (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    maybeCallback?: (error?: Error | null) => void,
  ): boolean => {
    const callback = typeof encodingOrCallback === 'function' ? encodingOrCallback : maybeCallback
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    lineBuffer += text

    let lastForwardReturn: boolean | null = null
    let newlineIndex = lineBuffer.indexOf('\n')
    while (newlineIndex !== -1) {
      const line = lineBuffer.slice(0, newlineIndex)
      lineBuffer = lineBuffer.slice(newlineIndex + 1)
      // Empty lines are valid so trailing newlines and blank separators do
      // not trip the guard.
      if (line === '' || isParseableJson(line)) {
        lastForwardReturn = realWrite(`${line}\n`)
      } else {
        process.stderr.write(`${STDOUT_GUARD_MARKER} ${line}\n`)
        logForDebugging(`stdout guard diverted a non-JSON line: ${line.slice(0, 200)}`)
      }
      newlineIndex = lineBuffer.indexOf('\n')
    }

    // The caller's intent was to emit text and it was emitted — just
    // possibly on a different file descriptor — so success is reported
    // even for diverted lines, on a microtask.
    if (callback) {
      queueMicrotask(() => callback())
    }
    return lastForwardReturn ?? true
  }

  process.stdout.write = guardedWrite as typeof process.stdout.write

  registerCleanup(async () => {
    if (lineBuffer !== '') {
      if (isParseableJson(lineBuffer)) {
        realWrite(`${lineBuffer}\n`)
      } else {
        process.stderr.write(`${STDOUT_GUARD_MARKER} ${lineBuffer}\n`)
      }
      lineBuffer = ''
    }
    if (originalWrite !== null) {
      process.stdout.write = originalWrite
      originalWrite = null
    }
    installed = false
  })
}
