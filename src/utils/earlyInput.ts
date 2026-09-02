import { lastGrapheme } from './intl.js'


let capturing = false
let capturedBuffer = ''
let readableHandler: (() => void) | null = null

function processChunk(chunk: string): void {
  for (let i = 0; i < chunk.length; i++) {
    const code = chunk.charCodeAt(i)
    if (code === 3) {
      stopCapturingEarlyInput()
      process.exit(130)
    }
    if (code === 4) {
      stopCapturingEarlyInput()
      return
    }
    if (code === 127 || code === 8) {
      const cluster = lastGrapheme(capturedBuffer)
      capturedBuffer = capturedBuffer.slice(0, capturedBuffer.length - (cluster.length || 1))
      continue
    }
    if (code === 27) {
      let j = i + 1
      const intro = chunk.charCodeAt(j)
      if (intro === 0x5b || intro === 0x4f) {
        j++
        while (j < chunk.length) {
          const terminator = chunk.charCodeAt(j)
          if (terminator >= 0x40 && terminator <= 0x7e) break
          j++
        }
      }
      i = j
      continue
    }
    if (code < 0x20 && code !== 9 && code !== 10 && code !== 13) {
      continue
    }
    if (code === 13) {
      capturedBuffer += '\n'
      continue
    }
    capturedBuffer += chunk[i]
  }
}

export function startCapturingEarlyInput(): void {
  if (!process.stdin.isTTY) return
  if (capturing) return
  if (process.argv.includes('--print') || process.argv.includes('-p')) return
  try {
    capturing = true
    capturedBuffer = ''
    process.stdin.setEncoding('utf8')
    process.stdin.setRawMode?.(true)
    if (process.stdout.isTTY) {
      process.stdout.write('\u001b[0m')
    }
    process.stdin.ref()
    readableHandler = () => {
      let chunk: string | Buffer | null
      while ((chunk = process.stdin.read() as string | Buffer | null) !== null) {
        processChunk(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
      }
    }
    process.stdin.on('readable', readableHandler)
  } catch {
    capturing = false
  }
}

export function stopCapturingEarlyInput(): void {
  if (!capturing) return
  capturing = false
  if (readableHandler) {
    process.stdin.off('readable', readableHandler)
    readableHandler = null
  }
}

export function consumeEarlyInput(): string {
  stopCapturingEarlyInput()
  const text = capturedBuffer.trim()
  capturedBuffer = ''
  return text
}

export function hasEarlyInput(): boolean {
  return capturedBuffer.trim().length > 0
}

export function seedEarlyInput(text: string): void {
  capturedBuffer = text
}

export function __processEarlyChunkForTest(chunk: string): void {
  processChunk(chunk)
}

export function isCapturingEarlyInput(): boolean {
  return capturing
}
