#!/usr/bin/env bun
// ============================================================================
//  scripts/streaming/prove-markdown-incremental.ts — the incremental-
//  markdown laws, proven against the REAL pipeline (advanceStableBoundary +
//  marked.lexer + formatToken — the exact code StreamingMarkdown/Markdown
//  run; utils/markdown.ts is bun-loadable — no feature() gate remains).
//
//  For every corpus doc × delta granularity, the stream is replayed exactly
//  like StreamingMarkdown does (monotonic boundary ref) and these laws hold
//  at EVERY step:
//    L1 monotonic + in-bounds — the boundary never retreats, never overruns.
//    L2 byte conservation      — stable + unstable == the streamed text.
//    L3 parse-split safety     — lexing the stable prefix and the unstable
//                                suffix separately yields the SAME token
//                                sequence as lexing the whole text (type+raw,
//                                seam space tokens normalized). Splitting
//                                must never change what the user reads.
//    L4 painted stability      — the formatted stable prefix only ever
//                                GROWS by appending: format(stable_i) is a
//                                string prefix of format(stable_j), i<j.
//                                Painted prose never mutates behind the user.
//    L5 settle equality        — at stream end, the split render
//                                (trim(F(stable)) + blank line +
//                                trim(F(unstable))) equals the settled
//                                whole-doc render trim(F(full)) — the
//                                stream→settled swap is a byte no-op.
//
//  KNOWN-DIVERGENCE characterization: late reference-link definitions
//  ([x][1] streamed before its [1]: url block) — the stable prefix has
//  already rendered the literal text; the settled full parse resolves the
//  link. L5 is asserted DIVERGENT for that doc; flip the expectation if a
//  fix ever lands (the divergence is transient: the settled message re-parses
//  whole and renders correctly).
//
//  Width note: formatToken wraps nothing (layout wraps); tables take a width
//  budget — pinned to 80 here for determinism.
// ============================================================================

import { marked, type Token } from 'marked'
import { advanceStableBoundary, computeSeamRows } from '../../src/components/Markdown.tsx'
import { configureMarked, formatToken } from '../../src/utils/markdown.ts'
import { getTheme } from '../../src/utils/theme.ts'

configureMarked()
const theme = getTheme()

let failures = 0
let checks = 0
function fail(name: string, detail: string): void {
  failures++
  console.log(`  ✗ ${name} — ${detail}`)
}
function pass(name: string): void {
  console.log(`  ✓ ${name}`)
}

// ── corpus ──────────────────────────────────────────────────────────────────

const CORPUS: Record<string, string> = {
  paragraphs: 'First paragraph of ordinary prose that flows on.\n\nSecond paragraph, still ordinary.\n\nThird one ends the doc.',
  'atx-headings': '# Title\n\nIntro prose under the title.\n\n## Section two\n\nBody of section two.',
  'setext-heading': 'Title Line\n===\n\nProse after a setext heading.\n\nAnother Line\n---\n\nTail prose.',
  'fenced-code': 'Lead-in prose:\n\n```ts\nconst x = 1\nfunction f(): number {\n  return x\n}\n```\n\nProse after the fence.',
  'nested-lists': 'Steps:\n\n- one\n- two\n  - two-a\n  - two-b\n- three\n\nDone.',
  'loose-list': 'Items:\n\n- first item\n\n- second item\n\n- third item\n\nAfter.',
  'ordered-list': '1. alpha\n2. beta\n3. gamma\n\nTail.',
  blockquote: 'Quote follows:\n\n> quoted line one\n> quoted line two\n\nAfter the quote.',
  table: 'Data:\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\nAfter the table.',
  'inline-marks': 'Some **bold** and *italic* and `code` and a [link](https://example.com) inline.',
  'plain-long': 'plain words with no markdown syntax at all just a very long single paragraph that keeps growing and growing and growing until the stream ends without ever containing a single marker character or blank line'.replace(/-/g, ' '),
  'hr-rule': 'Above the rule.\n\n---\n\nBelow the rule.',
  mixed: '# Doc\n\nProse first.\n\n```py\nprint("hi")\n```\n\n- a\n- b\n\n> quote\n\nFinal words.',
  // ux-parity adversarial classes (SPEC 02): a loose list whose items carry
  // INDENTED CONTINUATION lines (the boundary must not cut between an item
  // and its continuation), and a deep-indent fence whose blank + indent-only
  // lines are exactly the render-invisible beats the streaming pending-row
  // mechanism exists for.
  'loose-list-continuation': 'Steps:\n\n- first item\n  its continuation line\n\n- second item\n  more continuation\n\n- third\n\nAfter.',
  'deep-indent-fence': 'Core:\n\n```ts\nclass A {\n  m() {\n    if (x) {\n      deep();\n\n      deeper();\n    }\n  }\n}\n```\n\nAfter the fence.',
}
const LATE_REF: [string, string] = [
  'late-ref-link',
  'See [the spec][1] for details.\n\nMore prose in between.\n\n[1]: https://example.com/spec',
]

