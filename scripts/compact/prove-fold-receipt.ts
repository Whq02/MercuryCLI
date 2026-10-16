;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Message } from '../../src/types/message.ts'

const home = mkdtempSync(join(tmpdir(), 'fold-receipt-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_TMPDIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY ??= 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_COMPACT_KEEP_TAIL = '1'
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const { compactConversation } = await import('../../src/services/compact/compact.ts')
const receipts = await import('../../src/services/compact/foldReceipt.ts').catch(() => null)
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { makeOwnerKey } = await import('../../src/services/run/ownerKey.ts')
const { acceptUserRequest, noteRunEvent } = await import('../../src/services/run/runCoordinator.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { overflowRecoveryNotice, overflowRefusalText } = await import('../../src/services/compact/overflowRecovery.ts')
const { formatTokens } = await import('../../src/utils/format.ts')
const { pendingRows } = await import('../../src/mneme/mnemeBuffer.ts')
const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.ts')

let checks = 0
let failures = 0
const check = (label: string, condition: boolean, detail = ''): void => {
  checks++
  if (!condition) failures++
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${label}${condition || !detail ? '' : `: ${detail}`}`)
}

let clock = Date.UTC(2026, 9, 16)
const user = (content: unknown): Message => ({ type: 'user', uuid: randomUUID(), timestamp: new Date(clock++).toISOString(), message: { role: 'user', content } }) as Message
const assistant = (content: unknown): Message => ({ type: 'assistant', uuid: randomUUID(), timestamp: new Date(clock++).toISOString(), message: { id: randomUUID(), role: 'assistant', stop_reason: 'tool_use', content } }) as Message
function rounds(count: number): Message[] {
  const rows: Message[] = []
  for (let index = 0; index < count; index++) {
    const id = randomUUID()
    rows.push(assistant([{ type: 'tool_use', id, name: 'Read', input: { file_path: `/repo/source${index}.ts` } }]))
    rows.push(user([{ type: 'tool_result', tool_use_id: id, content: `line ${index} `.repeat(400) }]))
  }
  return rows
}
const api = await startFixtureApi(Array.from({ length: 4 }, () => ({ kind: 'text' as const, text: 'The compaction road was rebuilt on the measurement; the receipt is the committed transition.' })))
process.env.ANTHROPIC_BASE_URL = api.url
const owner = makeOwnerKey({ workspace: process.cwd(), sessionId: 'fold-receipt-proof', lane: 'main' })
const context = (overrides: Record<string, unknown> = {}) => ({
  owner,
  abortController: new AbortController(),
  readFileState: createFileStateCacheWithSizeLimit(20),
  loadedNestedMemoryPaths: new Set<string>(),
  getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext(), sessionHooks: new Map(), tasks: {}, mcp: { tools: [], clients: [], commands: [], resources: {} } }),
  options: { tools: [], mcpClients: [], commands: [], agentDefinitions: { activeAgents: [] }, engineModel: 'claude-opus-4-8', thinkingConfig: { type: 'disabled' }, isNonInteractiveSession: true },
  ...overrides,
}) as never
const fold = (messages: Message[], ctx = context()) =>
  compactConversation(messages, ctx, { systemPrompt: ['fixture'], userContext: {}, systemContext: {}, toolUseContext: ctx, forkContextMessages: [] }, true, undefined, true)

try {
  assert.ok(receipts, 'the fold receipt module exists')
  const { foldReceipt, foldReceiptWords } = receipts
  acceptUserRequest(owner, { objective: 'Paint the exact fold receipt from the committed transition.', rootMessageId: null })
  noteRunEvent(owner, { type: 'substantive', at: Date.now(), reason: 'implementation began' })
  noteRunEvent(owner, { type: 'task-transition', at: Date.now(), taskId: 'row-7', title: 'Row seven: the visible receipt', state: 'in-progress' })

  const result = await fold([user('Rebuild the compaction road on the measurement.'), user('Keep the receipt exact.'), ...rounds(14)])
  const meta = result.boundaryMarker.compactMetadata
  const receipt = foldReceipt(meta)
  check('the boundary records the post-fold estimate the result reports', meta.postTokens === result.truePostCompactTokenCount && typeof meta.postTokens === 'number', String(meta.postTokens))
  check('the receipt reads the trigger and the before/after counts from the committed boundary', receipt.trigger === 'auto' && receipt.before === meta.preTokens && receipt.after?.tokens === meta.postTokens && receipt.after.source === 'estimate')
  check('the receipt\'s kept rounds equal the committed tail', receipt.rounds !== null && meta.recentRounds !== undefined && receipt.rounds.kept === meta.recentRounds.kept && receipt.rounds.requested === meta.recentRounds.requested && receipt.rounds.reason === meta.recentRounds.reason && receipt.rounds.kept === 10, JSON.stringify(receipt.rounds))
  check('the kept tail the result carries is exactly those rounds', (result.messagesToKeep?.length ?? 0) === receipt.rounds!.kept * 2)
  check('the receipt\'s operator count equals the ledger\'s witnesses and the operator block', receipt.operator?.messages === 2 && receipt.operator.messages === meta.ledger?.operator.length && (result.operatorMessages?.attachment as { messages?: unknown[] } | undefined)?.messages?.length === 2, JSON.stringify(receipt.operator))
  check('the receipt\'s memory move equals the committed envelope', meta.memory?.state === 'committed' && receipt.memory?.state === 'committed' && receipt.memory.id === meta.memory.pointer.id && pendingRows(mnemeLibraryDir()).some(row => `pending:${row.ts}` === receipt.memory?.id), JSON.stringify(receipt.memory))
  check('a fold prunes nothing and the receipt says so', receipt.prunedBodies === 0)
  const words = foldReceiptWords(receipt)
  check('the words name kept rounds, operator messages, the memory move, nothing pruned and the before → after estimate, in that order',
    words.length === 5 && words[0] === 'last 10 rounds kept whole' && words[1] === '2 operator messages kept whole' && words[2] === `1 fact moved to memory [${receipt.memory!.id}]` && words[3] === 'nothing pruned' && words[4] === `${formatTokens(meta.preTokens)} → ${formatTokens(meta.postTokens!)} tokens (estimate)`, JSON.stringify(words))
  const landed = foldReceiptWords(foldReceipt(meta, { input: 57_900 }))
  check('once the first post-fold response lands, the after count reads the provider\'s input, not the estimate', landed[4] === `${formatTokens(meta.preTokens)} → ${formatTokens(57_900)} tokens (provider)`, landed[4])

  const partial = foldReceiptWords(foldReceipt({ ...meta, recentRounds: { requested: 10, kept: 4, tokens: 1, reason: 'request-budget' } }))
  check('a partial keep names the count and the reason', partial[0] === 'last 4 of 10 rounds kept whole (the request budget)', partial[0])
  const fewer = foldReceiptWords(foldReceipt({ ...meta, recentRounds: { requested: 10, kept: 8, tokens: 1, reason: 'available-rounds' } }))
  check('fewer rounds than requested because fewer existed reads as all there were', fewer[0] === 'last 8 of 10 rounds kept whole (all there were)', fewer[0])
  const none = foldReceiptWords(foldReceipt({ ...meta, recentRounds: { requested: 10, kept: 0, tokens: 0, reason: 'no-complete-tail' } }))
  check('no kept rounds says so with the reason', none[0] === 'no recent rounds kept whole (no complete round)', none[0])
  const off = foldReceiptWords(foldReceipt({ ...meta, memory: { ...meta.memory!, state: 'failed', reason: 'memory is off — nothing was stored' } as never }))
  check('memory off reads as nothing moved with the reason, never a claimed move', off[2] === 'nothing moved to memory (memory is off — nothing was stored)', off[2])
  const old = foldReceiptWords(foldReceipt({ trigger: 'auto', preTokens: 180_000 }))
  check('an older record without the typed fields speaks only its folded weight and claims nothing about pruning or memory', old.length === 1 && old[0] === `folded ${formatTokens(180_000)} tokens of history`, JSON.stringify(old))
  check('an older record with no count speaks nothing', foldReceiptWords(foldReceipt({ trigger: 'manual', preTokens: 0 })).length === 0)

  const prune = overflowRecoveryNotice({ source: 'estimate', family: 'unknown', shape: 'estimate', actualTokens: 1_047_974, limitTokens: 1_025_576 } as never, 'prune', { cleared: 154, tokensSaved: 740_942 })
  check('the session-2 emergency prune receipt says 154 bodies, names Mercury\'s gross estimate and asserts no summary or memory move', prune === 'context overflowed (estimated 1,047,974 tokens > 1,025,576) — pruned 154 superseded tool-result bodies (about 740,942 tokens by Mercury\'s estimate, net of placeholders; no summary written, nothing moved to memory) and retrying', prune)
  const failed = overflowRefusalText({ source: 'estimate', family: 'unknown', shape: 'estimate', actualTokens: 10, limitTokens: 5 } as never, 'fold-failed', { nonInteractive: true, detail: 'the summary call stalled' })
  check('a failed fold says the conversation is kept whole and nothing moved', failed.includes('the fold failed (the summary call stalled). The conversation is kept whole; nothing moved.'), failed)
  const notLanded = overflowRefusalText({ source: 'estimate', family: 'unknown', shape: 'estimate', actualTokens: 10, limitTokens: 5 } as never, 'fold-did-not-land', { nonInteractive: false })
  check('a fold that did not land says the conversation is kept whole', notLanded.includes('kept whole and nothing moved'), notLanded)
} finally {
  await api.close()
  rmSync(home, { recursive: true, force: true })
}
console.log(`${failures ? 'FAIL' : 'PASS'} fold receipt (${checks} checks, ${failures} failures)`)
process.exit(failures ? 1 : 0)
