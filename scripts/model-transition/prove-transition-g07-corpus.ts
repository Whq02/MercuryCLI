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

check('§A two generations, one digest', da === db, `${da.slice(0, 16)}; generateCorpus in scripts/model-transition/gen-scale-corpus.ts must write the same bytes for the same spec (remove any clock or random input)`)
check('§A digest matches the pinned baseline identity', da === PINNED_1K_SHA256, `${da}; if generateCorpus in scripts/model-transition/gen-scale-corpus.ts changed on purpose, set PINNED_1K_SHA256 and PINNED_1K_LINES in this file to the new values, otherwise restore its output`)
check('§A line count stable', linesA === PINNED_1K_LINES && linesB === PINNED_1K_LINES, `${linesA}; generateCorpus in scripts/model-transition/gen-scale-corpus.ts must return PINNED_1K_LINES lines for 1000 turns (update PINNED_1K_LINES here only for an intended change)`)

const { loadTranscriptFile } = await import('../../src/utils/sessionStorage/loading.ts')
const r = await loadTranscriptFile(a)
check('§B every line lands a message in the real loader', r.messages.size === PINNED_1K_LINES, `${r.messages.size}; each line generateCorpus writes in scripts/model-transition/gen-scale-corpus.ts must parse as a message in loadTranscriptFile (src/utils/sessionStorage/loading.ts)`)
check('§B single linear leaf (sound parent chain)', r.leafUuids.size === 1, `${r.leafUuids.size}; generateCorpus in scripts/model-transition/gen-scale-corpus.ts must give each message the previous message uuid as parentUuid`)

console.log(failures === 0 ? '\n ✅ CORPUS DETERMINISTIC + LOADER-CONFORMANT' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
