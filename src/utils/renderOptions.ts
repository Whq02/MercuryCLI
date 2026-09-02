import { openSync } from 'node:fs'
import { ReadStream } from 'node:tty'

import { logError } from './log.js'

/**
 * Base renderer options, substituting the controlling terminal when stdin is
 * a pipe so interactive rendering still works.
 */

let stdinSubstitute: NodeJS.ReadStream | null | undefined

/** Computed at most once per process, including the negative result. */
function getStdinSubstitute(): NodeJS.ReadStream | null {
  if (stdinSubstitute !== undefined) return stdinSubstitute
  stdinSubstitute = null
  if (process.stdin.isTTY) return stdinSubstitute
  if (process.env.CI) return stdinSubstitute
  // Hijacking input breaks the MCP stdio protocol.
  if (process.argv.includes('mcp')) return stdinSubstitute
  if (process.platform === 'win32') return stdinSubstitute
  try {
    const fd = openSync('/dev/tty', 'r')
    const stream = new ReadStream(fd)
    // A stream over a raw descriptor is not always recognised as a terminal
    // (the compiled single-binary runtime gets this wrong), and the renderer
    // keys raw-mode handling on the flag.
    stream.isTTY = true
    stdinSubstitute = stream as unknown as NodeJS.ReadStream
  } catch (err) {
    logError(err)
  }
  return stdinSubstitute
}

/** Defaulting exitOnCtrlC to false is what dialogs want. */
export function getBaseRenderOptions(exitOnCtrlC: boolean = false): {
  exitOnCtrlC: boolean
  stdin?: NodeJS.ReadStream
} {
  const substitute = getStdinSubstitute()
  return { exitOnCtrlC, ...(substitute ? { stdin: substitute } : {}) }
}
