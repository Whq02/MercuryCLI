#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ctm-g05-config-'))
process.env.MERCURY_HOME = mkdtempSync(join(tmpdir(), 'ctm-g05-home-'))
process.env.ANTHROPIC_API_KEY = 'fixture-key'

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

const { encodeTranscriptLine } = await import('../../src/utils/sessionStorage/vnext.ts')

let failed = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failed++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

const scratch = mkdtempSync(join(tmpdir(), 'ctm-g05-transcript-'))
const transcriptPath = join(scratch, 'session-repro.jsonl')

const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const entry = {
  type: 'user',
  message: { role: 'user', content: 'repro: one message, two published lines' },
  uuid,
  timestamp: new Date().toISOString(),
}

const first = encodeTranscriptLine(transcriptPath, { ...entry })
check('creation publish yields a vNext record', first.record !== undefined)
const r1 = first.record!

const second = encodeTranscriptLine(
  transcriptPath,
  { ...entry },
  { settleCreationOrdinal: String(r1.creationOrdinal) },
)
check('settlement re-publication yields a vNext record', second.record !== undefined)
const r2 = second.record!

check(
  '§A REPRODUCED: recordId is REUSED across two published lines',
  r1.recordId === r2.recordId,
  `r1=${String(r1.recordId)} r2=${String(r2.recordId)}`,
)

check(
  '§B re-publication is updates-self-pointing at the creation ordinal',
  String(r2.updates) === String(r2.recordId) &&
    String(r2.creationOrdinal) === String(r1.creationOrdinal),
  `updates=${String(r2.updates)} creationOrdinal=${String(r2.creationOrdinal)}`,
)

const distinctLines = first.line !== second.line
const uniqueIds = new Set([String(r1.recordId), String(r2.recordId)]).size
check(
  '§C REPRODUCED: a unique-recordId-keyed fold collapses two lines into one key',
  distinctLines && uniqueIds === 1,
  `distinctLines=${distinctLines} uniqueIds=${uniqueIds}`,
)

console.log(
  failed === 0
    ? '\n REPRODUCED — G05 red recorded (recordId reuse on settlement re-publication)'
    : '\n NOT REPRODUCED',
)
process.exit(failed === 0 ? 0 : 1)
