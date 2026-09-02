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

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
