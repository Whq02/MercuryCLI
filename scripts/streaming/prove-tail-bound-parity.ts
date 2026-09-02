#!/usr/bin/env bun
// ============================================================================
//  scripts/streaming/prove-tail-bound-parity.ts — the inline tail bound's
//  backward scan is byte-for-byte the split-and-count shape.
//
//  boundTailForInline used to split the COMPLETE growing answer into a line
//  array on every publish (~25fps) to keep roughly one viewport of rows.
//  The backward scan measures only the rows that can fit and slices the
//  kept region once. The visual contract must not move a byte: this prover
//  carries the split shape verbatim as its oracle and sweeps both over
//  deterministic randomized texts and every geometry class —
//  the capRows floor (tiny rows), the width floor (narrow columns), wrap
//  overshoot at the cap, trailing newlines, empty lines, single huge
//  lines, unicode — asserting identical {text, truncated}.
//
//  P3/P4 — the fence carry. The cut's fence state used to be re-folded
//  over the WHOLE discarded prefix on every publish (a slice, a split, a
//  regex per line — O(reply length) per tick, quadratic over a long
//  stream); the fold is now carried between publishes and only the lines
//  the cut advanced over are folded. The whole-prefix split shape is
//  carried here verbatim as the fence oracle: a long multi-tick stream
//  agrees at every publish, the fold's own operation census stays near the
//  line count (O(delta), never ticks × lines), and every non-extension —
//  a new reply, a rewrite inside the prefix, a resize that retreats the
//  cut, two tails alternating — drops the carry and still agrees.
//
//  Pure string math, no PTY, no render: safe beside the pooled gate.
//
//  Run: ~/.bun/bin/bun run scripts/streaming/prove-tail-bound-parity.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const { boundTailForInline } = await import('../../src/components/LiveStreamingTail.tsx')

// ── the previous shape, verbatim, as the oracle ────────────────────────────
function oracleBound(text: string, rows: number, columns: number): { text: string; truncated: boolean } {
  const capRows = Math.max(4, rows - 6)
  const lines = text.split('\n')
  const width = Math.max(20, columns - 4)
  let used = 0
  let start = lines.length
  while (start > 0 && used < capRows) {
    const line = lines[start - 1]!
    used += Math.max(1, Math.ceil(line.length / width))
    start -= 1
  }
  if (start <= 0) return { text, truncated: false }
  return { text: lines.slice(start).join('\n'), truncated: true }
}

function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

const WORDS = ['stream', 'tail', 'row', 'wrap', 'é⚡', '終', 'a', '', 'x'.repeat(340), 'markdown **bold** text']

function randomText(rand: () => number): string {
  const lineCount = Math.floor(rand() * 60)
  const lines: string[] = []
  for (let i = 0; i < lineCount; i++) {
    const words = Math.floor(rand() * 14)
    const parts: string[] = []
    for (let w = 0; w < words; w++) parts.push(WORDS[Math.floor(rand() * WORDS.length)]!)
    lines.push(parts.join(' '))
  }
  let text = lines.join('\n')
  if (rand() < 0.3) text += '\n' // trailing newline class
  if (rand() < 0.15) text = `\n${text}` // leading newline class
  return text
}

section('P1 · deterministic sweep — 4000 random cases across geometry classes')
{
  const GEOMETRIES: Array<[number, number]> = [
    [24, 80],
    [50, 120],
    [8, 40], // capRows floor territory
    [5, 10], // both floors
    [60, 200],
    [12, 21], // width just above the floor
  ]
  let mismatches = 0
  let firstDetail = ''
  let truncatedSeen = 0
  let wholeSeen = 0
  const rand = lcg(0x5eed1)
  for (let i = 0; i < 4000; i++) {
    const text = randomText(rand)
    const [rows, columns] = GEOMETRIES[i % GEOMETRIES.length]!
    const live = boundTailForInline(text, rows, columns)
    const ref = oracleBound(text, rows, columns)
    if (live.truncated) truncatedSeen++
    else wholeSeen++
    if (live.text !== ref.text || live.truncated !== ref.truncated) {
      mismatches++
      if (!firstDetail) {
        firstDetail = `case ${i} rows=${rows} cols=${columns} live=${JSON.stringify(live).slice(0, 120)} ref=${JSON.stringify(ref).slice(0, 120)}`
      }
    }
  }
  check('zero mismatches across the sweep', mismatches === 0, firstDetail)
  check(
    `both arms exercised (truncated=${truncatedSeen}, whole=${wholeSeen})`,
    truncatedSeen > 200 && wholeSeen > 200,
    `truncated=${truncatedSeen} whole=${wholeSeen}`,
  )
}

section('P2 · pinned edge classes')
{
  const CASES: Array<[string, string, number, number]> = [
    ['empty text', '', 24, 80],
    ['single char', 'x', 24, 80],
    ['only newlines', '\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n', 12, 80],
    ['one huge unbroken line wrapping past the cap', 'y'.repeat(20_000), 10, 80],
    ['trailing newline', 'alpha\nbeta\n', 24, 80],
    ['exactly at the cap', Array.from({ length: 18 }, (_v, i) => `line ${i}`).join('\n'), 24, 80],
    ['one over the cap', Array.from({ length: 19 }, (_v, i) => `line ${i}`).join('\n'), 24, 80],
    ['tiny viewport floors', 'a\nb\nc\nd\ne\nf\ng\nh', 1, 1],
  ]
  for (const [label, text, rows, columns] of CASES) {
    const live = boundTailForInline(text, rows, columns)
    const ref = oracleBound(text, rows, columns)
    check(label, live.text === ref.text && live.truncated === ref.truncated, `live=${JSON.stringify(live).slice(0, 100)} ref=${JSON.stringify(ref).slice(0, 100)}`)
  }
}

