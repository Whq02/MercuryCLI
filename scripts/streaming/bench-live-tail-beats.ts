#!/usr/bin/env bun
// ============================================================================
//  scripts/streaming/bench-live-tail-beats.ts — offline beat replay of the
//  ux-parity rig's canonical stream through the REAL StreamingMarkdown
//  pipeline (advanceStableBoundary + formatToken), at the tail store's
//  publish cadence (PUBLISH_MS mirrors TAIL_INTERVAL_MS) over the fixture's
//  25ms chunk cadence.
//
//  For every publish it decides: does the RENDERED (stable ⧺ seam ⧺ live ⧺
//  pending-row) output change? A publish that renders byte-identically is an
//  INVISIBLE BEAT — the terminal paints nothing and the paint-gap stretches
//  by a full store interval. The ux-parity study measured those stretches as
//  Mercury's streamed-text stutter (p99 gaps ~2-3x the cadence).
//
//  Bench, not gate: run it to see the beat structure before and after a
//  renderer change. MEASURE_JSON=path writes machine-readable results.
// ============================================================================
import { marked } from 'marked'
import { advanceStableBoundary, computeSeamRows, pendingRowsOf } from '../../src/components/Markdown.tsx'
import { configureMarked, formatToken } from '../../src/utils/markdown.ts'
import { getTheme } from '../../src/utils/theme.ts'
import { getCliHighlightPromise } from '../../src/utils/cliHighlight.ts'

configureMarked()
const theme = getTheme()
// BEAT_HIGHLIGHT=1: replay with the REAL cli-highlight loaded — the
// product's cockpit path (a null highlighter hides beats the highlighter
// itself quantizes).
const highlight = process.env.BEAT_HIGHLIGHT === '1' ? await getCliHighlightPromise() : null
if (process.env.BEAT_HIGHLIGHT === '1') console.log(`highlighter: ${highlight ? 'loaded' : 'UNAVAILABLE'}`)

// The ux-parity rig's canonical document and its exact whitespace-preserving
// 1-2-3 word chunking.
const DOC = `# Plan: tighten the parser

The tokenizer currently allocates one buffer per line. Under streaming load that
is the dominant cost. We can hold a single scratch buffer and reuse it across
lines, resetting the write head instead of reallocating.

Three steps get us there safely:

- Measure the baseline with the existing corpus so the win is provable.
- Introduce the scratch buffer behind a flag and mirror writes to both paths.
- Flip the flag once the mirror diff stays empty for a full corpus run.

Here is the core of the change:

\`\`\`ts
export class LineScanner {
  private scratch: Uint8Array = new Uint8Array(4096);
  private head = 0;

  push(chunk: Uint8Array): Token[] {
    const tokens: Token[] = [];
    for (const byte of chunk) {
      if (byte === NEWLINE) {
        tokens.push(this.take());
        this.head = 0;
      } else {
        this.ensure(this.head + 1);
        this.scratch[this.head++] = byte;
      }
    }
    return tokens;
  }

  private ensure(n: number): void {
    if (n <= this.scratch.length) return;
    const grown = new Uint8Array(this.scratch.length * 2);
    grown.set(this.scratch);
    this.scratch = grown;
  }
}
\`\`\`

The corpus results before and after:

| Corpus | Before | After | Delta |
| ------ | ------ | ----- | ----- |
| small  | 41ms   | 39ms  | -5%   |
| medium | 210ms  | 168ms | -20%  |
| large  | 1.9s   | 1.3s  | -32%  |
| mixed  | 640ms  | 501ms | -22%  |

The large-corpus win comes almost entirely from allocation pressure: the old
path triggered a collection roughly every four hundred lines, and the new one
completes the whole corpus inside a single young generation.

Rollout is a one-line flag flip, and the mirror stays in the tree for one more
release so a regression report can re-arm it instantly.
`

function chunkDoc(doc: string): string[] {
  const parts = doc.split(/(?<=\s)/)
  const chunks: string[] = []
  let i = 0
  let take = 1
  while (i < parts.length) {
    chunks.push(parts.slice(i, i + take).join(''))
    i += take
    take = (take % 3) + 1
  }
  return chunks
}

const CHUNK_MS = 25
const PUBLISH_MS = 32

