import { lastGrapheme } from './intl.js'
import { passedOver } from './passedOver.js'
import { isSessionRunArgv } from './sessionArgs.js'

let capturing = false
let capturedBuffer = ''
let readableHandler: (() => void) | null = null

function readEarlyChunk(chunk: string): void {
  for (let at = 0; at < chunk.length; at++) {
    const code = chunk.charCodeAt(at)
    if (code === 0x03) {
      stopCapturingEarlyInput()
      process.exit(130)
    }
    if (code === 0x04) {
      stopCapturingEarlyInput()
      return
    }
    if (code === 0x08 || code === 0x7f) {
      if (capturedBuffer !== '') {
        capturedBuffer = capturedBuffer.slice(0, capturedBuffer.length - lastGrapheme(capturedBuffer).length)
      }
      continue
    }
    if (code === 0x1b) {
      const introducer = chunk[at + 1]
      at++
      if (introducer !== '[' && introducer !== 'O') continue
      at++
      while (at < chunk.length && (chunk.charCodeAt(at) < 0x40 || chunk.charCodeAt(at) > 0x7e)) at++
      continue
    }
    if (code === 0x0d) {
      capturedBuffer += '\n'
      continue
    }
    if (code < 0x20 && code !== 0x09 && code !== 0x0a) continue
    capturedBuffer += chunk[at]
  }
}

export function startCapturingEarlyInput(): void {
  if (!process.stdin.isTTY || capturing || isSessionRunArgv()) return
  capturing = true
  capturedBuffer = ''
  try {
    process.stdin.setEncoding('utf8')
    process.stdin.setRawMode?.(true)
    if (process.stdout.isTTY) process.stdout.write('\x1b[0m')
    process.stdin.ref()
    const drain = (): void => {
      let chunk: string | Buffer | null = process.stdin.read()
      while (chunk !== null) {
        readEarlyChunk(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
        chunk = process.stdin.read()
      }
    }
    process.stdin.on('readable', drain)
    readableHandler = drain
  } catch (error) {
    passedOver(error)
    capturing = false
  }
}

export function stopCapturingEarlyInput(): void {
  if (!capturing) return
  capturing = false
  if (readableHandler === null) return
  process.stdin.removeListener('readable', readableHandler)
  readableHandler = null
}

export function consumeEarlyInput(): string {
  stopCapturingEarlyInput()
  const text = capturedBuffer.trim()
  capturedBuffer = ''
  return text
}

export function hasEarlyInput(): boolean {
  return capturedBuffer.trim() !== ''
}

export function seedEarlyInput(text: string): void {
  capturedBuffer = text
}

export function __processEarlyChunkForTest(chunk: string): void {
  readEarlyChunk(chunk)
}

export function isCapturingEarlyInput(): boolean {
  return capturing
}
