import { strict as assert } from 'node:assert'
import { STORAGE_ROWS, storageRowPolicy } from '../../src/engine/rows/storage.js'
import { isChainParticipant, isEphemeralToolProgress, isTranscriptMessage } from '../../src/sessions/transcripts/paths.js'
import { applyTranscriptEntry, emptyFoldState } from '../../src/sessions/transcripts/fold.js'

const messages = ['user', 'assistant', 'system', 'attachment']
const metadata = ['summary', 'custom-title', 'ai-title', 'last-prompt', 'task-summary', 'tag', 'agent-name', 'agent-color', 'agent-setting', 'session-brief', 'session-brief-add', 'pr-link', 'mode', 'advisor-switch', 'swarm-switch', 'model', 'worktree-state', 'file-history-snapshot', 'attribution-snapshot', 'speculation-accept', 'context-collapse-commit', 'context-collapse-snapshot', 'queue-operation', 'turn-start', 'turn-end']
assert.deepEqual(Object.keys(STORAGE_ROWS).sort(), [...messages, ...metadata, 'progress', 'content-replacement'].sort(), 'the persisted row kinds in STORAGE_ROWS (src/engine/rows/storage.ts) differ from the list in this proof; add or remove the kind in STORAGE_ROWS, or update the list here if the change is intended')
for (const type of messages) {
  assert.equal(storageRowPolicy(type)?.write, 'message', 'message kind ' + type + ' must have write: message in STORAGE_ROWS (src/engine/rows/storage.ts)')
  assert.equal(isTranscriptMessage({ type } as never), true, 'isTranscriptMessage (src/sessions/transcripts/paths.ts) must accept message kind ' + type)
  assert.equal(isChainParticipant({ type } as never), true, 'isChainParticipant (src/sessions/transcripts/paths.ts) must accept message kind ' + type)
}
for (const type of metadata) {
  assert.equal(storageRowPolicy(type)?.write, 'append', 'metadata kind ' + type + ' must have write: append in STORAGE_ROWS (src/engine/rows/storage.ts)')
  assert.equal(isTranscriptMessage({ type } as never), false, 'isTranscriptMessage (src/sessions/transcripts/paths.ts) must reject metadata kind ' + type)
}
assert.equal(storageRowPolicy('content-replacement')?.write, 'scoped', 'content-replacement must have write: scoped in STORAGE_ROWS (src/engine/rows/storage.ts)')
assert.equal(storageRowPolicy('progress')?.fold, 'bridge', 'progress must have fold: bridge in STORAGE_ROWS (src/engine/rows/storage.ts)')
assert.equal(isChainParticipant({ type: 'progress' }), false, 'isChainParticipant (src/sessions/transcripts/paths.ts) must reject progress rows')
for (const type of ['bash_progress', 'powershell_progress', 'mcp_progress']) assert.equal(isEphemeralToolProgress(type), true, 'isEphemeralToolProgress (src/sessions/transcripts/paths.ts) must accept ' + type)
assert.equal(isEphemeralToolProgress('hook_progress'), false, 'isEphemeralToolProgress (src/sessions/transcripts/paths.ts) must reject hook_progress')
assert.equal(storageRowPolicy('constructor'), undefined, 'storageRowPolicy (src/engine/rows/storage.ts) must not resolve inherited object keys such as constructor')
assert.equal(storageRowPolicy('unrecognized-row'), undefined, 'storageRowPolicy (src/engine/rows/storage.ts) must return undefined for a kind not in STORAGE_ROWS')

const sessionId = '00000000-0000-4000-8000-000000000001'
const fold = emptyFoldState()
const rows = [
  { type: 'custom-title', sessionId, customTitle: 'original' },
  { type: 'custom-title', sessionId, customTitle: '' },
  { type: 'tag', sessionId, tag: '' },
  { type: 'advisor-switch', sessionId, on: false },
  { type: 'swarm-switch', sessionId, on: true },
  { type: 'worktree-state', sessionId, worktreeSession: { originalCwd: '/proof', worktreePath: '/proof/worktree', worktreeName: 'proof', sessionId } },
  { type: 'pr-link', sessionId, prNumber: 17, prUrl: 'https://example.invalid/pull/17', prRepository: 'proof/project', timestamp: '2026-01-01T00:00:00.000Z' },
]
for (const row of rows) applyTranscriptEntry(fold, row as never)
assert.equal(fold.customTitles.get(sessionId), '', 'applyTranscriptEntry (src/sessions/transcripts/fold.ts) must let an empty custom-title row clear the title')
assert.equal(fold.tags.get(sessionId), '', 'applyTranscriptEntry (src/sessions/transcripts/fold.ts) must let an empty tag row clear the tag')
assert.equal(fold.advisorSwitches.get(sessionId), false, 'applyTranscriptEntry (src/sessions/transcripts/fold.ts) must record an advisor-switch row with on: false')
assert.equal(fold.swarmSwitches.get(sessionId), true, 'applyTranscriptEntry (src/sessions/transcripts/fold.ts) must record a swarm-switch row with on: true')
applyTranscriptEntry(fold, { type: 'swarm-switch', sessionId, on: false })
assert.equal(fold.swarmSwitches.get(sessionId), false, 'applyTranscriptEntry (src/sessions/transcripts/fold.ts) must let a later swarm-switch row with on: false replace the earlier one')
assert.equal(fold.worktreeStates.get(sessionId)?.worktreeName, 'proof', 'applyTranscriptEntry (src/sessions/transcripts/fold.ts) must keep the worktree-state row worktreeName')
assert.equal(fold.prNumbers.get(sessionId), 17, 'applyTranscriptEntry (src/sessions/transcripts/fold.ts) must keep the pr-link row prNumber')
assert.equal(fold.prUrls.get(sessionId), 'https://example.invalid/pull/17', 'applyTranscriptEntry (src/sessions/transcripts/fold.ts) must keep the pr-link row prUrl')
assert.equal(fold.prRepositories.get(sessionId), 'proof/project', 'applyTranscriptEntry (src/sessions/transcripts/fold.ts) must keep the pr-link row prRepository')
applyTranscriptEntry(fold, { type: 'worktree-state', sessionId, worktreeSession: null })
assert.equal(fold.worktreeStates.get(sessionId), null, 'applyTranscriptEntry (src/sessions/transcripts/fold.ts) must store null when a worktree-state row has worktreeSession: null')
console.log('PASS storage rows: every persisted kind, read/write membership, unknown kinds, clears, and synthetic worktree/PR metadata')
