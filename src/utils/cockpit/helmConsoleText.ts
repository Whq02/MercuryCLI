
import { charWidth, displayWidth } from '../../components/mercury-ui/glyphs.js'

export function plainifyAnswer(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let inFence = false
  for (const raw of lines) {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence
      continue
    }
    if (inFence) {
      out.push(raw)
      continue
    }
    let l = raw
    l = l.replace(/^#{1,6}\s+/, '')
    l = l.replace(/^\s*>\s?/, '')
    l = l.replace(/^(\s*)[-*+]\s+/, '$1· ')
    l = l.replace(/\*\*([^*]+)\*\*/g, '$1')
    l = l.replace(/__([^_]+)__/g, '$1')
    l = l.replace(/(^|\W)\*([^*\s][^*]*)\*/g, '$1$2')
    l = l.replace(/`([^`]+)`/g, '$1')
    l = l.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    out.push(l)
  }
  const collapsed: string[] = []
  for (const l of out) {
    if (l.trim() === '' && collapsed[collapsed.length - 1]?.trim() === '') {
      continue
    }
    collapsed.push(l.trimEnd())
  }
  while (collapsed[0]?.trim() === '') collapsed.shift()
  while (collapsed[collapsed.length - 1]?.trim() === '') collapsed.pop()
  return collapsed.join('\n')
}

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

export function consoleInputWindow(
  buffer: string,
  cursor: number,
  budget: number,
): { pre: string; post: string; headClipped: boolean; tailClipped: boolean } {
  const b = Math.max(4, budget)
  const chars = Array.from(buffer)
  const preChars = chars.slice(0, cursor)
  const postChars = chars.slice(cursor)
  const postCap = Math.min(8, Math.floor(b / 3))
  let post = ''
  let postW = 0
  let tailClipped = false
  for (const ch of postChars) {
    const cw = charWidth(ch)
    if (postW + cw > postCap) {
      tailClipped = true
      break
    }
    post += ch
    postW += cw
  }
  const preBudget = b - 1 - postW
  let pre = ''
  let preW = 0
  let headClipped = false
  for (let i = preChars.length - 1; i >= 0; i--) {
    const ch = preChars[i] ?? ''
    const cw = charWidth(ch)
    if (preW + cw > preBudget - (i > 0 ? 1 : 0)) {
      headClipped = i >= 0
      break
    }
    pre = ch + pre
    preW += cw
  }
  if (headClipped) pre = `…${pre}`
  return { pre, post, headClipped, tailClipped }
}

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