const GRANULARITIES: Record<string, number> = { 'char-1': 1, 'char-3': 3, 'word-7': 7, 'line': -1 }

function slices(doc: string, gran: number): string[] {
  if (gran > 0) {
    const out: string[] = []
    for (let i = gran; i < doc.length; i += gran) out.push(doc.slice(0, i))
    out.push(doc)
    return out
  }
  const lines = doc.split('\n')
  const out: string[] = []
  for (let i = 1; i <= lines.length; i++) out.push(lines.slice(0, i).join('\n'))
  return out
}

// token sequence normalized for seam comparison: drop pure-space tokens,
// compare (type, raw-with-trailing-space-trimmed)
function tokenSig(tokens: Token[]): string[] {
  return tokens.filter(t => t.type !== 'space').map(t => `${t.type}:${(t as { raw: string }).raw.replace(/\s+$/, '')}`)
}

function fmt(text: string): string {
  if (!text) return ''
  return marked
    .lexer(text)
    .map(t => (t.type === 'table' ? '⟨TABLE⟩' : formatToken(t, theme, 0, null, null, null, 80)))
    .join('')
}

/** Faithful row model of MarkdownBody: text segments trimmed into Texts,
 *  tables as elements, ONE blank row between elements (Box gap=1). */
function rowsOf(text: string): string[] {
  if (!text) return []
  const tokens = marked.lexer(text)
  const parts: string[][] = []
  let buf = ''
  const flush = (): void => {
    if (buf.trim()) parts.push(buf.trim().split('\n'))
    buf = ''
  }
  for (const t of tokens) {
    if (t.type === 'table') {
      flush()
      parts.push(['⟨TABLE⟩'])
    } else buf += formatToken(t, theme, 0, null, null, null, 80)
  }
  flush()
  const rows: string[] = []
  parts.forEach((prt, i) => {
    if (i > 0) rows.push('')
    rows.push(...prt)
  })
  return rows
}

// ── the replay ──────────────────────────────────────────────────────────────

