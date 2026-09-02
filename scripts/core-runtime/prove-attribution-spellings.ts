#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0' }

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'attribution-spellings-'))
process.chdir(scratch)
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'attribution-spellings-home-'))

const {
  calculateCommitAttribution,
  createEmptyAttributionState,
  restoreAttributionStateFromSnapshots,
  stateToSnapshotMessage,
  trackFileModification,
} = await import('../../src/utils/commitAttribution.ts')
import type { AttributionSnapshotMessage } from '../../src/types/logs.ts'

let failures = 0
function check(label: string, cond: boolean): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const mixedSnapshot = {
  type: 'attribution-snapshot',
  messageId: '00000000-0000-0000-0000-000000000001',
  surface: 'cli',
  fileStates: {
    'notes.txt': { contentHash: 'aaaa', mercuryContribution: 41, mtime: 1 },
    'other.txt': { contentHash: 'cccc', claudeContribution: 9, mtime: 1 },
  },
  promptCount: 1,
  promptCountAtLastCommit: 0,
  permissionPromptCount: 0,
  permissionPromptCountAtLastCommit: 0,
  escapeCount: 0,
  escapeCountAtLastCommit: 0,
} as unknown as AttributionSnapshotMessage

section('§1 RESTORE — the one spelling reads; a foreign key contributes nothing')
const restored = restoreAttributionStateFromSnapshots([mixedSnapshot])
const entry = restored.fileStates.get('notes.txt')
check('the current spelling survives restore (41 chars)', entry?.mercuryContribution === 41)
check('a foreign-spelled count contributes NOTHING (0)', restored.fileStates.get('other.txt')?.mercuryContribution === 0)
check('no rehydrated entry carries a foreign key', ![...restored.fileStates.values()].some(e => 'claudeContribution' in e))

section('§2 WRITE — trackers sum onto restored counts; snapshots emit ONLY the one key')
const tracked = trackFileModification(restored, 'notes.txt', 'aaaa', 'aaaabbb', false, 2)
check('tracker sums restored + new (44)', tracked.fileStates.get('notes.txt')?.mercuryContribution === 44)
const emitted = JSON.stringify(stateToSnapshotMessage(tracked, '00000000-0000-0000-0000-000000000002'))
check('snapshot emits mercuryContribution', emitted.includes('"mercuryContribution":44'))
check('snapshot never emits a foreign spelling', !emitted.includes('claudeContribution'))

section('§3 DEEP READ — the merge/read path speaks the one spelling too')
writeFileSync(join(scratch, 'notes.txt'), 'hello world')
const rawState = {
  ...createEmptyAttributionState(),
  surface: 'cli',
  fileStates: { 'notes.txt': { contentHash: 'bbbb', mercuryContribution: 7, mtime: 1 } },
} as unknown as Parameters<typeof calculateCommitAttribution>[0][number]
const data = await calculateCommitAttribution([rawState], ['notes.txt'])
check('merge/read path reads the one spelling (7 mercury chars)', data.files['notes.txt']?.mercuryChars === 7)

console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ attribution spelling contract: all checks pass')
