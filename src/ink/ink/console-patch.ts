import { format as formatArgs } from 'node:util'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import type Ink from '../ink.js'

const CONSOLE_DEBUG_METHODS = [
  'log',
  'info',
  'debug',
  'dir',
  'dirxml',
  'count',
  'countReset',
  'group',
  'groupCollapsed',
  'groupEnd',
  'table',
  'time',
  'timeEnd',
  'timeLog',
] as const

const CONSOLE_ERROR_METHODS = ['warn', 'error', 'trace'] as const

export function patchConsole(this: Pick<Ink, 'interceptStderr'>): () => void {
  const restorers: Array<() => void> = []
  const consoleRecord = console as unknown as Record<string, (...args: unknown[]) => void>
  for (const method of CONSOLE_DEBUG_METHODS) {
    const original = consoleRecord[method]
    if (typeof original !== 'function') continue
    consoleRecord[method] = (...args: unknown[]) => {
      logForDebugging(`[console.${method}] ${formatArgs(...args)}`)
    }
    restorers.push(() => {
      consoleRecord[method] = original
    })
  }
  for (const method of CONSOLE_ERROR_METHODS) {
    const original = consoleRecord[method]
    if (typeof original !== 'function') continue
    consoleRecord[method] = (...args: unknown[]) => {
      logError(new Error(`[console.${method}] ${formatArgs(...args)}`))
    }
    restorers.push(() => {
      consoleRecord[method] = original
    })
  }
  const originalAssert = console.assert
  console.assert = (condition?: unknown, ...args: unknown[]) => {
    if (!condition) logError(new Error(`[console.assert] ${formatArgs(...args)}`))
  }
  restorers.push(() => {
    console.assert = originalAssert
  })
  restorers.push(this.interceptStderr())
  return () => {
    for (const restore of restorers) restore()
  }
}

export function interceptStderr(this: Pick<Ink, 'options' | 'ledger' | 'isUnmounted' | 'isPaused' | 'altScreenActive' | 'scheduleRender'>): () => void {
  const stream = this.options.stderr
  const originalWrite = stream.write.bind(stream)
  let reentered = false
  const intercept = (
    chunk: unknown,
    encodingOrCallback?: unknown,
    maybeCallback?: unknown,
  ): boolean => {
    const callback =
      typeof encodingOrCallback === 'function'
        ? (encodingOrCallback as (error?: Error | null) => void)
        : typeof maybeCallback === 'function'
          ? (maybeCallback as (error?: Error | null) => void)
          : undefined
    if (reentered) {
      return typeof encodingOrCallback === 'function'
        ? originalWrite(chunk as string, encodingOrCallback as () => void)
        : originalWrite(chunk as string, encodingOrCallback as BufferEncoding, maybeCallback as () => void)
    }
    reentered = true
    try {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      logForDebugging(`[stderr] ${text}`, { level: 'warn' })
      if (this.altScreenActive && !this.isUnmounted && !this.isPaused) {
        this.ledger.contaminate('stderr-leak')
        this.scheduleRender()
      }
    } catch {
    } finally {
      reentered = false
      callback?.(null)
    }
    return true
  }
  stream.write = intercept as typeof stream.write
  return () => {
    if (stream.write === (intercept as typeof stream.write)) {
      stream.write = originalWrite as typeof stream.write
    }
  }
}
