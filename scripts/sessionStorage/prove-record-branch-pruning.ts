#!/usr/bin/env bun
// ============================================================================
//  scripts/sessionStorage/prove-record-branch-pruning.ts — dead-branch
//  pruning over the record format (the byte-level pre-parse walk in
//  sessionStorage/loading.ts).
//
//  ORACLE: a heavily forked transcript resumes O(live chain) — the dead
//  fork branches are pruned BEFORE the parse — and the pruned load folds
//  EXACTLY what the full load folds on the live chain: same rows, same
//  bytes, same metadata, no dead row ever folded.
//
//  §A unit — the pruner keeps meta + live lines, drops every dead line.
//  §B pruned-vs-full fold equality on the live chain (REAL loadTranscriptFile,
//     both loads through the real seam; full = keepAllLeaves).
//  §C dead rows never folded; the full fold proves the fixture is real.
//  §D the measured win — byte share and folded/decoded row counts.
//  §E safety gates — foreign buffers, mostly-live files and the
//     keepAllLeaves caller are untouched by the pruner.
//
//  Fixture: REAL record JSONL written through the writer's own encoder
//  (encodeTranscriptLine) — see forkedFixture.ts.
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'branch-pruning-home-'))
const scratch = mkdtempSync(join(tmpdir(), 'branch-pruning-'))

import { writeForkedFixture } from './forkedFixture.ts'

const { loadTranscriptFile, pruneRecordBranchesBeforeParse } = await import(
  '../../src/utils/sessionStorage/loading.ts'
)
const { decodeTranscriptBuffer } = await import('../../src/fabric/transcriptDecode.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

// The dead-majority shape: ~94% of bytes on dead fork branches, >5MB so the
// REAL loader takes the big-file path and its pruning gate.
const fx = await writeForkedFixture({
  path: join(scratch, `${'f0f0f0f0-1111-4000-8000-000000000001'}.jsonl`),
  turns: 300,
  forkEvery: 3,
  deadPerFork: 4,
  deadFatBytes: 16 * 1024,
})
const raw = readFileSync(fx.path)
check('fixture is big enough for the big-file path', raw.length > 5 * 1024 * 1024, String(raw.length))

section('§A unit — the pruner keeps meta + live, drops every dead line')
{
  const pruned = pruneRecordBranchesBeforeParse(raw)
  const prunedText = pruned.toString('utf8')
  check('a pruned buffer came back smaller', pruned.length < raw.length, `${pruned.length}/${raw.length}`)
  check('every live uuid survives', fx.liveUuids.every(u => prunedText.includes(u)), 'missing live rows')
  check('no dead uuid survives', !fx.deadUuids.some(u => prunedText.includes(u)))
  check(
    'metadata lines survive (title, tag, summary, header)',
    prunedText.includes('forked odyssey') &&
      prunedText.includes('"pruning"') &&
      prunedText.includes('a forked session') &&
      prunedText.includes('mercury-transcript-header'),
  )
  const decodedPruned = decodeTranscriptBuffer<Record<string, unknown>>(pruned)
  check('the pruned buffer still decodes clean (no malformed, no invalid)', decodedPruned.malformed.length === 0 && decodedPruned.invalid.length === 0 && decodedPruned.refusal === undefined)
}

section('§B pruned-vs-full fold equality on the live chain (REAL loader)')
const prunedLoad = await loadTranscriptFile(fx.path)
const fullLoad = await loadTranscriptFile(fx.path, { keepAllLeaves: true })
{
  check('full fold holds live + dead rows', fullLoad.messages.size === fx.liveUuids.length + fx.deadUuids.length, String(fullLoad.messages.size))
  check('pruned fold holds EXACTLY the live chain', prunedLoad.messages.size === fx.liveUuids.length, String(prunedLoad.messages.size))
  let equal = 0
  for (const u of fx.liveUuids) {
    const a = prunedLoad.messages.get(u as never)
    const b = fullLoad.messages.get(u as never)
    if (a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b)) equal++
  }
  check(`every live row folds BYTE-equal in both loads (${fx.liveUuids.length})`, equal === fx.liveUuids.length, `${equal}/${fx.liveUuids.length}`)
  check(
    'session metadata folds identically (title · tag · summary)',
    prunedLoad.customTitles.get(fx.sessionId as never) === 'forked odyssey' &&
      prunedLoad.tags.get(fx.sessionId as never) === 'pruning' &&
      JSON.stringify([...prunedLoad.summaries]) === JSON.stringify([...fullLoad.summaries]),
  )
  const liveTail = fx.liveUuids[fx.liveUuids.length - 1]!
  check('the pruned load resumes at the live tail (ONE leaf)', prunedLoad.leafUuids.size === 1 && prunedLoad.leafUuids.has(liveTail as never))
  check('the full load still sees every fork tip as a leaf (+ the live tail)', fullLoad.leafUuids.size === 1 + fx.deadUuids.length / 4 && fullLoad.leafUuids.has(liveTail as never), String(fullLoad.leafUuids.size))
}

section('§C dead rows never folded')
{
  check('no dead uuid in the pruned fold', !fx.deadUuids.some(u => prunedLoad.messages.has(u as never)))
  check('the fixture is REAL — the full fold does hold the dead rows', fx.deadUuids.every(u => fullLoad.messages.has(u as never)))
}

section('§D the measured win')
{
  const pruned = pruneRecordBranchesBeforeParse(raw)
  const fullRows = decodeTranscriptBuffer<Record<string, unknown>>(raw).entries.length
  const prunedRows = decodeTranscriptBuffer<Record<string, unknown>>(pruned).entries.length
  console.log(`  bytes: ${raw.length} → ${pruned.length} (${((pruned.length / raw.length) * 100).toFixed(1)}% kept)`)
  console.log(`  decoded rows: ${fullRows} → ${prunedRows}`)
  console.log(`  folded rows: ${fullLoad.messages.size} → ${prunedLoad.messages.size}`)
  check('the dead byte majority never reaches the parse (≤ 20% of bytes kept)', pruned.length <= raw.length * 0.2, String(pruned.length / raw.length))
  check('decoded row count drops by the dead-row count', fullRows - prunedRows === fx.deadUuids.length, `${fullRows}-${prunedRows}`)
}

section('§E safety gates — anything unexpected is untouched')
{
  const foreign = Buffer.from('{"type":"user","message":{"role":"user","content":"other era"}}\n')
  check('a non-record buffer returns UNCHANGED (same reference)', pruneRecordBranchesBeforeParse(foreign) === foreign)
  // A mostly-live file: same shape, dead bytes thin — under the half-dead
  // stitch gate the buffer must come back untouched.
  const smallFx = await writeForkedFixture({
    path: join(scratch, 'mostly-live.jsonl'),
    turns: 40,
    forkEvery: 20,
    deadPerFork: 1,
    deadFatBytes: 64,
  })
  const smallRaw = readFileSync(smallFx.path)
  check('a mostly-live file is untouched (the half-dead gate)', pruneRecordBranchesBeforeParse(smallRaw) === smallRaw)
  // keepAllLeaves (the /insights caller) folds EVERY row of the big file.
  check('keepAllLeaves folds every row (the caller gate)', fullLoad.messages.size === fx.liveUuids.length + fx.deadUuids.length)
  // A meta-only buffer (no chain nodes) is untouched.
  const metaOnly = Buffer.concat([raw.subarray(0, raw.indexOf(0x0a) + 1)])
  check('a header-only buffer is untouched', pruneRecordBranchesBeforeParse(metaOnly) === metaOnly)
}

console.log(failures === 0 ? '\n ✅ RECORD BRANCH PRUNING PROVEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
