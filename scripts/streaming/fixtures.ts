// ============================================================================
//  scripts/streaming/fixtures.ts — deterministic synthetic stream fixtures for the
//  benches + proofs.
//
//  A fixture is a timed script of provider-shaped deltas. Everything is
//  seeded/deterministic — same fixture name ⇒ byte-identical delta sequence
//  and schedule, so before/after runs measure the RENDERER, not the fixture.
//
//  SENTINELS: `⟦Sn⟧` tokens are embedded MID-LINE roughly every 600ms of
//  stream time. A bench records when each sentinel was EMITTED (handed to the
//  fan-out) and scans INK_WRITE_TEE_FULL for when it first REACHED a terminal
//  write — the visibility-latency distribution IS defect A, quantified.
//  The glyphs ⟦⟧ carry no markdown meaning and never appear in chrome.
// ============================================================================

export type TimedDelta = {
  /** ms from stream start */
  atMs: number
  /** text_delta payload; null = an input_json_delta on the tool block */
  text: string | null
  toolJson?: string
}

export type StreamFixture = {
  name: string
  /** schedule of deltas (text + optional interleaved tool-input storms) */
  deltas: TimedDelta[]
  /** sentinel → scheduled emit time (ms from start) */
  sentinels: Map<string, number>
  /** the full text the stream reconstructs (byte-equality oracle) */
  fullText: string
  /** whether the fixture opens a tool_use block mid-stream */
  hasToolBlock: boolean
}

// Seeded LCG — deterministic across runs/platforms.
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0xffffffff
  }
}

const WORDS =
  `stream continuity frame patch cadence terminal composer cockpit rail lattice
   glyph settle honest state anchor viewport transcript delta commit layout
   damage diff write throttle batch flush boundary fence prose paragraph`
    .split(/\s+/)
    .filter(Boolean)

/** Build prose of ~targetChars with sentences and occasional newlines; insert
 *  a sentinel roughly every sentinelEveryChars, always MID-LINE. */
function buildProse(
  rnd: () => number,
  targetChars: number,
  sentinelEveryChars: number,
  startSentinel: number,
): { text: string; sentinelOffsets: Map<string, number> } {
  let text = ''
  let sinceSentinel = sentinelEveryChars * 0.4 // first sentinel arrives early
  let sinceNewline = 0
  let sIdx = startSentinel
  const sentinelOffsets = new Map<string, number>()
  while (text.length < targetChars) {
    const w = WORDS[Math.floor(rnd() * WORDS.length)]!
    if (sinceSentinel >= sentinelEveryChars && sinceNewline > 8) {
      const tok = `⟦S${sIdx}⟧`
      sentinelOffsets.set(tok, text.length)
      text += tok + ' '
      sIdx++
      sinceSentinel = 0
    }
    text += w
    sinceSentinel += w.length + 1
    sinceNewline += w.length + 1
    if (rnd() < 0.08 && sinceNewline > 60) {
      text += '.\n'
      sinceNewline = 0
    } else if (rnd() < 0.12) {
      text += '. '
    } else {
      text += ' '
    }
  }
  return { text, sentinelOffsets }
}

/** Chop `text` into deltas of size [minChunk,maxChunk] scheduled every gapMs
 *  (burstEvery>0 ⇒ deltas cluster: burstEvery per burst, bursts gapMs apart).
 *  ⟦…⟧ sentinel tokens are always emitted ATOMICALLY as their own delta —
 *  a split token paints across two frames and the second frame's cell diff
 *  re-emits only the missing glyphs, so no single write ever carries the
 *  whole token (a probe artifact, not a fluidity fact). */
function schedule(
  rnd: () => number,
  text: string,
  opts: { minChunk: number; maxChunk: number; gapMs: number; burstSize?: number },
): TimedDelta[] {
  const deltas: TimedDelta[] = []
  let off = 0
  let t = 0
  let inBurst = 0
  while (off < text.length) {
    let n = Math.min(
      text.length - off,
      opts.minChunk + Math.floor(rnd() * (opts.maxChunk - opts.minChunk + 1)),
    )
    // Atomic sentinels: a chunk starting ON a token carries the WHOLE token;
    // a chunk that would cut INTO a later token stops just before it.
    if (text.startsWith('⟦', off)) {
      const close = text.indexOf('⟧', off)
      if (close !== -1) n = Math.max(n, close + 1 - off)
    } else {
      const nextTok = text.indexOf('⟦', off)
      if (nextTok !== -1 && nextTok < off + n) n = nextTok - off
    }
    deltas.push({ atMs: Math.round(t), text: text.slice(off, off + n) })
    off += n
    if (opts.burstSize && opts.burstSize > 0) {
      inBurst++
      if (inBurst >= opts.burstSize) {
        inBurst = 0
        t += opts.gapMs
      }
    } else {
      t += opts.gapMs
    }
  }
  return deltas
}

function sentinelTimes(
  deltas: TimedDelta[],
  sentinelOffsets: Map<string, number>,
): Map<string, number> {
  // A sentinel is EMITTED when the delta containing its LAST char fires.
  const out = new Map<string, number>()
  let off = 0
  for (const d of deltas) {
    if (d.text === null) continue
    const end = off + d.text.length
    for (const [tok, tokOff] of sentinelOffsets) {
      const tokEnd = tokOff + tok.length
      if (tokEnd > off && tokEnd <= end) out.set(tok, d.atMs)
    }
    off = end
  }
  return out
}

