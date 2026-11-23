import bundledWrapAnsi from 'wrap-ansi'
import sliceAnsi from '../../platform/text/sliceAnsi.js'
import { terminalTextCells } from './terminal-session/terminalTextCells.js'
import { stringWidth } from './stringWidth.js'

type WrapAnsiOptions = {
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

const VARIATION_SELECTOR_RE = /[\uFE00-\uFE0F]/
const CONJOINING_HANGUL_RE = /[\u1160-\u11FF]/
const JOINER_RE = /[\u200C\u200D]/

export function wrapAnsi(
  input: string,
  columns: number,
  options?: WrapAnsiOptions,
): string {
  const wrapped =
    nativeWrapAnsi && !VARIATION_SELECTOR_RE.test(input) && !CONJOINING_HANGUL_RE.test(input)
      ? nativeWrapAnsi(input, columns, options)
      : bundledWrapAnsi(input, columns, options)

  const isHard = Boolean(options?.hard) || options?.wordWrap === false
  if (
    !Number.isFinite(columns) ||
    columns < 1 ||
    !isHard ||
    !JOINER_RE.test(input) ||
    terminalTextCells().joinerCells === 0
  ) {
    return wrapped
  }

  const out: string[] = []
  for (const line of wrapped.split('\n')) {
    let rest = line
    while (stringWidth(rest) > columns) {
      const piece = sliceAnsi(rest, 0, columns)
      const width = stringWidth(piece)
      if (width === 0) break
      out.push(piece)
      rest = sliceAnsi(rest, width)
    }
    out.push(rest)
  }
  return out.join('\n')
}
