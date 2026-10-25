
import bundledWrapAnsi from 'wrap-ansi'
import sliceAnsi from '../utils/sliceAnsi.js'
import { terminalTextCells } from './session/terminalTextCells.js'
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

export function wrapAnsi(
  input: string,
  columns: number,
  options?: WrapAnsiOptions,
): string {
  const wrapped = nativeWrapAnsi && !VARIATION_SELECTOR_RE.test(input)
    ? nativeWrapAnsi(input, columns, options)
    : bundledWrapAnsi(input, columns, options)
  if (
    columns < 1 || !Number.isFinite(columns) ||
    !(options?.hard || options?.wordWrap === false) ||
    !/[\u200C\u200D]/.test(input) || terminalTextCells().joinerCells === 0
  ) return wrapped
  return wrapped.split('\n').flatMap(line => {
    const rows: string[] = []
    while (stringWidth(line) > columns) {
      const head = sliceAnsi(line, 0, columns)
      const consumed = stringWidth(head)
      if (consumed === 0) break
      rows.push(head)
      line = sliceAnsi(line, consumed)
    }
    rows.push(line)
    return rows
  }).join('\n')
}
