#!/usr/bin/env bun
// ============================================================================
//  scripts/model-transition/bench-resume.ts — the resume/
//  reconnect BASELINE (recorded BEFORE any repair, so the repair wave's
//  budgets have an honest floor).
//
//  Creates the missing evidence own budget named (10k/100k-turn +
//  151MB-class resume) and the missing RECONNECT AXIS (bytes/records
//  visited + time-to-usable proxy) alongside the/R0 axes:
//
//    per size ∈ {1k, 10k, 100k(=the 151MB class)} — each measured in its
//    OWN subprocess (RSS isolation):
//      cold        — sidecar deleted before every run: the full parse
//      snapshot    — sidecar covering the whole file: fold + zero tail
//      snapshot+tail — 50 fresh turns appended past the cursor: fold +
//                      proven-suffix parse (tailBytes recorded)
//    3 runs each, median recorded; corpus digests pinned.
//
//  Writes the docs/benchmarks/continuum/ctm0-scale-baseline.json receipt.
//  Manual (bench-*, not prove-*): run on a quiet machine; the pool never
//  runs benches. Env pinned here (L26) — the snapshot flag default-ON and
//  the precompact skip untouched (the corpus is boundary-free by design).
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const BUN = process.env.BUN ?? join(process.env.HOME ?? '', '.bun/bin/bun')
const CORPUS_DIR = process.env.CTM_CORPUS_DIR ?? join(tmpdir(), 'mercury-continuum-corpus')
const RECEIPT = join(ROOT, 'docs', 'benchmarks', 'continuum', 'ctm0-scale-baseline.json')

const SIZES = [
  { name: '1k', turns: 1_000 },
  { name: '10k', turns: 10_000 },
  { name: '100k', turns: 100_000, note: 'the 151MB-class body' },
]

// ── child mode: measure ONE file in an isolated process ────────────────────
if (process.argv[2] === '--measure') {
  const file = process.argv[3]!
  process.env.MERCURY_CONFIG_DIR = join(tmpdir(), 'ctm-bench-config')
  delete process.env.MERCURY_RESUME_SNAPSHOT
  const { loadTranscriptFile } = await import('../../src/utils/sessionStorage/loading.ts')
  const { snapshotPathFor } = await import('../../src/utils/sessionStorage/resumeSnapshot.ts')
  const { generateCorpus } = await import('./gen-scale-corpus.ts')
  const sidecar = snapshotPathFor(file)
  const median = (xs: number[]) => xs.slice().sort((p, q) => p - q)[Math.floor(xs.length / 2)]!

  const run = async (): Promise<{ ms: number; messages: number }> => {
    const t0 = performance.now()
    const r = await loadTranscriptFile(file)
    return { ms: performance.now() - t0, messages: r.messages.size }
  }

  // cold ×3 (sidecar deleted each time)
  const cold: number[] = []
  let messages = 0
  for (let i = 0; i < 3; i++) {
    rmSync(sidecar, { force: true })
    const r = await run()
    cold.push(r.ms)
    messages = r.messages
  }
  // mint the sidecar once, then snapshot ×3 (zero tail)
  await run()
  if (!existsSync(sidecar)) {
    console.log(JSON.stringify({ error: 'no sidecar minted (file under SNAPSHOT_MIN_BYTES?)' }))
    process.exit(0)
  }
  const snap: number[] = []
  for (let i = 0; i < 3; i++) snap.push((await run()).ms)
  // snapshot+tail: append 50 fresh turns PAST the covered cursor
  const preSize = statSync(file).size
  const tailFile = file + '.tail-tmp'
  await generateCorpus({ turns: 50, seed: 0xbadcafe }, tailFile)
  appendFileSync(file, readFileSync(tailFile))
  rmSync(tailFile, { force: true })
  const tailBytes = statSync(file).size - preSize
  const snapTail: number[] = []
  for (let i = 0; i < 3; i++) snapTail.push((await run()).ms)

  console.log(
    JSON.stringify({
      bytes: preSize,
      messages,
      coldMs: Math.round(median(cold)!),
      snapshotMs: Math.round(median(snap)!),
      snapshotTailMs: Math.round(median(snapTail)!),
      tailBytes,
      rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    }),
  )
  process.exit(0)
}

// ── parent mode: generate + orchestrate ─────────────────────────────────────
const { generateCorpus } = await import('./gen-scale-corpus.ts')
mkdirSync(CORPUS_DIR, { recursive: true })
const rows: Record<string, unknown>[] = []
for (const size of SIZES) {
  const file = join(CORPUS_DIR, `corpus-${size.name}.jsonl`)
  // Always regenerate: prior bench runs append tail turns (digest honesty).
  const t0 = performance.now()
  const lines = await generateCorpus({ turns: size.turns }, file)
  const genMs = Math.round(performance.now() - t0)
  const digest = createHash('sha256').update(readFileSync(file)).digest('hex')
  console.log(`── ${size.name}: ${lines} lines, generated in ${genMs}ms — measuring…`)
  const out = execFileSync(BUN, [import.meta.path, '--measure', file], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      BUN: process.env.BUN,
      TMPDIR: process.env.TMPDIR,
    },
    maxBuffer: 16 * 1024 * 1024,
  })
  const measured = JSON.parse(out.trim().split('\n').pop()!) as Record<string, unknown>
  rows.push({ size: size.name, turns: size.turns, lines, sha256: digest, ...(size.note ? { note: size.note } : {}), ...measured })
  console.log(`   ${JSON.stringify(measured)}`)
}

const receipt = {
  program: 'continuum',
  row: 'resume-scale',
  recordedAt: new Date().toISOString(),
  recordedBefore: 'the pre-repair floor',
  axes: {
    coldMs: 'full-history parse, sidecar absent (median of 3)',
    snapshotMs: 'snapshot hit, zero tail (median of 3)',
    snapshotTailMs: 'snapshot hit + 50-turn appended suffix (median of 3)',
    tailBytes: 'bytes visited past the covered cursor — the reconnect bytes-visited axis',
    rssMb: 'child-process RSS after the full battery (per-size isolation)',
  },
  generator: 'scripts/model-transition/gen-scale-corpus.ts (deterministic; corpus never committed — digests pin identity)',
  environment: { bun: Bun.version, platform: process.platform, arch: process.arch },
  rows,
}
mkdirSync(join(ROOT, 'docs', 'benchmarks', 'continuum'), { recursive: true })
writeFileSync(RECEIPT, JSON.stringify(receipt, null, 2) + '\n')
console.log(`\nreceipt → ${RECEIPT}`)
