import assert from 'node:assert/strict'
import { pinSourceRef } from '../lib/settingsPopupHarness.js'

pinSourceRef()
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }
const { rollupSpineOf } = await import('../../src/components/MercuryTurnRollup.js')
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
assert.equal(spine([pending]).fileCount, 0, 'an outstanding write has not changed a file yet')
assert.equal(spine([pending]).toolCount, 1, 'the call itself still counts')
assert.equal(spine([pending, result('pending')]).fileCount, 1, 'successful result settles the changed file')
assert.equal(spine([pending, result('pending', true)]).fileCount, 0, 'failed result changes no file')
assert.equal(spine([pending, result('pending', false, { noChange: { reason: 'identical' } })]).fileCount, 0)
assert.equal(spine([pending, result('pending', false, { type: 'no-change' })]).fileCount, 0)
assert.equal(spine([pending, result('another')]).fileCount, 0, 'only a matching result settles the call')
assert.equal(spine([pending, result('pending'), call('again', '/fixture/pending.ts'), result('again')]).fileCount, 1)
console.log('PASS rollup: pending, success, failure, no-change, matching IDs, unique files')
process.exit(0)
