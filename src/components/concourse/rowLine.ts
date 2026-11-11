import { stringWidth } from '../../ink/stringWidth.js'
import wrapText from '../../ink/wrap-text.js'

export const ROW_LINE_INSET = 6
export const ROW_LINE_GLYPH_CELLS = 2
const CLAUSE_SEPARATOR = ' · '

export function rowLineLines(words: string, cellWidth: number): string[] {
  const width = Math.max(1, cellWidth - ROW_LINE_GLYPH_CELLS)
  if (stringWidth(words) <= width) return [words]
  const lines: string[] = []
  let line = ''
  const clauses = words.split(CLAUSE_SEPARATOR)
  clauses.forEach((clause, at) => {
    const piece = at < clauses.length - 1 ? `${clause} ·` : clause
    const joined = line === '' ? piece : `${line} ${piece}`
    if (stringWidth(joined) <= width) {
      line = joined
      return
    }
    if (stringWidth(piece) <= width) {
      lines.push(line)
      line = piece
      return
    }
    const wrapped = wrapText(joined, width, 'wrap').split('\n').map(part => part.trim()).filter(part => part !== '')
    lines.push(...wrapped.slice(0, -1))
    line = wrapped[wrapped.length - 1] ?? ''
  })
  if (line !== '') lines.push(line)
  return lines
}

export function rowLineRows(words: string, cellWidth: number): number {
  return Math.max(1, rowLineLines(words, cellWidth).length)
}

export function listColumns(listInner: number): { colProject: number; colAge: number; nowWidth: number } {
  return {
    colProject: listInner >= 66 ? 12 : 9,
    colAge: 9,
    nowWidth: listInner >= 72 ? Math.max(12, Math.floor(listInner * 0.3)) : 0,
  }
}

export function rowNowCellWidth(listInner: number): number {
  const { colProject, colAge, nowWidth } = listColumns(listInner)
  return nowWidth > 0 ? nowWidth - 1 : colProject + colAge
}
