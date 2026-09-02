import { openSync } from 'node:fs'
import { ReadStream } from 'node:tty'

import { logError } from './log.js'


let stdinSubstitute: NodeJS.ReadStream | null | undefined

function getStdinSubstitute(): NodeJS.ReadStream | null {
  if (stdinSubstitute !== undefined) return stdinSubstitute
  stdinSubstitute = null
  if (process.stdin.isTTY) return stdinSubstitute
  if (process.env.CI) return stdinSubstitute
  if (process.argv.includes('mcp')) return stdinSubstitute
  if (process.platform === 'win32') return stdinSubstitute
  try {
    const fd = openSync('/dev/tty', 'r')
    const stream = new ReadStream(fd)
    stream.isTTY = true
    stdinSubstitute = stream as unknown as NodeJS.ReadStream
  } catch (err) {
    logError(err)
  }
  return stdinSubstitute
}

export function getBaseRenderOptions(exitOnCtrlC: boolean = false): {
  exitOnCtrlC: boolean
  stdin?: NodeJS.ReadStream
} {
  const substitute = getStdinSubstitute()
  return { exitOnCtrlC, ...(substitute ? { stdin: substitute } : {}) }
}
