import { strict as assert } from 'node:assert'
import { STORAGE_ROWS, storageRowPolicy } from '../../src/rows/storage.js'
import { isChainParticipant, isEphemeralToolProgress, isTranscriptMessage } from '../../src/utils/sessionStorage/paths.js'
import { applyTranscriptEntry, emptyFoldState } from '../../src/utils/sessionStorage/fold.js'

const messages = ['user', 'assistant', 'system', 'attachment']
const metadata = ['summary', 'custom-title', 'ai-title', 'last-prompt', 'task-summary', 'tag', 'agent-name', 'agent-color', 'agent-setting', 'pr-link', 'mode', 'advisor-switch', 'model', 'worktree-state', 'file-history-snapshot', 'attribution-snapshot', 'speculation-accept', 'context-collapse-commit', 'context-collapse-snapshot', 'queue-operation']
assert.deepEqual(Object.keys(STORAGE_ROWS).sort(), [...messages, ...metadata, 'progress', 'content-replacement'].sort())
for (const type of messages) {
  assert.equal(storageRowPolicy(type)?.write, 'message')
  assert.equal(isTranscriptMessage({ type } as never), true)
  assert.equal(isChainParticipant({ type } as never), true)
}
for (const type of metadata) {
  assert.equal(storageRowPolicy(type)?.write, 'append')
  assert.equal(isTranscriptMessage({ type } as never), false)
}
assert.equal(storageRowPolicy('content-replacement')?.write, 'scoped')
assert.equal(storageRowPolicy('progress')?.fold, 'bridge')
assert.equal(isChainParticipant({ type: 'progress' }), false)
for (const type of ['bash_progress', 'powershell_progress', 'mcp_progress']) assert.equal(isEphemeralToolProgress(type), true)
assert.equal(isEphemeralToolProgress('hook_progress'), false)
assert.equal(storageRowPolicy('constructor'), undefined)
assert.equal(storageRowPolicy('unrecognized-row'), undefined)

const sessionId = '00000000-0000-4000-8000-000000000001'
const fold = emptyFoldState()
const rows = [
  { type: 'custom-title', sessionId, customTitle: 'original' },
  { type: 'custom-title', sessionId, customTitle: '' },
  { type: 'tag', sessionId, tag: '' },
  { type: 'advisor-switch', sessionId, on: false },
  { type: 'worktree-state', sessionId, worktreeSession: { originalCwd: '/proof', worktreePath: '/proof/worktree', worktreeName: 'proof', sessionId } },
  { type: 'pr-link', sessionId, prNumber: 17, prUrl: 'https://example.invalid/pull/17', prRepository: 'proof/project', timestamp: '2026-01-01T00:00:00.000Z' },
]
for (const row of rows) applyTranscriptEntry(fold, row as never)
assert.equal(fold.customTitles.get(sessionId), '')
assert.equal(fold.tags.get(sessionId), '')
assert.equal(fold.advisorSwitches.get(sessionId), false)
assert.equal(fold.worktreeStates.get(sessionId)?.worktreeName, 'proof')
assert.equal(fold.prNumbers.get(sessionId), 17)
assert.equal(fold.prUrls.get(sessionId), 'https://example.invalid/pull/17')
assert.equal(fold.prRepositories.get(sessionId), 'proof/project')
applyTranscriptEntry(fold, { type: 'worktree-state', sessionId, worktreeSession: null })
assert.equal(fold.worktreeStates.get(sessionId), null)
console.log('PASS storage rows: every persisted kind, read/write membership, unknown kinds, clears, and synthetic worktree/PR metadata')
