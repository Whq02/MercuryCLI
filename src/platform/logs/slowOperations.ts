const NOOP_DISPOSABLE: Disposable = Object.freeze({ [Symbol.dispose]() {} })

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
  return JSON.stringify(value, replacer, space)
}

export function jsonParse(
  text: string,
  reviver?: (this: unknown, key: string, value: unknown) => unknown,
): any {
  return JSON.parse(text, reviver)
}
