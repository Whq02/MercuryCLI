#!/usr/bin/env bun
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
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && hint ? ' — to fix: ' + hint : ''}`)
}

const dir = mkdtempSync(join(tmpdir(), 'ctm-g07-corpus-'))
const a = join(dir, 'a.jsonl')
const b = join(dir, 'b.jsonl')
const linesA = await generateCorpus({ turns: 1000 }, a)
const linesB = await generateCorpus({ turns: 1000 }, b)
const digest = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')
const da = digest(a)
const db = digest(b)

check('§A two generations, one digest', da === db, da.slice(0, 16), 'remove clocks, random ids and unordered output from generateCorpus in scripts/model-transition/gen-scale-corpus.ts')
check('§A digest matches the pinned baseline identity', da === PINNED_1K_SHA256, da, 'if generateCorpus in scripts/model-transition/gen-scale-corpus.ts changed on purpose, set PINNED_1K_SHA256 and PINNED_1K_LINES in this file to the new values; otherwise undo the change')
check('§A line count stable', linesA === PINNED_1K_LINES && linesB === PINNED_1K_LINES, String(linesA), 'if generateCorpus in scripts/model-transition/gen-scale-corpus.ts changed on purpose, set PINNED_1K_LINES in this file; otherwise undo the change')

const { loadTranscriptFile } = await import('../../src/sessions/transcripts/loading.ts')
const r = await loadTranscriptFile(a)
check('§B every line lands a message in the real loader', r.messages.size === PINNED_1K_LINES, String(r.messages.size), 'make every line generateCorpus writes a message loadTranscriptFile in src/sessions/transcripts/loading.ts accepts')
check('§B single linear leaf (sound parent chain)', r.leafUuids.size === 1, String(r.leafUuids.size), 'make each generated line point its parent at the line before it in scripts/model-transition/gen-scale-corpus.ts')

console.log(failures === 0 ? '\n ✅ CORPUS DETERMINISTIC + LOADER-CONFORMANT' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
