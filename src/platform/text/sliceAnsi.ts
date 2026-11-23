import { ansiCodesToString, reduceAnsiCodes, tokenize, undoAnsiCodes, type AnsiCode } from '@alcalzone/ansi-tokenize'

import { stringWidth } from '../../screen/renderer/stringWidth.js'

export default function sliceAnsi(str: string, start: number, end?: number): string {
  const stop = end ?? Infinity
  const styles: AnsiCode[] = []
  const active = () => reduceAnsiCodes(styles).filter(code => code.code !== code.endCode)
  let cells = 0
  let begun = false
  let output = ''
  for (const token of tokenize(str)) {
    if (token.type !== 'char') {
      if (cells >= stop) break
      if (token.type === 'ansi') styles.push(token)
      if (begun) output += token.code
      continue
    }
    const width = token.fullWidth && !/[\u200c\u200d]/u.test(token.value) ? 2 : stringWidth(token.value)
    const from = cells
    cells += width
    if (cells > stop) break
    if (cells <= start || from < start || (!begun && width === 0 && start > 0)) continue
    if (!begun) {
      output = ansiCodesToString(active())
      begun = true
    }
    output += token.value
  }
  return begun ? output + ansiCodesToString(undoAnsiCodes(active())) : ''
}
