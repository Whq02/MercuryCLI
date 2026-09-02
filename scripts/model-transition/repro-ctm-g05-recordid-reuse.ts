#!/usr/bin/env bun
// ============================================================================
//  scripts/model-transition/repro-ctm-g05-recordid-reuse.ts —
//  expect-red driver (bind defect D5: settlement re-publication REUSES the
//  recordId — fatal for a replay kernel keyed on unique ids).
//
//  Mechanism under test: recordId is DERIVED from the legacy uuid
//  (fabric/entryCodec), and settlement re-publication
//  (encodeTranscriptLine with settleCreationOrdinal) publishes a SECOND
//  line carrying the SAME recordId with `updates` self-pointing
//  (vnext.ts: record.updates = record.recordId). Correct for the shipped
//  last-wins-per-uuid reader; WRONG for any replay kernel that assumes
//  "recordId unique per published line" — two durable lines collapse into
//  one key. The identity law must be RATIFIED (recordId = message
//  identity; line identity = (recordId, updateOrdinal) or equivalent)
//  before the materialization fold is built.
//
//    §A both published lines carry the SAME recordId (re-use is real)
//    §B the re-publication is `updates`-self-pointing at a preserved
//       creation ordinal
//    §C DEFECT observable: two distinct published lines, ONE id — a
//       unique-id-keyed fold loses a line
//
//  Exit 0 = defect REPRODUCED.
//  Exit 1 = not reproduced. Not part of the green gate (repro-*, not prove-*).
// ============================================================================
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

// One legacy-shaped user entry — the SAME message identity twice (creation,
// then settlement re-publication), exactly the vnext writer's shape.
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

// §A — the SAME recordId on both published lines.
check(
  '§A REPRODUCED: recordId is REUSED across two published lines',
  r1.recordId === r2.recordId,
  `r1=${String(r1.recordId)} r2=${String(r2.recordId)}`,
)

// §B — self-pointing updates at the preserved creation ordinal.
check(
  '§B re-publication is updates-self-pointing at the creation ordinal',
  String(r2.updates) === String(r2.recordId) &&
    String(r2.creationOrdinal) === String(r1.creationOrdinal),
  `updates=${String(r2.updates)} creationOrdinal=${String(r2.creationOrdinal)}`,
)

// §C — the replay-kernel hazard: two DISTINCT durable lines, ONE id.
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