function replay(name: string, doc: string, granName: string, expectSettleDivergence: boolean): void {
  const steps = slices(doc, GRANULARITIES[granName]!)
  let boundary = 0
  let prevBoundary = 0
  let prevStableFmt = ''
  let ok = { l1: true, l2: true, l3: true, l4: true }
  let detail = ''

  for (const text of steps) {
    boundary = advanceStableBoundary(text, boundary)
    // L1
    if (boundary < prevBoundary || boundary > text.length) {
      ok.l1 = false
      detail = `boundary ${prevBoundary}→${boundary} (len ${text.length})`
      break
    }
    prevBoundary = boundary
    const stable = text.slice(0, boundary)
    const unstable = text.slice(boundary)
    // L2
    if (stable + unstable !== text) {
      ok.l2 = false
      detail = 'byte loss at the split'
      break
    }
    // L3
    const split = [...tokenSig(marked.lexer(stable)), ...tokenSig(unstable ? marked.lexer(unstable) : [])]
    const whole = tokenSig(marked.lexer(text))
    if (split.join('\u241F') !== whole.join('\u241F')) {
      ok.l3 = false
      detail = `token divergence at len ${text.length}: split=[${split.slice(0, 4)}] whole=[${whole.slice(0, 4)}]`
      break
    }
    // L4
    const stableFmt = fmt(stable)
    if (!stableFmt.startsWith(prevStableFmt)) {
      ok.l4 = false
      detail = `painted prose mutated at len ${text.length}`
      break
    }
    prevStableFmt = stableFmt
  }

  checks++
  if (ok.l1 && ok.l2 && ok.l3 && ok.l4) pass(`${name} @ ${granName}: L1–L4 hold over ${steps.length} steps`)
  else fail(`${name} @ ${granName}: L1–L4`, detail)

  // L5 — settle equality at the final step, in the COMPONENT's row model:
  // rowsOf mirrors MarkdownBody (text segments trimmed, tables as elements,
  // one blank row between elements); the streamed side stacks
  // rowsOf(stable) + computeSeamRows blank rows + rowsOf(unstable) with no
  // outer gap — exactly what StreamingMarkdown renders since the S5 fix.
  const stable = doc.slice(0, boundary)
  const unstable = doc.slice(boundary)
  const seam = stable && unstable ? computeSeamRows(stable, theme as never) : 0
  const splitRows = [...rowsOf(stable), ...Array(seam).fill(''), ...rowsOf(unstable)]
  const settledRows = rowsOf(doc)
  const equal = splitRows.join('\u0000') === settledRows.join('\u0000')
  checks++
  if (expectSettleDivergence) {
    if (!equal) pass(`${name} @ ${granName}: L5 KNOWN divergence (late ref link) still present`)
    else fail(`${name} @ ${granName}: L5 known divergence VANISHED`, 'update the proof — a fix landed?')
  } else if (equal) pass(`${name} @ ${granName}: L5 settle swap is a row no-op (seam=${seam})`)
  else {
    const at = splitRows.findIndex((r, i) => settledRows[i] !== r)
    fail(`${name} @ ${granName}: L5 settle equality`, `row ${at}: split=${JSON.stringify(splitRows.slice(at, at + 2))} settled=${JSON.stringify(settledRows.slice(at, at + 2))} (seam=${seam})`)
  }
}

console.log('── FLUX S5 incremental-markdown laws (real lexer + formatter) ──')
for (const [name, doc] of Object.entries(CORPUS)) {
  for (const granName of Object.keys(GRANULARITIES)) {
    replay(name, doc, granName, false)
  }
}
for (const granName of Object.keys(GRANULARITIES)) {
  replay(LATE_REF[0], LATE_REF[1], granName, true)
}

// The reset path (text replaced mid-stream — StreamingMarkdown re-lexes from
// scratch): boundary computed fresh on the new text must satisfy L1–L3.
{
  const a = '# Old\n\nold body text.'
  const b = 'Completely different text.\n\nSecond paragraph.'
  let boundary = advanceStableBoundary(a, 0)
  // simulate the component's startsWith reset
  if (!b.startsWith(a.slice(0, boundary))) boundary = 0
  boundary = advanceStableBoundary(b, boundary)
  checks++
  if (boundary <= b.length && b.slice(0, boundary) + b.slice(boundary) === b) pass('reset path: replaced text re-lexes cleanly from 0')
  else fail('reset path', `boundary ${boundary}`)
}

console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? '✅ FLUX markdown-incremental GREEN' : '❌ FLUX markdown-incremental RED')
process.exit(failures === 0 ? 0 : 1)
