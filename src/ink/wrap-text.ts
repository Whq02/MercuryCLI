import sliceAnsi from '../utils/sliceAnsi.js'
import { stringWidth } from './stringWidth.js'
import { wrapAnsi } from './wrapAnsi.js'
import { notBuilt } from '../pi/holes.js'

const ELLIPSIS = '…'

function leadingSlice(text: string, width: number): string {
  if (width <= 0) return ''
  let out = sliceAnsi(text, 0, width)
  if (stringWidth(out) > width) out = sliceAnsi(text, 0, width - 1)
  return out
}

function trailingSlice(text: string, width: number): string {
  if (width <= 0) return ''
  const total = stringWidth(text)
  let out = sliceAnsi(text, total - width)
  if (stringWidth(out) > width) out = sliceAnsi(text, total - width + 1)
  return out
}


function stripSoftBreakIndent(line: string): string {
  let i = 0
  let kept = ''
  while (i < line.length) {
    const ch = line[i]!
    if (ch === ' ') {
      i++
      continue
    }
    if (ch === '\x1b') {
      const m = /^\x1b(?:\[[0-9;?]*[A-Za-z]|\]8;;[^\x07\x1b]*(?:\x07|\x1b\\))/.exec(
        line.slice(i),
      )
      if (m) {
        kept += m[0]
        i += m[0].length
        continue
      }
    }
    break
  }
  return kept + line.slice(i)
}

function stripSoftWrapLeadingSpaces(input: string, wrapped: string): string {
  if (!wrapped.includes('\n')) return wrapped
  const paragraphWidths = input.split('\n').map(p => stringWidth(p))
  const lines = wrapped.split('\n')
  const out: string[] = []
  let paragraph = 0
  let consumed = 0
  for (const line of lines) {
    out.push(consumed > 0 ? stripSoftBreakIndent(line) : line)
    consumed += stringWidth(line)
    if (paragraph < paragraphWidths.length && consumed >= paragraphWidths[paragraph]!) {
      consumed = 0
      paragraph++
    }
  }
  return out.join('\n')
}

export function truncateParts(
  text: string,
  maxWidth: number,
  wrapType: string,
): { lead: string; ellipsis: boolean; trail: string } | null {
  return notBuilt('src/ink/wrap-text.ts:66')
}

export default function wrapText(
  text: string,
  maxWidth: number,
  wrapType: string,
): string {
  return notBuilt('src/ink/wrap-text.ts:88')
}
