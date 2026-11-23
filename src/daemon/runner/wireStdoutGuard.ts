import { registerCleanup } from '../../platform/processes/cleanupRegistry.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { startMicrotask } from '../../platform/async/timers.js'

const STDOUT_GUARD_MARKER = '[stdout-guard]'
let installed = false
let originalWrite: typeof process.stdout.write | null = null
let lineBuffer = ''

function isJsonLine(line: string): boolean {
  try {
    JSON.parse(line)
    return true
  } catch (error) {
    passedOver(error)
    return false
  }
}

export function installWireStdoutGuard(): void {
  if (installed) return
  installed = true
  const stream = process.stdout
  const realWrite = stream.write.bind(stream)
  originalWrite = stream.write
  type Callback = (error?: Error | null) => void
  stream.write = (chunk: string | Uint8Array, encoding?: BufferEncoding | Callback, callback?: Callback) => {
    const done = typeof encoding === 'function' ? encoding : callback
    const lines = (lineBuffer + (typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))).split('\n')
    lineBuffer = lines.pop()!
    const good: string[] = []
    for (const line of lines) {
      if (!line || isJsonLine(line)) good.push(line + '\n')
      else {
        process.stderr.write(`${STDOUT_GUARD_MARKER} ${line}\n`)
        logForDebugging(`stdout guard diverted a non-JSON line: ${line.slice(0, 200)}`)
      }
    }
    let ready = true
    for (const [index, line] of good.entries()) {
      ready = index === good.length - 1 && done ? realWrite(line, done) : realWrite(line)
    }
    if (done && !good.length) startMicrotask(done)
    return ready
  }
  registerCleanup(async () => {
    if (lineBuffer) {
      if (isJsonLine(lineBuffer)) realWrite(lineBuffer + '\n')
      else process.stderr.write(`${STDOUT_GUARD_MARKER} ${lineBuffer}\n`)
      lineBuffer = ''
    }
    if (originalWrite !== null) stream.write = originalWrite
    originalWrite = null
    installed = false
  })
}
