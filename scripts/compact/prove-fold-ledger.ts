import assert from 'node:assert/strict'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { selectOperatorMessages } = await import('../../src/services/compact/operatorMessages.js')
const text = 'Keep this operator obligation verbatim.\r\n目標 😀 '.repeat(3000)
const messages = [{ type: 'user', uuid: 'operator-1', message: { role: 'user', content: text } }] as never
const selected = selectOperatorMessages(messages)
assert.equal(selected?.messages[0]?.text, text, 'every operator byte survives, even beyond the former 20000-token block')
assert.equal(selected?.omitted, 0)
console.log('PASS complete operator byte equality')

const { buildFoldLedger, renderFoldLedger, foldContentWitness } = await import('../../src/services/compact/foldLedger.js')
const { makeOwnerKey } = await import('../../src/services/run/ownerKey.js')
const { createCompactBoundaryMessage } = await import('../../src/utils/messages/systemMessages.js')
const { fitPostCompactUnderThreshold } = await import('../../src/services/compact/compact.js')
const owner = makeOwnerKey({ workspace: process.cwd(), sessionId: 'ledger-proof', lane: 'main' })
const source = [
  ...messages,
  { type: 'assistant', uuid: 'calls', message: { role: 'assistant', content: [
    { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'source.ts', offset: 2, limit: 3 } },
    { type: 'tool_use', id: 'shell', name: 'Bash', input: { command: 'bun test' } },
    { type: 'tool_use', id: 'unknown', name: 'Bash', input: { command: 'bun check' } },
  ] } },
  { type: 'user', uuid: 'read-result', message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: '2#abcd actual read' }] }, toolUseResult: { file: { filePath: 'source.ts', anchor: 'ra:0123456789ab:L2+3', startLine: 2, numLines: 3 } } },
  { type: 'user', uuid: 'shell-result', message: { content: [{ type: 'tool_result', tool_use_id: 'shell', content: 'one failure', is_error: true }] }, toolUseResult: { code: 1 } },
] as never
const ledger = buildFoldLedger(source, owner, 1)
assert.equal(ledger.sourceRecordIds.length, 4)
assert.equal(ledger.operator[0]?.sha256, foldContentWitness(text))
assert.equal(ledger.operator[0]?.bytes, Buffer.byteLength(text))
assert.equal(ledger.tools.find(t => t.id === 'shell')?.rc, 1)
assert.equal(ledger.tools.find(t => t.id === 'unknown')?.rc, null)
assert.equal(ledger.tools.find(t => t.id === 'unknown')?.outcome, 'pending')
assert.equal(ledger.files[0]?.anchor, 'ra:0123456789ab:L2+3')
assert.equal(ledger.files[0]?.freshness, 'observed-not-rechecked')
assert.equal(JSON.parse(renderFoldLedger(ledger).split('\n\n')[1]!).tools.length, 3)
const boundary = createCompactBoundaryMessage('manual', 100)
boundary.compactMetadata.ledger = ledger
const repeated = buildFoldLedger([boundary], owner, 2)
assert.deepEqual(repeated.operator, ledger.operator)
assert.deepEqual(repeated.tools, ledger.tools)
assert.deepEqual(repeated.files, ledger.files)
const operatorAttachment = { type: 'attachment', attachment: selected } as never
const fit = fitPostCompactUnderThreshold({ boundaryMarker: boundary, summaryMessages: [], attachments: [], hookResults: [], operatorMessages: operatorAttachment, preCompactTokenCount: 100, postCompactTokenCount: 0 }, 10)
assert.equal(fit.result.operatorMessages, operatorAttachment)
assert.ok(fit.estimate >= 10)
assert.throws(() => selectOperatorMessages(messages, { tokenBudget: 1 }), /original context is kept/)
console.log('PASS source-ID coverage, operator witnesses, actual rc/unknown outcomes, observed file anchors, repeated folds and unsheddable operator block')
