#!/usr/bin/env bun
// ============================================================================
//  scripts/core-runtime/prove-attribution-spellings.ts — the persisted
//  contribution-count field's spelling contract (commitAttribution).
//
//  WHAT IT PINS. FileAttributionState's per-file character count has ONE
//  spelling: `mercuryContribution`. Every write path emits it, the restore
//  boundary reads it, and a snapshot carrying only some other product's
//  spelling contributes NOTHING — counts never flow in through a foreign
//  key, and a re-persisted snapshot never carries one.
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0' }

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Scratch everything BEFORE the module graph loads: the attribution repo
// root follows the launch directory, and config reads follow the config home.
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

// A snapshot carrying a foreign spelling beside a real count.
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
// 'aaaa' → 'aaaabbb': 3 contributed chars on top of the restored 41.
const tracked = trackFileModification(restored, 'notes.txt', 'aaaa', 'aaaabbb', false, 2)
check('tracker sums restored + new (44)', tracked.fileStates.get('notes.txt')?.mercuryContribution === 44)
const emitted = JSON.stringify(stateToSnapshotMessage(tracked, '00000000-0000-0000-0000-000000000002'))
check('snapshot emits mercuryContribution', emitted.includes('"mercuryContribution":44'))
check('snapshot never emits a foreign spelling', !emitted.includes('claudeContribution'))

section('§3 DEEP READ — the merge/read path speaks the one spelling too')
writeFileSync(join(scratch, 'notes.txt'), 'hello world') // 11 bytes on disk
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
