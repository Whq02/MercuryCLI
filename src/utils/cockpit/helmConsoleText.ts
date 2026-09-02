// ============================================================================
//  utils/cockpit/helmConsoleText — pure text shaping for the Helm console.
//
//  The rail renders answers as PLAIN wrapped lines (a 20–23-col column is no
//  place for a Markdown layout engine; the /console overlay renders the real
//  <Markdown>). Two helpers, both pure and provable:
//    · plainifyAnswer — conservative Markdown→plain (fences, emphasis, links,
//      headings, list markers) that never invents or drops content words.
//    · wrapPlain — display-width-aware word wrap. Width math DELEGATES to the
//      mercury-ui glyphs facade (the width-oracle SOT — never re-roll).
// ============================================================================

import { charWidth, displayWidth } from '../../components/mercury-ui/glyphs.js'

/** Conservative Markdown → plain text for narrow-column display. */
export function plainifyAnswer(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let inFence = false
  for (const raw of lines) {
    // Fence markers vanish; fenced content survives verbatim.
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence
      continue
    }
    if (inFence) {
      out.push(raw)
      continue
    }
    let l = raw
    l = l.replace(/^#{1,6}\s+/, '') // headings → bare text
    l = l.replace(/^\s*>\s?/, '') // blockquote marker
    l = l.replace(/^(\s*)[-*+]\s+/, '$1· ') // bullets → the dot glyph
    l = l.replace(/\*\*([^*]+)\*\*/g, '$1') // bold
    l = l.replace(/__([^_]+)__/g, '$1')
    l = l.replace(/(^|\W)\*([^*\s][^*]*)\*/g, '$1$2') // italic (word-bound)
    l = l.replace(/`([^`]+)`/g, '$1') // inline code
    l = l.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → label
    out.push(l)
  }
  // Collapse runs of blank lines; trim outer blanks.
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

/** Compact token count for the answer receipt: 312 · 4.1k · 41k · 1.2m. */
export function fmtTok(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return String(n)
}

/** Hard-break one overlong word into display-width-bounded chunks. */
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

/** Cap so a pathological answer can never balloon the render tree. */
const WRAP_LINES_MAX = 400

/**
 * Window a compose buffer around its cursor for a one-line, `budget`-cell
 * slot: the cursor block must ALWAYS be visible, so when the text overflows,
 * the head clips (marked with `…`) and a few cells of post-cursor context
 * survive. Pure — the rail renders `pre ▌ post` verbatim.
 */
export function consoleInputWindow(
  buffer: string,
  cursor: number,
  budget: number,
): { pre: string; post: string; headClipped: boolean; tailClipped: boolean } {
  const b = Math.max(4, budget)
  const chars = Array.from(buffer)
  const preChars = chars.slice(0, cursor)
  const postChars = chars.slice(cursor)
  // Post-cursor context: up to 8 cells (or a third of the slot, whichever is
  // smaller) — enough to see what ← would walk into.
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
  // Pre-cursor: the tail that fits in what remains (1 cell for the cursor).
  const preBudget = b - 1 - postW
  let pre = ''
  let preW = 0
  let headClipped = false
  for (let i = preChars.length - 1; i >= 0; i--) {
    const ch = preChars[i] ?? ''
    const cw = charWidth(ch)
    if (preW + cw > preBudget - (i > 0 ? 1 : 0)) {
      // (reserve 1 cell for the `…` marker unless we consumed everything)
      headClipped = i >= 0
      break
    }
    pre = ch + pre
    preW += cw
  }
  if (headClipped) pre = `…${pre}`
  return { pre, post, headClipped, tailClipped }
}

/**
 * Display-width-aware word wrap (plain text in, lines out). Preserves
 * paragraph breaks as empty lines; indentation of a source line carries to
 * its first wrapped line only.
 */
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
  // Trim trailing blank (paragraph-break bookkeeping).
  while (out[out.length - 1] === '') out.pop()
  return out
}
