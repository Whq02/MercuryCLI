
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
