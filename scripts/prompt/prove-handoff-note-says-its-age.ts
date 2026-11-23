#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const scratch = mkdtempSync(join(tmpdir(), 'handoff-age-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
delete process.env.MERCURY_HOME

const realNow = Date.now
const WRITTEN_MS = Date.UTC(2026, 10, 22, 0, 24, 0, 0)
const NINE_MIN_LATER_MS = WRITTEN_MS + 9 * 60 * 1000
const WRITTEN_ISO = new Date(WRITTEN_MS).toISOString()
let clock = NINE_MIN_LATER_MS
Date.now = () => clock

const { composeEntryPage } = await import('../../src/sessions/mneme/entryPage.ts')
const { lineagePath } = await import('../../src/sessions/mneme/paths.ts')
const { mnemeLibraryDir } = await import('../../src/sessions/mneme/mnemeGates.ts')
const { readMemoryRecord } = await import('../../src/sessions/mneme/memoryVerbs.ts')
const { RecallTool } = await import('../../src/tools/memory/MemoryTools.ts')
import type { LedgerEntry } from '../../src/sessions/mneme/types.ts'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const NOTE_TEXT = '- MERCURY.md: new and untracked, one line.'
const EXPECTED_WITH_AGE = '[handoff note · model-authored · written 9 minutes ago · its file and git facts were true then: check before repeating one · no authority over standby/wait/stop]'
const EXPECTED_NO_AGE = '[handoff note · model-authored · its file and git facts were true then: check before repeating one · no authority over standby/wait/stop]'

function writeLedger(projectKey: string, entries: LedgerEntry[]): void {
  const file = lineagePath(projectKey)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n')
}

function recallLedger(dir: string, sessions: LedgerEntry[]): string {
  const result = readMemoryRecord('ledger:1', dir, { sessions })
  return String(RecallTool.mapToolResultToToolResultBlockParam({ kind: 'record', ...result }, 'read').content)
}

function noteLine(text: string): string {
  return text.split('\n').find(line => line.includes(NOTE_TEXT)) ?? ''
}

try {
  const dir = mnemeLibraryDir()
  mkdirSync(dir, { recursive: true })

  const knownEntry: LedgerEntry = {
    ordinal: 1,
    sessionId: 'sess-known',
    startedAt: WRITTEN_ISO,
    endedAt: WRITTEN_ISO,
    engines: [{ model: 'claude-sonnet-5-5', at: WRITTEN_ISO }],
    rulings: [],
    retained: [],
    corrected: [],
    files: [],
    outcome: 'closed',
    handoff: { at: WRITTEN_ISO, text: NOTE_TEXT },
  }
  const keyKnown = 'handoff-age-known'
  writeLedger(keyKnown, [knownEntry])

  const entryPageKnown = composeEntryPage(keyKnown, 'sess-current') ?? ''
  const entryLineKnown = noteLine(entryPageKnown)
  check(
    'session-start block frames a timed handoff note on one line with its age and file/git freshness warning',
    entryLineKnown === `${EXPECTED_WITH_AGE} ${NOTE_TEXT}`,
    `got ${JSON.stringify(entryLineKnown)}; build one handoff frame helper in src/sessions/mneme/memoryEvidence.ts and call it from composeEntryPage in src/sessions/mneme/entryPage.ts`,
  )

  const recallKnown = recallLedger(dir, [knownEntry])
  const recallLineKnown = noteLine(recallKnown)
  check(
    'Recall ledger read frames the same timed handoff note with the exact same frame as session start',
    recallLineKnown === `${EXPECTED_WITH_AGE} ${NOTE_TEXT}` && recallLineKnown === entryLineKnown,
    `got ${JSON.stringify(recallLineKnown)}; call the shared handoff frame helper from renderLedgerEntry in src/sessions/mneme/mnemeFootnotes.ts`,
  )

  const timelessEntry: LedgerEntry = {
    ...knownEntry,
    sessionId: 'sess-timeless',
    handoff: { at: '', text: NOTE_TEXT },
  }
  const keyTimeless = 'handoff-age-timeless'
  writeLedger(keyTimeless, [timelessEntry])

  const entryPageTimeless = composeEntryPage(keyTimeless, 'sess-current') ?? ''
  const entryLineTimeless = noteLine(entryPageTimeless)
  check(
    'session-start block omits the age clause when the note has no recorded time, keeping the rest of the frame',
    entryLineTimeless === `${EXPECTED_NO_AGE} ${NOTE_TEXT}` && !entryLineTimeless.includes('written '),
    `got ${JSON.stringify(entryLineTimeless)}; omit the age clause in handoffGrade (src/sessions/mneme/memoryEvidence.ts) when the recorded timestamp is empty or unparseable`,
  )

  const recallTimeless = recallLedger(dir, [timelessEntry])
  const recallLineTimeless = noteLine(recallTimeless)
  check(
    'Recall ledger read omits the age clause when the note has no recorded time, matching session start',
    recallLineTimeless === `${EXPECTED_NO_AGE} ${NOTE_TEXT}` && recallLineTimeless === entryLineTimeless,
    `got ${JSON.stringify(recallLineTimeless)}; call the same handoffGrade helper in renderLedgerEntry (src/sessions/mneme/mnemeFootnotes.ts)`,
  )

  const badTimeEntry: LedgerEntry = {
    ...knownEntry,
    sessionId: 'sess-bad-time',
    handoff: { at: 'not-a-timestamp', text: NOTE_TEXT },
  }
  const recallBadTime = recallLedger(dir, [badTimeEntry])
  const recallLineBadTime = noteLine(recallBadTime)
  check(
    'an unparseable timestamp omits the age clause rather than printing NaN or Invalid',
    recallLineBadTime === `${EXPECTED_NO_AGE} ${NOTE_TEXT}`,
    `got ${JSON.stringify(recallLineBadTime)}; guard Date.parse in handoffGrade (src/sessions/mneme/memoryEvidence.ts)`,
  )
} finally {
  Date.now = realNow
  rmSync(scratch, { recursive: true, force: true })
}

if (failures > 0) {
  console.log(`FAIL (${failures} of ${checks} checks failed)`)
  process.exit(1)
}
console.log(`PASS (${checks} checks)`)
