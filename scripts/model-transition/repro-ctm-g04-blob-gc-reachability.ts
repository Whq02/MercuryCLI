#!/usr/bin/env bun
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

const old = (Date.now() - 40 * 24 * 60 * 60 * 1000) / 1000
utimesSync(blobPath, old, old)

check(
  '§A fixture: fresh transcript references the aged payload',
  existsSync(blobPath) && readFileSync(transcriptPath, 'utf8').includes(blobPath),
)

const result = await cleanupOldSessionFiles()
check(
  '§B REPRODUCED: the age-only sweep deleted the still-referenced payload',
  !existsSync(blobPath),
  `swept=${result.messages} errors=${result.errors}`,
)

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
