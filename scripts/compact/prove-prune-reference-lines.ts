#!/usr/bin/env bun
import assert from 'node:assert/strict'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { projectTimeBasedPrune } = await import('../../src/engine/compaction/pruneToolResults.ts')
const { digestClearedToolResult } = await import('../../src/engine/compaction/pruneDigest.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/engine/messages/messages.ts')
const { getTimeBasedPruneConfig } = await import('../../src/engine/compaction/timeBasedPruneConfig.ts')

for (const text of [
  'body\n'.repeat(10000),
  'Full output saved to: /synthetic/first.txt\n' + 'body\n'.repeat(10000),
  'body\n'.repeat(10000) + 'Full output saved to: /synthetic/last.txt',
  'body\n'.repeat(10000) + 'prefix Full output saved to: /synthetic/unicode-é.txt\r\nlast',
  'body\n'.repeat(10000) + 'Full output saved to: /synthetic/one.txt\nFull output saved to: /synthetic/two.txt\n',
]) {
  for (const content of [text, [{ type: 'text' as const, text }]]) {
    const messages = []
    for (let i = 0; i <= getTimeBasedPruneConfig().keepRecent; i++) {
      const id = `reference-${i}`
      messages.push(createAssistantMessage({ content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'synthetic' } }] as never }))
      messages.push(createUserMessage({ content: [{ type: 'tool_result', tool_use_id: id, content: i === 0 ? content : 'recent\n'.repeat(20000) }] as never }))
    }
    const result = projectTimeBasedPrune(messages, 'sdk', { pressure: true })
    assert.ok(result, 'projectTimeBasedMicrocompact returned null under pressure; check time-based microcompact projection')
    assert.deepEqual(result.clearedIds, ['reference-0'])
    const row = result.messages[1]!
    assert.equal(row.type, 'user')
    const block = (row as { message: { content: Array<{ content: string }> } }).message.content[0]!
    const firstReference = text.split('\n').find(line => line.includes('Full output saved to: '))
    assert.equal(block.content, digestClearedToolResult(content) + (firstReference === undefined ? '' : `\n${firstReference}`))
  }
}
console.log('PASS prune references: first matching line stays byte-identical for strings and text blocks')
