
import { charWidth, displayWidth } from '../../components/mercury-ui/glyphs.js'

export function fmtTok(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return String(n)
}

function breakWord(word: string, width: number): string[] {
  const chunks: string[] = []
  let cur = ''
  let w = 0
  for (const ch of word) {
    const cw = charWidth(ch)
    if (w + cw > width && cur) {
      chunks.push(cur)
      cur = ''
      w = 0
    }
    cur += ch
    w += cw
  }
  if (cur) chunks.push(cur)
  return chunks
}

const WRAP_LINES_MAX = 400

export function wrapPlain(text: string, width: number): string[] {
  const w = Math.max(4, width)
  const out: string[] = []
  for (const para of text.split('\n')) {
    if (out.length >= WRAP_LINES_MAX) break
    if (para.trim() === '') {
      out.push('')
      continue
    }
    const words = para.trim().split(/\s+/)
    let line = ''
    for (const word of words) {
      const pieces = displayWidth(word) > w ? breakWord(word, w) : [word]
      for (const piece of pieces) {
        if (line === '') {
          line = piece
        } else if (displayWidth(line) + 1 + displayWidth(piece) <= w) {
          line = `${line} ${piece}`
        } else {
          out.push(line)
          line = piece
        }
        if (out.length >= WRAP_LINES_MAX) break
      }
      if (out.length >= WRAP_LINES_MAX) break
    }
    if (line && out.length < WRAP_LINES_MAX) out.push(line)
  }
  while (out[out.length - 1] === '') out.pop()
  return out
}
