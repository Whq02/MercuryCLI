// ============================================================================
//  Slow-operation instrumentation: wrappers around the operations that
//  historically stalled the event loop (JSON serialise/parse, structured
//  and deep cloning, synchronous file writes).
//
//  The exported instrument is UNCONDITIONALLY a single shared no-op
//  disposable — zero allocation, zero timing. The dormant timing
//  implementation the original retained (unreferenced; the bundler dropped
//  it) is deliberately not carried: callers must observe no timing side
//  effects, and nothing may wire it up.
// ============================================================================

import { closeSync, fsyncSync, openSync, writeFileSync, writeSync } from 'node:fs'
import { cloneDeep as lodashCloneDeep } from 'lodash-es'

/** Threshold resolution, decided ONCE at module load: 20 ms in development;
 *  otherwise disabled (positive infinity). (The compat threshold override
 *  is retired — no MERCURY primary.) */
function resolveThreshold(): number {
  if (process.env.NODE_ENV === 'development') return 20
  return Number.POSITIVE_INFINITY
}

export const SLOW_OPERATION_THRESHOLD_MS = resolveThreshold()

/** The one shared no-op disposable every instrumentation site receives. */
const NOOP_DISPOSABLE: Disposable = Object.freeze({
  [Symbol.dispose](): void {},
})

/**
 * The slow-operation instrument, as a tagged template. In this tree it is
 * the shared no-op: no start time, no stack capture, no logging — the
 * timing lane is dark by design.
 */
export function slowLogging(
  _strings: TemplateStringsArray,
  ..._values: unknown[]
): Disposable {
  return NOOP_DISPOSABLE
}

/** The first stack frame that does not belong to this module, rendered as a
 *  file name and line number; unavailable stacks yield nothing. */
export function callerFrame(stack: string | undefined): string {
  if (!stack) return ''
  for (const line of stack.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('at ')) continue
    if (trimmed.includes('slowOperations')) continue
    const m = /\(?([^()\s]+):(\d+):\d+\)?$/.exec(trimmed)
    if (m) {
      const file = m[1]!
      const base = file.split(/[\\/]/).pop() ?? file
      return `${base}:${m[2]}`
    }
  }
  return ''
}

export function jsonStringify(
  value: unknown,
  replacer?: (this: unknown, key: string, val: unknown) => unknown,
  space?: string | number,
): string
export function jsonStringify(
  value: unknown,
  replacer?: (number | string)[] | null,
  space?: string | number,
): string
export function jsonStringify(
  value: unknown,
  replacer?:
    | ((this: unknown, key: string, val: unknown) => unknown)
    | (number | string)[]
    | null,
  space?: string | number,
): string {
  if (typeof replacer === 'function') return JSON.stringify(value, replacer, space)
  return JSON.stringify(value, replacer ?? undefined, space)
}

/** Same signature as the platform parser. The no-reviver branch passes
 *  EXACTLY one argument — an explicit `undefined` reviver de-optimises the
 *  engine's parser. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function jsonParse(
  text: string,
  reviver?: (this: unknown, key: string, value: unknown) => unknown,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  if (reviver === undefined) return JSON.parse(text)
  return JSON.parse(text, reviver)
}

/** Structured clone. */
export function clone<T>(value: T, options?: StructuredSerializeOptions): T {
  return structuredClone(value, options)
}

/** Deep clone (the third-party helper). */
export function cloneDeep<T>(value: T): T {
  return lodashCloneDeep(value)
}

/**
 * Synchronous file write with an optional flush.
 *
 * @deprecated Synchronous writes block the event loop; prefer asynchronous
 * writes. When `flush` is requested the file is opened, written, synced and
 * closed explicitly (honouring encoding and mode, always closing even on
 * failure); otherwise a plain synchronous write runs.
 */
export function writeFileSync_DEPRECATED(
  filePath: string,
  data: string,
  options?:
    | BufferEncoding
    | {
        encoding?: BufferEncoding
        mode?: number
        // The open flag ('w', 'wx', …) — part of the original options
        // contract (Node WriteFileOptions); the S23 session-memory setup
        // relies on the exclusive-create arm.
        flag?: string
        flush?: boolean
      },
): void {
  const resolved = typeof options === 'string' ? { encoding: options } : options
  if (resolved?.flush) {
    const fd = openSync(filePath, resolved.flag ?? 'w', resolved.mode)
    try {
      writeSync(fd, data, null, resolved.encoding ?? 'utf8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    return
  }
  writeFileSync(filePath, data, {
    encoding: resolved?.encoding ?? 'utf8',
    ...(resolved?.mode !== undefined ? { mode: resolved.mode } : {}),
    ...(resolved?.flag !== undefined ? { flag: resolved.flag } : {}),
  })
}
