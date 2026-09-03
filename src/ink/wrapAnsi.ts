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

// A variation selector (U+FE00-U+FE0F) is zero-width and belongs to the
// glyph before it; the native wrapper breaks BETWEEN them when that glyph
// lands on the last column, orphaning the selector at the head of the next
// row. Input carrying one rides the bundled wrapper, which keeps the pair
// whole (the same refusal discipline as stringWidth's directional formats).
const VARIATION_SELECTOR_RE = /[\uFE00-\uFE0F]/

export function wrapAnsi(
  input: string,
  columns: number,
  options?: WrapAnsiOptions,
): string {
  if (nativeWrapAnsi && !VARIATION_SELECTOR_RE.test(input)) return nativeWrapAnsi(input, columns, options)
  return bundledWrapAnsi(input, columns, options)
}