const MARKDOWN_DOC = `# Flux fixture document

A paragraph of ordinary prose that keeps going long enough to wrap at every
sane terminal width, with **bold spans**, _emphasis_, and \`inline code\`.

## A list section

- first item with a ⟦S90⟧ sentinel mid-item
- second item that is rather longer and wraps
- third item

| col A | col B |
|-------|-------|
| one   | two   |
| three | ⟦S91⟧  |

A closing paragraph after the table with a final ⟦S92⟧ sentinel and a tail
that never gets a trailing newline`

const CODE_DOC = `Opening prose before the fence with a ⟦S95⟧ sentinel.

\`\`\`ts
export function fluxProbe(): number {
  const value = 42 // ⟦S96⟧
  return value * 2
}
\`\`\`

Prose after the fence closes carrying ⟦S97⟧ before the end.`

// Every fixture's text ends with the FIN sentinel: a fresh, unique glyph run
// the cell diff can never skip (reused-cell gaps make LONG needles unmatchable
// in per-write content) — FIN visible ⇒ the final settled text reached the
// terminal.
export const FIN = '⟦FIN⟧'

function fromDoc(name: string, doc: string, opts: Parameters<typeof schedule>[2], seed: number): StreamFixture {
  const rnd = lcg(seed)
  const text = doc + ' ' + FIN
  const sentinelOffsets = new Map<string, number>()
  for (const m of text.matchAll(/⟦S\d+⟧/g)) sentinelOffsets.set(m[0], m.index!)
  const deltas = schedule(rnd, text, opts)
  return {
    name,
    deltas,
    sentinels: sentinelTimes(deltas, sentinelOffsets),
    fullText: text,
    hasToolBlock: false,
  }
}

export function buildFixture(name: string): StreamFixture {
  switch (name) {
    case 'fast-tiny': {
      // ~4600 chars at 2-4 chars / 4ms ≈ 6.1s of dense streaming.
      const rnd = lcg(0xf1)
      const built = buildProse(rnd, 4600, 320, 0)
      const text = built.text + ' ' + FIN
      const deltas = schedule(rnd, text, { minChunk: 2, maxChunk: 4, gapMs: 4 })
      return { name, deltas, sentinels: sentinelTimes(deltas, built.sentinelOffsets), fullText: text, hasToolBlock: false }
    }
    case 'slow-visible': {
      // one 4-9 char word-ish chunk every 90ms ≈ human-readable pace, ~5s.
      const rnd = lcg(0xf2)
      const built = buildProse(rnd, 380, 90, 10)
      const text = built.text + ' ' + FIN
      const deltas = schedule(rnd, text, { minChunk: 4, maxChunk: 9, gapMs: 90 })
      return { name, deltas, sentinels: sentinelTimes(deltas, built.sentinelOffsets), fullText: text, hasToolBlock: false }
    }
    case 'bursty': {
      // bursts of 30 deltas landing together, 350ms apart, ~7.5s.
      const rnd = lcg(0xf3)
      const built = buildProse(rnd, 2600, 340, 20)
      const text = built.text + ' ' + FIN
      const deltas = schedule(rnd, text, { minChunk: 3, maxChunk: 5, gapMs: 350, burstSize: 30 })
      return { name, deltas, sentinels: sentinelTimes(deltas, built.sentinelOffsets), fullText: text, hasToolBlock: false }
    }
    case 'markdown-large':
      return fromDoc(name, MARKDOWN_DOC, { minChunk: 6, maxChunk: 10, gapMs: 6 }, 0xf4)
    case 'code-fence':
      return fromDoc(name, CODE_DOC, { minChunk: 4, maxChunk: 6, gapMs: 6 }, 0xf5)
    case 'mixed-tools': {
      // prose @8ms with an input_json_delta storm (120 deltas, 2ms) starting
      // at ~1.5s — the dominant agentic mode: text + a streaming Write body.
      const rnd = lcg(0xf6)
      const built = buildProse(rnd, 3000, 300, 30)
      const text = built.text + ' ' + FIN
      const sentinelOffsets = built.sentinelOffsets
      const deltas = schedule(rnd, text, { minChunk: 3, maxChunk: 6, gapMs: 8 })
      const toolJson = JSON.stringify({
        file_path: '/tmp/flux-fixture.txt',
        content: 'x'.repeat(2400),
      })
      const toolDeltas: TimedDelta[] = []
      const pieces = 120
      const step = Math.ceil(toolJson.length / pieces)
      for (let i = 0; i < pieces; i++) {
        toolDeltas.push({
          atMs: 1500 + i * 2,
          text: null,
          toolJson: toolJson.slice(i * step, (i + 1) * step),
        })
      }
      const merged = [...deltas, ...toolDeltas].sort((a, b) => a.atMs - b.atMs)
      return { name, deltas: merged, sentinels: sentinelTimes(deltas, sentinelOffsets), fullText: text, hasToolBlock: true }
    }
    default:
      throw new Error(`unknown fixture: ${name}`)
  }
}

export const FIXTURE_NAMES = [
  'fast-tiny',
  'slow-visible',
  'bursty',
  'markdown-large',
  'code-fence',
  'mixed-tools',
] as const
