#!/usr/bin/env bun
// ============================================================================
//  scripts/model-transition/prove-transition-g07-corpus.ts — the scale
//  corpus is DETERMINISTIC and loader-conformant.
//
//  §A regeneration is byte-identical (two independent generations, one
//     digest) and matches the PINNED digest — any generator drift that
//     would invalidate cross-session/cross-platform baseline comparisons
//     reds the gate
//  §B the REAL loader round-trips the corpus exactly (every line lands a
//     message; single linear leaf — the parent chain is sound)
//
//  The pool leg runs the 1k body only (cheap); the 10k/100k/151MB-class
//  legs ride scripts/model-transition/bench-resume.ts (manual, receipt-writing —
//  the pinned digests below).
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ctm-g07-config-'))

import { generateCorpus } from './gen-scale-corpus.ts'

const PINNED_1K_SHA256 = '85d783ab2a552ff0b49ddbede738c38b51b4f4c8c7e863023bfa89e18e515e8d'
const PINNED_1K_LINES = 2333

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

const dir = mkdtempSync(join(tmpdir(), 'ctm-g07-corpus-'))
const a = join(dir, 'a.jsonl')
const b = join(dir, 'b.jsonl')
const linesA = await generateCorpus({ turns: 1000 }, a)
const linesB = await generateCorpus({ turns: 1000 }, b)
const digest = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')
const da = digest(a)
const db = digest(b)

check('§A two generations, one digest', da === db, da.slice(0, 16))
check('§A digest matches the pinned baseline identity', da === PINNED_1K_SHA256, da)
check('§A line count stable', linesA === PINNED_1K_LINES && linesB === PINNED_1K_LINES, String(linesA))

const { loadTranscriptFile } = await import('../../src/utils/sessionStorage/loading.ts')
const r = await loadTranscriptFile(a)
check('§B every line lands a message in the real loader', r.messages.size === PINNED_1K_LINES, String(r.messages.size))
check('§B single linear leaf (sound parent chain)', r.leafUuids.size === 1, String(r.leafUuids.size))

console.log(failures === 0 ? '\n ✅ CORPUS DETERMINISTIC + LOADER-CONFORMANT' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
