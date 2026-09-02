
import { closeSync, fsyncSync, openSync, writeFileSync, writeSync } from 'node:fs'
import { cloneDeep as lodashCloneDeep } from 'lodash-es'

function resolveThreshold(): number {
  if (process.env.NODE_ENV === 'development') return 20
  return Number.POSITIVE_INFINITY
}

export const SLOW_OPERATION_THRESHOLD_MS = resolveThreshold()

const NOOP_DISPOSABLE: Disposable = Object.freeze({
  [Symbol.dispose](): void {},
})

export function slowLogging(
  _strings: TemplateStringsArray,
  ..._values: unknown[]
): Disposable {
  return NOOP_DISPOSABLE
}

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function jsonParse(
  text: string,
  reviver?: (this: unknown, key: string, value: unknown) => unknown,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  if (reviver === undefined) return JSON.parse(text)
  return JSON.parse(text, reviver)
}

export function clone<T>(value: T, options?: StructuredSerializeOptions): T {
  return structuredClone(value, options)
}

export function cloneDeep<T>(value: T): T {
  return lodashCloneDeep(value)
}

export function writeFileSync_DEPRECATED(
  filePath: string,
  data: string,
  options?:
    | BufferEncoding
    | {
        encoding?: BufferEncoding
        mode?: number
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