// The store's adaptive publish over the fixed cadence: a chunk lands every
// 25ms; publish immediately when >=PUBLISH_MS since the last publish, else
// the trailing edge at the interval boundary delivers the coalesced value.
// The residual invisible beats this replay lists are CONTENT-structural
// (indent-only deltas inside a fence paint nothing); on the live product the
// streaming hold row's glyph cadence carries paints through them.
function publishTimeline(chunks: string[]): Array<{ t: number; text: string }> {
  const out: Array<{ t: number; text: string }> = []
  let text = ''
  let lastPublish = -Infinity
  let pendingAt: number | null = null
  let t = 0
  for (const c of chunks) {
    t += CHUNK_MS
    text += c
    if (pendingAt !== null && t >= pendingAt) {
      out.push({ t: pendingAt, text: text.slice(0, text.length - c.length) })
      lastPublish = pendingAt
      pendingAt = null
    }
    if (t - lastPublish >= PUBLISH_MS) {
      out.push({ t, text })
      lastPublish = t
    } else if (pendingAt === null) {
      pendingAt = lastPublish + PUBLISH_MS
    }
  }
  if (pendingAt !== null) out.push({ t: pendingAt, text })
  return out
}

/** The full rendered form StreamingMarkdown paints for one published text —
 *  stable half, seam rows, live half, and the pending trailing row. */
function renderedForm(text: string, boundaryRef: { b: number }): string {
  boundaryRef.b = advanceStableBoundary(text, boundaryRef.b)
  const stable = text.slice(0, boundaryRef.b)
  const live = text.slice(boundaryRef.b)
  const fmt = (s: string): string =>
    s === ''
      ? ''
      : marked
          .lexer(s)
          .map(tk => (tk.type === 'table' ? `⟨TABLE:${JSON.stringify(tk)}⟩` : formatToken(tk, theme, 0, null, null, highlight, 100)))
          .join('')
          .trim()
  const seam = stable === '' ? 0 : computeSeamRows(stable, theme)
  // The write-head caret (StreamingMarkdown, MERCURY_STREAM_CARET — mirror
  // the flag with BEAT_CARET=1): inline after the last glyph mid-word, on
  // the head row at the arriving indent's column during trailing whitespace
  // runs — the run's growth moves a real cell. Unarmed: the pending-row
  // reveal alone (the fold's default posture).
  const caretArmed = process.env.BEAT_CARET === '1'
  const headRun = (live.match(/[ \t]*$/)?.[0] ?? '').slice(0, 40)
  const caretOnHeadRow = caretArmed && (/(?:\n[ \t]*)$/.test(live) || live.trim() === '')
  const blankRows = caretOnHeadRow
    ? Math.max(0, pendingRowsOf(live) - 1)
    : pendingRowsOf(live)
  const pending = live.trim() !== '' ? `⟨PENDING-ROWS:${blankRows}⟩` : ''
  const caret = caretArmed ? `⟨CARET:${caretOnHeadRow ? 'row' : 'in'}:${headRun}⟩` : ''
  return `${fmt(stable)}⟨SEAM:${seam}⟩${fmt(live)}${pending}${caret}`
}

const chunks = chunkDoc(DOC)
const publishes = publishTimeline(chunks)
const boundaryRef = { b: 0 }
let prev = ''
let invisible = 0
const gaps: number[] = []
let lastVisibleT = 0
const invisibleDetail: Array<{ i: number; t: number; tail: string }> = []
for (let i = 0; i < publishes.length; i++) {
  const { t, text } = publishes[i]!
  const form = renderedForm(text, boundaryRef)
  if (form === prev) {
    invisible++
    invisibleDetail.push({ i, t, tail: JSON.stringify(text.slice(-24)) })
    if (process.env.BEAT_DEBUG && invisibleDetail.length <= 3) {
      console.log('DBG prevForm tail:', JSON.stringify(prev.slice(-90)))
      console.log('DBG thisForm tail:', JSON.stringify(form.slice(-90)))
    }
  } else {
    if (lastVisibleT > 0) gaps.push(t - lastVisibleT)
    lastVisibleT = t
  }
  prev = form
}
gaps.sort((a, b) => a - b)
const pct = (p: number): number => gaps[Math.min(gaps.length - 1, Math.floor((p / 100) * gaps.length))] ?? 0
console.log(`publishes=${publishes.length} invisible-beats=${invisible}`)
console.log(`visible-update gaps: p50=${pct(50)} p90=${pct(90)} p99=${pct(99)} max=${gaps[gaps.length - 1]}`)
for (const d of invisibleDetail) console.log(`  invisible #${d.i} t=${d.t} tail=${d.tail}`)
if (process.env.MEASURE_JSON) {
  await Bun.write(process.env.MEASURE_JSON, JSON.stringify({ publishes: publishes.length, invisible, gaps }, null, 1))
}
