import { notBuilt, unbuilt, type Unbuilt } from '../pi/holes.js'

export const SLOW_OPERATION_THRESHOLD_MS: Unbuilt = unbuilt('src/utils/slowOperations.ts:7')

export function slowLogging(
  _strings: TemplateStringsArray,
  ..._values: unknown[]
): Disposable {
  return notBuilt('src/utils/slowOperations.ts:13')
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
  return notBuilt('src/utils/slowOperations.ts:30')
}

export function jsonParse(
  text: string,
  reviver?: (this: unknown, key: string, value: unknown) => unknown,
): any {
  return notBuilt('src/utils/slowOperations.ts:42')
}
