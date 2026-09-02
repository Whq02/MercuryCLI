#!/usr/bin/env bun
// ============================================================================
//  scripts/model-transition/repro-ctm-g04-blob-gc-reachability.ts —
//  expect-red driver (bind defect D4: blob lifetime is AGE-ONLY —
//  a still-referenced payload deletes, leaving a dangling transcript
//  pointer; the live H32 class).
//
//  Mechanism under test: cleanupOldSessionFiles (utils/cleanup.ts) sweeps
//  <projects>/<proj>/<session>/tool-results/** purely by mtime against the
//  30-day cutoff (unlinkIfOld). No reachability check exists anywhere in
//  the sweep: a LIVE transcript (fresh mtime, survives the same sweep)
//  holding a <persisted-output> pointer to an old-but-referenced payload
//  loses the payload.
//
//    §A the fixture estate: a fresh transcript referencing an aged blob
//    §B DEFECT: the sweep deletes the referenced blob (age-only)
//    §C DEFECT: the transcript survives, still pointing at the deleted
//       payload — a dangling pointer in a live session
//
//  Exit 0 = defect REPRODUCED.
//  Exit 1 = not reproduced. Not part of the green gate (repro-*, not prove-*).
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ctm-g04-config-'))
process.env.MERCURY_HOME = mkdtempSync(join(tmpdir(), 'ctm-g04-home-'))
process.env.ANTHROPIC_API_KEY = 'fixture-key'

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

const { getProjectsDir } = await import('../../src/utils/sessionStorage.ts')
const { TOOL_RESULTS_SUBDIR, PERSISTED_OUTPUT_TAG, PERSISTED_OUTPUT_CLOSING_TAG } =
  await import('../../src/utils/toolResultStorage.ts')
const { cleanupOldSessionFiles } = await import('../../src/utils/cleanup.ts')

let failed = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failed++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

// §A — the estate: one project, one LIVE transcript (fresh mtime), one aged
// tool-result payload the transcript references.
const projectDir = join(getProjectsDir(), 'repro-proj')
const sessionDirName = 'aaaaaaaa-bbbb-cccc-dddd-000000000001'
const blobDir = join(projectDir, sessionDirName, TOOL_RESULTS_SUBDIR, 'toolu_repro01')
mkdirSync(blobDir, { recursive: true })
const blobPath = join(blobDir, 'output.txt')
writeFileSync(blobPath, 'the persisted tool output payload — still referenced')

const transcriptPath = join(projectDir, `${sessionDirName}.jsonl`)
const pointerLine = JSON.stringify({
  type: 'user',
  uuid: sessionDirName,
  timestamp: new Date().toISOString(),
  message: {
    role: 'user',
    content: `${PERSISTED_OUTPUT_TAG}${blobPath}${PERSISTED_OUTPUT_CLOSING_TAG}`,
  },
})
writeFileSync(transcriptPath, pointerLine + '\n')

// Age the BLOB 40 days; the transcript stays fresh (a live session).
const old = (Date.now() - 40 * 24 * 60 * 60 * 1000) / 1000
utimesSync(blobPath, old, old)

check(
  '§A fixture: fresh transcript references the aged payload',
  existsSync(blobPath) && readFileSync(transcriptPath, 'utf8').includes(blobPath),
)

// §B — run the REAL sweep.
const result = await cleanupOldSessionFiles()
check(
  '§B REPRODUCED: the age-only sweep deleted the still-referenced payload',
  !existsSync(blobPath),
  `swept=${result.messages} errors=${result.errors}`,
)

// §C — the dangling pointer: live transcript, dead payload.
const transcriptAlive = existsSync(transcriptPath)
const stillPoints = transcriptAlive && readFileSync(transcriptPath, 'utf8').includes(blobPath)
check(
  '§C REPRODUCED: the surviving transcript now points at a deleted payload',
  transcriptAlive && stillPoints,
)

console.log(
  failed === 0
    ? '\n REPRODUCED — G04 red recorded (reachability-blind blob GC → dangling pointer)'
    : '\n NOT REPRODUCED',
)
process.exit(failed === 0 ? 0 : 1)
