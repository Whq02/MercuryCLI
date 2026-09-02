// Runtime-preferring shim over an ANSI-aware word wrapper: the host
// runtime's native wrapper when it exists, the bundled one otherwise. Both
// accept the same options.

import bundledWrapAnsi from 'wrap-ansi'

export type WrapAnsiOptions = {
  hard?: boolean
  wordWrap?: boolean
  trim?: boolean
}

type NativeWrapAnsi = (
  input: string,
  columns: number,
  options?: WrapAnsiOptions,
) => string

const nativeWrapAnsi: NativeWrapAnsi | undefined = (
  globalThis as { Bun?: { wrapAnsi?: NativeWrapAnsi } }
).Bun?.wrapAnsi

export function wrapAnsi(
  input: string,
  columns: number,
  options?: WrapAnsiOptions,
): string {
  if (nativeWrapAnsi) return nativeWrapAnsi(input, columns, options)
  return bundledWrapAnsi(input, columns, options)
}
