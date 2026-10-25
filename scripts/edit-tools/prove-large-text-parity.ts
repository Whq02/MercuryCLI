#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { preserveUntouchedLineEndings } from '../../src/utils/file.ts'
import {
  _resetSeenLinesForTesting,
  recordSeenLines,
  seenLinesOf,
  SEEN_LINES_BOUNDS,
} from '../../src/services/changeTransaction/seenLines.ts'
import type { OwnerKey } from '../../src/services/run/ownerKey.ts'

type Range = { start: number; end: number }
const owner = 'large-text-parity' as OwnerKey
let seed = 0x44
function random(n: number): number {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return seed % n
}

function subtract(ranges: Range[], cuts: number[]): Range[] {
  let kept = ranges
  for (const line of cuts) kept = kept.flatMap(range => line < range.start || line > range.end ? [range] : [
    ...(line > range.start ? [{ start: range.start, end: line - 1 }] : []),
    ...(line < range.end ? [{ start: line + 1, end: range.end }] : []),
  ])
  return kept
}
function bounded(ranges: Range[]): Range[] {
  while (ranges.length > SEEN_LINES_BOUNDS.rangeCap) {
    let smallest = 0
    for (let i = 1; i < ranges.length; i++) {
      if (ranges[i]!.end - ranges[i]!.start < ranges[smallest]!.end - ranges[smallest]!.start) smallest = i
    }
    ranges.splice(smallest, 1)
  }
  return ranges
}

for (let trial = 0; trial < 200; trial++) {
  _resetSeenLinesForTesting()
  const start = 1 + random(20)
  const count = 1 + random(10000)
  const cuts = Array.from({ length: random(1200) }, () => random(count + start + 20))
  const expected = bounded(subtract([{ start, end: start + count - 1 }], cuts))
  recordSeenLines(owner, 'fixture', 'generation', start, count, cuts.map(line => ({ line, visibleChars: 2000 })))
  assert.deepEqual(seenLinesOf(owner, 'fixture', 'generation')?.ranges, expected)
}
_resetSeenLinesForTesting()
const alternating = Array.from({ length: 5000 }, (_, i) => ({ line: i * 2 + 1, visibleChars: 2000 }))
recordSeenLines(owner, 'fixture', 'generation', 1, 10000, alternating)
assert.deepEqual(seenLinesOf(owner, 'fixture', 'generation')?.ranges,
  Array.from({ length: 256 }, (_, i) => ({ start: 9490 + i * 2, end: 9490 + i * 2 })))
recordSeenLines(owner, 'fixture', 'generation', 9999, 2)
assert.ok(seenLinesOf(owner, 'fixture', 'generation')?.ranges.some(r => r.start <= 9999 && r.end >= 10000))
_resetSeenLinesForTesting()

for (const majority of ['LF', 'CRLF'] as const) {
  assert.equal(preserveUntouchedLineEndings('', '', majority), '')
  assert.equal(preserveUntouchedLineEndings('', 'new\n', majority), majority === 'LF' ? 'new\n' : 'new\r\n')
  assert.equal(preserveUntouchedLineEndings('last', 'changed', majority), 'changed')
  for (let trial = 0; trial < 300; trial++) {
    const n = 2 + random(80)
    const raw = Array.from({ length: n }, (_, i) => `line-${i}-${trial}${random(2) ? '\r\n' : '\n'}`)
    if (random(2)) raw[n - 1] = raw[n - 1]!.replace(/\r?\n$/, '')
    const normal = raw.map(line => line.replace(/\r\n$/, '\n'))
    assert.equal(preserveUntouchedLineEndings(raw.join(''), normal.join(''), majority), raw.join(''))
    const at = random(n)
    const replaced = [...normal]; replaced[at] = replaced[at]!.replace('line-', 'changed-')
    const expected = [...raw]; expected[at] = expected[at]!.replace('line-', 'changed-')
    assert.equal(preserveUntouchedLineEndings(raw.join(''), replaced.join(''), majority), expected.join(''))
    const removed = [...normal]; removed.splice(at, 1)
    const expectedRemoved = [...raw]; expectedRemoved.splice(at, 1)
    assert.equal(preserveUntouchedLineEndings(raw.join(''), removed.join(''), majority), expectedRemoved.join(''))
    const added = [...normal]; added.splice(at, 0, 'added\n')
    const expectedAdded = [...raw]; expectedAdded.splice(at, 0, majority === 'LF' ? 'added\n' : 'added\r\n')
    assert.equal(preserveUntouchedLineEndings(raw.join(''), added.join(''), majority), expectedAdded.join(''))
  }
}
console.log('PASS large-text parity: 200 ledger oracles, 10k clipped rows, 600 mixed-ending edit/insert/delete cases')
