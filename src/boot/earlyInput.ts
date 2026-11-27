import { lastGrapheme } from '../platform/text/textSegments.js'
import { passedOver } from '../platform/errors/passedOver.js'
import { startImmediate, startTimeout, stopTimeout } from '../platform/async/timers.js'
import { TRUECOLOR_QUERY, takeTruecolorAnswer, truecolorAskable, truecolorEcho } from '../screen/renderer/colorize.js'
import { interpretResponse } from '../screen/renderer/input/interpreter.js'
import { isSessionRunArgv } from './sessionArgs.js'

let capturing = false
let capturedBuffer = ''
let readableHandler: (() => void) | null = null

const DEPTH_ANSWER_MS = 100

function stringReplyEnd(rest: string): number {
  const bel = rest.indexOf('\x07')
  const st = rest.indexOf('\x1b\\', 2)
  if (st === -1) return bel + 1
  return bel !== -1 && bel < st ? bel + 1 : st + 2
}

function readEarlyChunk(chunk: string, onReply?: (reply: string) => void): string {
  for (let at = 0; at < chunk.length; at++) {
    const code = chunk.charCodeAt(at)
    if (code === 0x03) {
      stopCapturingEarlyInput()
      process.exit(130)
    }
    if (code === 0x04) {
      stopCapturingEarlyInput()
      return ''
    }
    if (code === 0x08 || code === 0x7f) {
      capturedBuffer = capturedBuffer.slice(0, -(lastGrapheme(capturedBuffer).length || 1))
      continue
    }
    if (code === 0x1b) {
      const rest = chunk.slice(at)
      if (/^\x1bP[01]\$(?:r[^\x07\x1b]*\x1b?)?$/.test(rest)) return rest
      if (onReply !== undefined && /^\x1b(?:P[01]?)?$/.test(rest)) return rest
      const introducer = chunk[at + 1]
      const replyEnd = introducer === 'P' ? stringReplyEnd(rest) : 0
      if (replyEnd > 0) {
        onReply?.(rest.slice(0, replyEnd))
        at += replyEnd - 1
        continue
      }
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
  return ''
}

function openDepthAnswer(): { onReply: () => ((reply: string) => void) | undefined; settle: () => Promise<void> } {
  const askedAt = performance.now()
  let open = true
  let wake: (() => void) | null = null
  const close = (): void => {
    open = false
    wake?.()
  }
  const take = (reply: string): void => {
    const response = interpretResponse(reply)
    if (response?.type !== 'decrqss') return
    takeTruecolorAnswer(truecolorEcho(response.setting))
    close()
  }
  return {
    onReply: () => (open ? take : undefined),
    settle: () =>
      new Promise<void>(resolve => {
        wake = resolve
        startImmediate(() =>
          startImmediate(() => {
            if (!open) return resolve()
            const timer = startTimeout(close, DEPTH_ANSWER_MS - (performance.now() - askedAt))
            wake = () => {
              stopTimeout(timer)
              resolve()
            }
          }),
        )
      }),
  }
}

export function startCapturingEarlyInput(askDepth = false, splashAnswered?: boolean): () => Promise<void> {
  const settled = (): Promise<void> => Promise.resolve()
  if (askDepth && splashAnswered !== undefined) takeTruecolorAnswer(splashAnswered)
  if (!process.stdin.isTTY || capturing || isSessionRunArgv()) return settled
  capturing = true
  capturedBuffer = ''
  try {
    process.stdin.setEncoding('utf8')
    process.stdin.setRawMode?.(true)
    if (process.stdout.isTTY) process.stdout.write('\x1b[0m')
    process.stdin.ref()
    const depth = askDepth && splashAnswered === undefined && process.stdout.isTTY && truecolorAskable() ? openDepthAnswer() : null
    let held = ''
    const drain = (): void => {
      let chunk: string | Buffer | null = process.stdin.read()
      while (chunk !== null) {
        held = readEarlyChunk(held + (typeof chunk === 'string' ? chunk : chunk.toString('utf8')), depth?.onReply())
        chunk = process.stdin.read()
      }
    }
    readableHandler = drain
    process.stdin.on('readable', drain)
    if (depth === null) return settled
    process.stdout.write(TRUECOLOR_QUERY)
    return depth.settle
  } catch (error) {
    passedOver(error)
    capturing = false
    return settled
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

export function __processEarlyChunkForTest(chunk: string): string {
  return readEarlyChunk(chunk)
}

export function isCapturingEarlyInput(): boolean {
  return capturing
}
