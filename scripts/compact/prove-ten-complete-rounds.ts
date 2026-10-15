import assert from 'node:assert/strict'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { computeVerbatimRecentTail } = await import('../../src/services/compact/verbatimTail.js')
const rows: import('../../src/types/message.js').Message[] = []
for (let round = 0; round < 14; round++) {
  rows.push({ type: 'assistant', uuid: `a${round}`, message: { id: `r${round}`, role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `tool${round}`, name: 'Read', input: { file_path: `source${round}.ts` } }] } } as never)
  rows.push({ type: 'user', uuid: `u${round}`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tool${round}`, content: 'x'.repeat(20397 * 4) }] } } as never)
}
const kept = computeVerbatimRecentTail(rows, { tailTokenBudget: 300000 })
assert.equal(kept?.roundsKept, 10, 'ten rounds of the measured 203976-token order fit, not six or one')
assert.equal(kept?.keep[0]?.uuid, 'a4')
assert.equal(kept?.keep.at(-1)?.uuid, 'u13')
console.log('PASS ten complete recent rounds when the rebuilt request budget permits them')

const partial = computeVerbatimRecentTail(rows, { tailTokenBudget: 96000 })
assert.equal(partial?.roundsKept, 4)
assert.equal(partial?.reason, 'request-budget')
assert.equal(partial?.keep[0]?.uuid, 'a10')
assert.throws(() => computeVerbatimRecentTail(rows, { tailTokenBudget: 1 }), /original context is kept/)
assert.throws(() => computeVerbatimRecentTail(rows.slice(0, -1), { tailTokenBudget: 300000 }), /incomplete/)
const fitted = computeVerbatimRecentTail(rows, { fits: keep => keep.length <= 6 })
assert.equal(fitted?.roundsKept, 3)
assert.equal(fitted?.roundsRequested, 10)
const { getTimeBasedMCConfig } = await import('../../src/services/compact/timeBasedMCConfig.js')
assert.equal(getTimeBasedMCConfig().keepRecent, 10)
console.log('PASS largest fitted closed suffix, explicit fit failure, unresolved round refusal and ten-result fallback protection')
