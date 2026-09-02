
export type TimedDelta = {
  atMs: number
  text: string | null
  toolJson?: string
}

export type StreamFixture = {
  name: string
  deltas: TimedDelta[]
  sentinels: Map<string, number>
  fullText: string
  hasToolBlock: boolean
}

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

function buildProse(
  rnd: () => number,
  targetChars: number,
  sentinelEveryChars: number,
  startSentinel: number,
): { text: string; sentinelOffsets: Map<string, number> } {
  let text = ''
  let sinceSentinel = sentinelEveryChars * 0.4
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
      const rnd = lcg(0xf1)
      const built = buildProse(rnd, 4600, 320, 0)
      const text = built.text + ' ' + FIN
      const deltas = schedule(rnd, text, { minChunk: 2, maxChunk: 4, gapMs: 4 })
      return { name, deltas, sentinels: sentinelTimes(deltas, built.sentinelOffsets), fullText: text, hasToolBlock: false }
    }
    case 'slow-visible': {
      const rnd = lcg(0xf2)
      const built = buildProse(rnd, 380, 90, 10)
      const text = built.text + ' ' + FIN
      const deltas = schedule(rnd, text, { minChunk: 4, maxChunk: 9, gapMs: 90 })
      return { name, deltas, sentinels: sentinelTimes(deltas, built.sentinelOffsets), fullText: text, hasToolBlock: false }
    }
    case 'bursty': {
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