// ── the previous fence shape, verbatim, as the oracle ──────────────────────
function oracleOpenFence(prefix: string): string | null {
  let open: { char: string; len: number; line: string } | null = null
  for (const line of prefix.split('\n')) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (!m) continue
    const marker = m[1]!
    const char = marker[0]!
    const rest = m[2]!
    if (open === null) {
      if (char === '`' && rest.includes('`')) continue
      open = { char, len: marker.length, line: line.trimStart() }
    } else if (char === open.char && marker.length >= open.len && rest.trim() === '') {
      open = null
    }
  }
  return open ? open.line : null
}

type Bound = { text: string; truncated: boolean; openFence: string | null }
/** Live vs the two oracles for one publish; empty string = agreement. */
function disagreement(text: string, rows: number, columns: number): string {
  const live = boundTailForInline(text, rows, columns) as Bound
  const ref = oracleBound(text, rows, columns)
  const refFence = ref.truncated ? oracleOpenFence(text.slice(0, text.length - ref.text.length)) : null
  if (live.text === ref.text && live.truncated === ref.truncated && live.openFence === refFence) return ''
  return `live=${JSON.stringify({ t: live.text.slice(0, 40), tr: live.truncated, f: live.openFence })} ref=${JSON.stringify({ t: ref.text.slice(0, 40), tr: ref.truncated, f: refFence })}`
}

const { fenceFoldCensus } = await import('../../src/components/LiveStreamingTail.tsx')

section('P3 · a long multi-tick stream: the carried fold agrees at every publish, at O(delta)')
{
  const rand = lcg(0x5eed3)
  const CHUNKS = ['prose ', 'more words ', '\n', '\n```ts\n', '\n```\n', '\n~~~\n', '# heading\n', '- item\n', 'x'.repeat(200), '\n   ```rb\n', '``` a`b\n', '`````\n', '\n\n', '終 é⚡ ']
  const TICKS = 1500
  let text = ''
  let mismatches = 0
  let firstDetail = ''
  let truncatedTicks = 0
  let fencedTicks = 0
  const before = { ...fenceFoldCensus }
  for (let tick = 0; tick < TICKS; tick++) {
    text += CHUNKS[Math.floor(rand() * CHUNKS.length)]!
    const detail = disagreement(text, 24, 80)
    const live = boundTailForInline(text, 24, 80) as Bound
    if (live.truncated) truncatedTicks++
    if (live.openFence !== null) fencedTicks++
    if (detail !== '') {
      mismatches++
      if (!firstDetail) firstDetail = `tick ${tick} ${detail}`
    }
  }
  const after = { ...fenceFoldCensus }
  check(`zero mismatches over ${TICKS} publishes (text, truncated, openFence)`, mismatches === 0, firstDetail)
  check('the stream truncated for most of its life (the carried arm was exercised)', truncatedTicks > TICKS / 2, String(truncatedTicks))
  check('cuts landed inside open fences along the way (the carry carried real state)', fencedTicks > 20, String(fencedTicks))
  const lineCount = text.split('\n').length
  const visited = after.lines - before.lines
  // Two bounds per publish above (disagreement + the census tick) ⇒ at most
  // two visits per line plus one per tick; the whole-prefix fold would have
  // visited roughly ticks × lines.
  check(
    `O(delta): the fold visited ${visited} lines over a ${lineCount}-line stream — near the line count, never ticks × lines`,
    visited <= 2 * lineCount + 2 * TICKS && visited * 8 < TICKS * lineCount,
    `visited=${visited} lines=${lineCount} ticks=${TICKS}`,
  )
  check('the carry was taken on the extension ticks', after.carries - before.carries >= truncatedTicks, `carries=${after.carries - before.carries} truncated=${truncatedTicks}`)
}

section('P4 · every non-extension drops the carry and still agrees')
{
  const grow = (n: number, fence: string): string =>
    Array.from({ length: n }, (_v, i) => (i % 7 === 0 ? fence : `line ${i} ${'y'.repeat(i % 50)}`)).join('\n')
  const A = grow(60, '```')
  const B = grow(45, '~~~')
  const agree = (label: string, text: string, rows: number, columns: number): void => {
    const detail = disagreement(text, rows, columns)
    check(label, detail === '', detail)
  }
  const resetsBefore = fenceFoldCensus.resets
  for (const len of [200, 400, 600, A.length]) agree(`stream A grows to ${len}`, A.slice(0, len), 24, 80)
  agree('a NEW reply (B) after A', B, 24, 80)
  check('the new reply dropped the carry', fenceFoldCensus.resets > resetsBefore)
  agree('a rewrite inside the prefix of A', `${A.slice(0, 10)}X${A.slice(11)}`, 24, 80)
  agree('A at a narrower width (the cut moves forward)', A, 24, 40)
  agree('A at a wider width (the cut retreats)', A, 24, 200)
  agree('A at fewer rows', A, 10, 80)
  for (let i = 0; i < 4; i++) {
    agree(`two tails alternating — A (${i})`, A, 24, 80)
    agree(`two tails alternating — B (${i})`, B, 24, 80)
  }
  agree('A shrunk (a retraction)', A.slice(0, 300), 24, 80)
  agree('an untruncated tail after a truncated one', 'short\ntext', 24, 80)
  agree('the empty text', '', 24, 80)
}

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
