import assert from 'node:assert/strict'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { computeVerbatimRecentTail } = await import('../../src/engine/compaction/verbatimTail.js')
const rows: import('../../src/engine/message-shapes/message.js').Message[] = []
for (let round = 0; round < 14; round++) {
  rows.push({ type: 'assistant', uuid: `a${round}`, message: { id: `r${round}`, role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `tool${round}`, name: 'Read', input: { file_path: `source${round}.ts` } }] } } as never)
  rows.push({ type: 'user', uuid: `u${round}`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tool${round}`, content: 'x'.repeat(20397 * 4) }] } } as never)
}
const kept = computeVerbatimRecentTail(rows, { tailTokenBudget: 300000 })
assert.equal(kept?.roundsKept, 10, 'ten rounds of the measured 203976-token order fit, not six or one; check DEFAULT_KEEP_ROUNDS and the budget loop in computeVerbatimRecentTail in src/engine/compaction/verbatimTail.ts')
assert.equal(kept?.keep[0]?.uuid, 'a4', 'the kept tail must start at the first message of the tenth round from the end; check groupMessagesByApiRound and computeVerbatimRecentTail in src/engine/compaction/verbatimTail.ts')
assert.equal(kept?.keep.at(-1)?.uuid, 'u13', 'the kept tail must end at the newest message; check computeVerbatimRecentTail in src/engine/compaction/verbatimTail.ts')
console.log('PASS ten complete recent rounds when the rebuilt request budget permits them')

const partial = computeVerbatimRecentTail(rows, { tailTokenBudget: 96000 })
assert.equal(partial?.roundsKept, 4, 'a 96000-token tailTokenBudget must keep four rounds; check the estimatedTokens > budget step in computeVerbatimRecentTail in src/engine/compaction/verbatimTail.ts')
assert.equal(partial?.reason, 'request-budget', 'dropping rounds for the token budget must report reason request-budget; check the reason expression in computeVerbatimRecentTail in src/engine/compaction/verbatimTail.ts')
assert.equal(partial?.keep[0]?.uuid, 'a10', 'the budget-trimmed tail must start at round 10 (a10); check computeVerbatimRecentTail in src/engine/compaction/verbatimTail.ts')
assert.throws(() => computeVerbatimRecentTail(rows, { tailTokenBudget: 1 }), /original context is kept/)
assert.throws(() => computeVerbatimRecentTail(rows.slice(0, -1), { tailTokenBudget: 300000 }), /incomplete/)
const fitted = computeVerbatimRecentTail(rows, { fits: keep => keep.length <= 6 })
assert.equal(fitted?.roundsKept, 3, 'the largest suffix accepted by the fits callback must be kept; check the opts.fits call in computeVerbatimRecentTail in src/engine/compaction/verbatimTail.ts')
assert.equal(fitted?.roundsRequested, 10, 'roundsRequested must report the default ten rounds; check DEFAULT_KEEP_ROUNDS in src/engine/compaction/verbatimTail.ts')
const { getTimeBasedMCConfig } = await import('../../src/engine/compaction/timeBasedPruneConfig.js')
assert.equal(getTimeBasedMCConfig().keepRecent, 10, 'the time-based microcompact must keep ten recent results; check DEFAULT_KEEP_RECENT in src/engine/compaction/timeBasedPruneConfig.ts')
console.log('PASS largest fitted closed suffix, explicit fit failure, unresolved round refusal and ten-result fallback protection')
