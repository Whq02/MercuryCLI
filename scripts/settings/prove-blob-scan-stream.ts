#!/usr/bin/env bun
// ============================================================================
//  scripts/settings/prove-blob-scan-stream.ts — FN-020 row 11: the daily
//  housekeeping blob scan streams the transcript instead of double-buffering
//  it whole.
//
//  The class: for every recent session with a tool-results directory,
//  collectReferencedBlobDirs read the ENTIRE transcript into a Buffer and
//  then allocated a second full-size latin1 string to regex-scan — the
//  transcripts that qualify are precisely the recent tool-heavy large ones
//  (session files reach multiple GB), and the spike landed moments into the
//  session. The scan now reads 4 MiB chunks through one handle with a 1 KiB
//  carry, so a reference straddling a chunk edge is found whole.
//
//    B1  PARITY — over a 13.5 MiB transcript with references planted early,
//        ending exactly at the first chunk edge, the subdirectory token cut
//        at the second, the name cut at the third, fully inside the carry
//        zone, with a backslash separator, and ending exactly at the file's
//        end, the streamed set equals the replaced whole-buffer road's set
//        (carried verbatim as the oracle)
//    B2  THE COUNT — 4 chunk reads, the largest chunk 4 MiB, no whole read:
//        peak transient bytes one chunk plus the carry, not twice the file
//    B3  the fallback — a fake fs without the chunk reader takes the
//        whole-file road, same set
//    B4  an aged transcript still yields null (the reachability rule kept)
//
//  Operation-shaped throughout (the module's own census); no wall clock.
// ============================================================================
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'blob-scan-home-'))
delete process.env.NODE_ENV
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const cleanup = await import('../../src/utils/cleanup.ts')
const fsOps = await import('../../src/utils/fsOperations.ts')
const { TOOL_RESULTS_SUBDIR } = await import('../../src/utils/toolResultStorage.ts')
const census = cleanup.blobScanCensus
const reset = (): void => {
  census.chunkReads = 0
  census.wholeReads = 0
  census.maxChunkBytes = 0
}

const CHUNK = 4 * 1024 * 1024
// 13.5 MiB: three internal chunk edges (4, 8 and 12 MiB) — one reference
// ending exactly at the first, the subdirectory token cut at the second,
// the name cut at the third. Plants never overlap (two at one edge would
// clobber each other and prove nothing about the scan).
const TOTAL = Math.floor(13.5 * 1024 * 1024)
// Filler of NON-name bytes (spaces and newlines), so a planted name ends
// where it was written and never absorbs its neighbours.
const buf = Buffer.alloc(TOTAL, ' '.repeat(199) + '\n')
const expected = new Set<string>()
const plant = (offset: number, name: string, sep = '/'): void => {
  buf.write(`${TOOL_RESULTS_SUBDIR}${sep}${name}`, offset, 'latin1')
  expected.add(name)
}
const refLen = (name: string): number => TOOL_RESULTS_SUBDIR.length + 1 + name.length
plant(1000, 'early-aaaa')
plant(CHUNK - refLen('ends-at-edge'), 'ends-at-edge')
plant(CHUNK + 10, 'just-after-edge')
plant(2 * CHUNK - 5, 'straddle-token')
plant(2 * CHUNK - 600, 'inside-carry-zone')
plant(3 * CHUNK - 20, 'straddle-name')
plant(5 * 1024 * 1024, 'backslash-sep', '\\')
plant(TOTAL - refLen('at-file-end'), 'at-file-end')
for (let i = 0; i < 40; i++) plant(100_000 + i * 200_000, `scattered-${i}`)

const dir = mkdtempSync(join(tmpdir(), 'blob-scan-'))
const path = join(dir, 'session.jsonl')
writeFileSync(path, buf)
const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000)

// The replaced road, verbatim: the whole Buffer, a whole latin1 string, one regex pass.
const oracle = new Set<string>()
{
  const escapedSubdir = TOOL_RESULTS_SUBDIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`${escapedSubdir}[/\\\\]+([A-Za-z0-9_.-]+)`, 'g')
  for (const match of buf.toString('latin1').matchAll(pattern)) oracle.add(match[1] as string)
}
const sameSet = (a: Set<string> | null, b: Set<string>): boolean => a !== null && a.size === b.size && [...b].every(x => a.has(x))

section('B1 PARITY — the streamed set equals the whole-buffer oracle')
reset()
const streamed = await cleanup.collectReferencedBlobDirs(path, cutoff)
{
  check(`the oracle found every planted reference (${expected.size} planted, ${oracle.size} found)`, [...expected].every(x => oracle.has(x)) && oracle.size === expected.size, `${oracle.size}`)
  check('the streamed scan equals the oracle, member for member', sameSet(streamed, oracle), `${streamed?.size ?? 'null'} vs ${oracle.size}`)
  for (const name of ['ends-at-edge', 'straddle-token', 'straddle-name', 'inside-carry-zone', 'backslash-sep', 'at-file-end']) {
    check(`…including the edge case '${name}'`, streamed?.has(name) === true)
  }
}

section('B2 THE COUNT — chunks, never the whole file')
{
  check('four chunk reads over 13.5 MiB (4 + 4 + 4 + 1.5), no whole-file read', census.chunkReads === 4 && census.wholeReads === 0, JSON.stringify(census))
  check('the largest chunk handed to the scan is exactly 4 MiB', census.maxChunkBytes === CHUNK, String(census.maxChunkBytes))
  console.log(`  BEFORE: peak transient allocation ≈ 2 × ${(TOTAL / 1024 / 1024).toFixed(1)} MiB (the whole Buffer + a whole latin1 string) · AFTER: one ${CHUNK / 1024 / 1024} MiB chunk + a 1 KiB carry (+ that chunk's latin1 string), whatever the transcript's size`)
}

section('B3 the fallback — a fake fs without the chunk reader takes the whole-file road')
{
  const real = fsOps.getFsImplementation()
  fsOps.setFsImplementation({ ...real, readFileChunks: undefined } as never)
  try {
    reset()
    const viaWhole = await cleanup.collectReferencedBlobDirs(path, cutoff)
    check('the whole-file road ran once, no chunk reads', census.wholeReads === 1 && census.chunkReads === 0, JSON.stringify(census))
    check('…and answers the same set', sameSet(viaWhole, oracle))
  } finally {
    fsOps.setOriginalFsImplementation()
  }
}

section('B4 an aged transcript still yields null (the reachability rule kept)')
{
  const old = (Date.now() - 3 * 24 * 60 * 60 * 1000) / 1000
  utimesSync(path, old, old)
  reset()
  const aged = await cleanup.collectReferencedBlobDirs(path, cutoff)
  check('an aged transcript answers null before any read', aged === null && census.chunkReads === 0 && census.wholeReads === 0, JSON.stringify(census))
}

console.log(failures === 0 ? '\n✅ ALL BLOB-SCAN-STREAM PROOFS PASS' : `\n❌ ${failures} BLOB-SCAN-STREAM PROOF(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
