import assert from 'node:assert/strict'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { setSystemPromptSectionCacheEntry, getSystemPromptSectionCache } = await import('../../src/bootstrap/state.js')
const { runPostCompactCleanup } = await import('../../src/services/compact/postCompactCleanup.js')
const messages = [{ type: 'attachment', attachment: { type: 'bound_prefix', boundKey: 'fixture|summary|claude-fixture', rosterEnabled: true, roster: [], sections: [{ name: 'cache-epoch-fixture', key: 'stable-key', value: 'stable prefix bytes' }], systemContext: {} } }] as never
setSystemPromptSectionCacheEntry('cache-epoch-fixture', 'stable prefix bytes', 'stable-key')
;(runPostCompactCleanup as (...args: unknown[]) => void)('sdk', messages)
assert.equal(getSystemPromptSectionCache().get('cache-epoch-fixture')?.value, 'stable prefix bytes', 'a fold restores the byte-identical stable prefix after clearing transient caches')
console.log('PASS stable cached sections survive the fold epoch')

const { carryFoldPrefix, foldCacheUsage } = await import('../../src/services/compact/cacheEpoch.js')
const { conversationRosterKey } = await import('../../src/services/providers/toolEconomy.js')
const { judgeAndRecordPrefix, resetPrefixLedger } = await import('../../src/services/providers/anthropic/prefixLedger.js')
const owner = 'cache-epoch-proof'
const model = 'claude-fixture'
const user = (uuid: string, content: string) => ({ type: 'user', uuid, message: { role: 'user', content } }) as never
const source = [user('first', 'original history')]
const key = conversationRosterKey(owner, source, model)
source.push({ type: 'attachment', uuid: 'prefix', attachment: { ...messages[0].attachment, boundKey: key } } as never)
const landing = [user('summary', 'folded history')]
const saved = JSON.stringify(source)
const carried = carryFoldPrefix(source, landing, owner, model, { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 900, cache_creation_input_tokens: 30, cache_creation: { ephemeral_1h_input_tokens: 30, ephemeral_5m_input_tokens: 0 } } as never)
assert.equal(carried.receipt.state, 'preserved')
assert.equal(carried.receipt.beforeHash, carried.receipt.afterHash)
assert.equal(carried.receipt.beforeHash?.length, 64)
assert.notEqual(carried.receipt.beforeKey, carried.receipt.afterKey)
assert.equal(carried.receipt.messagePrefixPreserved, false)
assert.equal(carried.receipt.summary?.read, 900)
assert.equal(carried.receipt.summary?.input, 940)
assert.equal(JSON.stringify(source), saved)
assert.equal(carryFoldPrefix([], landing, owner, model).receipt.state, 'unavailable')
const changed = JSON.parse(saved)
changed[1].attachment.sections = [{ name: 'static-composition', key: null, value: 'different client contract' }]
assert.equal(carryFoldPrefix(changed, landing, owner, model).receipt.state, 'unavailable')
resetPrefixLedger()
const system = [{ type: 'text', text: 'fixed system', cache_control: { type: 'ephemeral', ttl: '1h' } }]
const tools = [{ name: 'Read', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral', ttl: '1h' } }]
judgeAndRecordPrefix(owner, 'before', { system, tools, messages: [{ role: 'user', content: 'old history' }] })
const verdict = judgeAndRecordPrefix(owner, 'after', { system, tools, messages: [{ role: 'user', content: 'new summary' }] })
assert.equal(verdict.compared, false)
assert.equal(verdict.fixedPrefix?.unchanged, true)
assert.equal(verdict.fixedPrefix?.previous, verdict.fixedPrefix?.current)
assert.ok(verdict.fixedPrefix!.bytes > 0)
const rewritten = judgeAndRecordPrefix(owner, 'next', { system: [{ type: 'text', text: 'changed system' }], tools, messages: [] })
assert.equal(rewritten.fixedPrefix?.unchanged, false)
assert.equal(foldCacheUsage({ input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 50 } as never)?.write1h, null)
console.log('PASS unchanged stable-prefix SHA-256, distinct message epoch, explicit unavailable state, summary/landing usage separation and one-hour marker equality')
