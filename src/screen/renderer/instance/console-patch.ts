import { format as formatArgs } from 'node:util'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import { logError } from '../../../platform/logs/errorLog.js'
import type Ink from '../screenInstance.js'
import { passedOver } from '../../../platform/errors/passedOver.js'

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

type ConsoleMethod = (typeof CONSOLE_DEBUG_METHODS)[number] | (typeof CONSOLE_ERROR_METHODS)[number]

function patchMethod<K extends ConsoleMethod>(
  restorers: Array<() => void>,
  method: K,
  replacement: (...args: unknown[]) => void,
): void {
  const original = console[method]
  if (typeof original !== 'function') return
  console[method] = replacement
  restorers.push(() => {
    console[method] = original
  })
}

export function patchConsole(this: Pick<Ink, 'options' | 'ledger' | 'isUnmounted' | 'isPaused' | 'altScreenActive' | 'scheduleRender'>): () => void {
  const restorers: Array<() => void> = []
  for (const method of CONSOLE_DEBUG_METHODS) {
    patchMethod(restorers, method, (...args: unknown[]) => {
      logForDebugging(`[console.${method}] ${formatArgs(...args)}`)
    })
  }
  for (const method of CONSOLE_ERROR_METHODS) {
    patchMethod(restorers, method, (...args: unknown[]) => {
      logError(new Error(`[console.${method}] ${formatArgs(...args)}`))
    })
  }
  const originalAssert = console.assert
  console.assert = (condition?: unknown, ...args: unknown[]) => {
    if (!condition) logError(new Error(`[console.assert] ${formatArgs(...args)}`))
  }
  restorers.push(() => {
    console.assert = originalAssert
  })
  restorers.push(interceptStderr.call(this))
  return () => {
    for (const restore of restorers) restore()
  }
}

function interceptStderr(this: Pick<Ink, 'options' | 'ledger' | 'isUnmounted' | 'isPaused' | 'altScreenActive' | 'scheduleRender'>): () => void {
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
    } catch (error) {
      passedOver(error)
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
