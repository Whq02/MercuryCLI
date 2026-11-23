import assert from 'node:assert/strict'
import { pinSourceRef } from '../lib/settingsPopupHarness.js'

pinSourceRef()
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }
const { rollupSpineOf } = await import('../../src/screen/chat/MercuryTurnRollup.js')
const call = (id: string, path: string) => ({
  type: 'assistant', uuid: `call-${id}`,
  message: { content: [{ type: 'tool_use', id, name: 'Edit', input: { file_path: path } }] },
})
const result = (id: string, isError = false, toolUseResult: unknown = {}) => ({
  type: 'user', uuid: `result-${id}`, toolUseResult,
  message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'fixture result' }] },
})
const spine = (messages: unknown[]) => rollupSpineOf(messages as never)
const pending = call('pending', '/fixture/pending.ts')
assert.equal(spine([pending]).fileCount, 0, 'an outstanding write has not changed a file yet; rollupSpineOf in src/screen/chat/MercuryTurnRollup.tsx must count a file only once its result arrives')
assert.equal(spine([pending]).toolCount, 1, 'the call itself still counts; rollupSpineOf in src/screen/chat/MercuryTurnRollup.tsx must count every tool_use in toolCount')
assert.equal(spine([pending, result('pending')]).fileCount, 1, 'successful result settles the changed file; rollupSpineOf in src/screen/chat/MercuryTurnRollup.tsx must count the file when a matching non-error result arrives')
assert.equal(spine([pending, result('pending', true)]).fileCount, 0, 'failed result changes no file; rollupSpineOf in src/screen/chat/MercuryTurnRollup.tsx must skip a result with is_error')
assert.equal(spine([pending, result('pending', false, { noChange: { reason: 'identical' } })]).fileCount, 0, 'a result whose toolUseResult has noChange changes no file; rollupSpineOf in src/screen/chat/MercuryTurnRollup.tsx must skip it')
assert.equal(spine([pending, result('pending', false, { type: 'no-change' })]).fileCount, 0, 'a result whose toolUseResult type is no-change changes no file; rollupSpineOf in src/screen/chat/MercuryTurnRollup.tsx must skip it')
assert.equal(spine([pending, result('another')]).fileCount, 0, 'only a matching result settles the call; rollupSpineOf in src/screen/chat/MercuryTurnRollup.tsx must match tool_use_id to the call id')
assert.equal(spine([pending, result('pending'), call('again', '/fixture/pending.ts'), result('again')]).fileCount, 1, 'two settled edits of one path count as one file; rollupSpineOf in src/screen/chat/MercuryTurnRollup.tsx must count unique paths')
console.log('PASS rollup: pending, success, failure, no-change, matching IDs, unique files')
process.exit(0)
