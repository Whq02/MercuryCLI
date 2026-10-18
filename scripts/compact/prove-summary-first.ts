import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'summary-first-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_TMPDIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY ??= 'proof-key-ci-gate-not-a-real-key'

const { decideOverflowRecovery } = await import('../../src/services/compact/overflowRecovery.js')
const decision = decideOverflowRecovery({ episode: { pruned: false, folded: false }, gapTokens: 22398, pruneSavingTokens: 740942, fold: { available: true } })
assert.deepEqual(decision, { kind: 'recover', rung: 'fold' }, 'the measured 154-body incident offers every body to the summary before pruning')
console.log('PASS measured overflow chooses summary before 154-body prune')

const { buildRequestContextPlan } = await import('../../src/services/run/requestContextPlan.js')
const { makeOwnerKey } = await import('../../src/services/run/ownerKey.js')
const { createContentReplacementState } = await import('../../src/utils/toolResultStorage.js')
const { roughTokenCountEstimationForMessages } = await import('../../src/services/tokenEstimation.js')
const { prepareFoldContext } = await import('../../src/services/compact/foldTransaction.js')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.js')
const { APIUserAbortError } = await import('../../src/services/api/sdkErrors.js')
const messages: import('../../src/types/message.js').Message[] = []
for (let index = 0; index < 154; index++) {
  const tokens = Math.floor(740942 / 154) + (index < 740942 % 154 ? 1 : 0)
  messages.push({ type: 'user', uuid: `result-${index}`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `call-${index}`, content: 'x'.repeat(tokens * 4) }] } } as never)
}
const before = JSON.stringify(messages)
const state = createContentReplacementState()
let prunes = 0
const plan = await buildRequestContextPlan({
  messages, owner: makeOwnerKey({ workspace: process.cwd(), sessionId: 'summary-first', lane: 'main' }), querySource: 'main_thread',
  contentReplacementState: state, skipToolNames: new Set(), preserveBodies: true, pressurePrune: true,
  microcompact: async rows => { prunes++; return { messages: rows } },
}, 'apply')
assert.equal(JSON.stringify(plan.messages), before)
assert.equal(roughTokenCountEstimationForMessages(plan.messages), 740942)
assert.equal(plan.messages.length, 154)
assert.equal(prunes, 0)
assert.equal(state.replacements.size, 0)
assert.equal(state.seenIds.size, 0)
assert.equal(JSON.stringify(messages), before)
assert.equal(plan.reductions.toolResultBudgetReplacements, 0)
const readFileState = createFileStateCacheWithSizeLimit(20)
readFileState.set('source.ts', { content: 'original', timestamp: 1 } as never)
const abortController = new AbortController()
const context = { readFileState, abortController, loadedNestedMemoryPaths: new Set(['original']) } as never
const transaction = prepareFoldContext(context)
transaction.context.readFileState.clear()
transaction.context.loadedNestedMemoryPaths.clear()
assert.equal(readFileState.size, 1)
abortController.abort()
assert.throws(() => transaction.commit(), APIUserAbortError)
assert.equal(readFileState.get('source.ts')?.content, 'original')
assert.deepEqual([...context.loadedNestedMemoryPaths], ['original'])
assert.equal(decideOverflowRecovery({ episode: { pruned: false, folded: true }, gapTokens: 22398, pruneSavingTokens: 740942, fold: { available: false, why: 'fold-failed' } }).kind, 'refuse')
assert.deepEqual(decideOverflowRecovery({ episode: { pruned: false, folded: true }, gapTokens: 22398, pruneSavingTokens: 740942, pruneAllowed: true, fold: { available: false, why: 'fold-failed' } }), { kind: 'recover', rung: 'prune' })
console.log('PASS all 154 bodies / 740942 rough tokens exposed; no prune or replacement before summary; cancelled transaction keeps read state; emergency prune requires explicit evidence')

const { startFixtureApi } = await import('../lib/fixtureApi.js')
const { compactConversation } = await import('../../src/services/compact/compact.js')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.js')
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.js')
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const api = await startFixtureApi([{ kind: 'text', text: 'The source was read and the requested change is still open. Keep the operator wording and verify the change before reporting it complete.' }])
process.env.ANTHROPIC_BASE_URL = api.url
const cancel = new AbortController()
const reads = createFileStateCacheWithSizeLimit(20)
reads.set('unwritten-fixture.ts', { content: 'original', timestamp: 1 } as never)
const nested = new Set(['original'])
const ctx = {
  abortController: cancel, readFileState: reads, loadedNestedMemoryPaths: nested,
  getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext(), sessionHooks: new Map(), tasks: {}, mcp: { tools: [], clients: [], commands: [], resources: {} } }),
  options: { tools: [], mcpClients: [], commands: [], agentDefinitions: { activeAgents: [] }, engineModel: 'claude-opus-4-8', thinkingConfig: { type: 'disabled' }, isNonInteractiveSession: true },
  onCompactProgress: (event: { type: string; stage?: string }) => { if (event.type === 'stage' && event.stage === 'restoring') cancel.abort() },
} as never
try {
  await assert.rejects(compactConversation([createUserMessage({ content: 'Keep these source bytes.' }), createAssistantMessage({ content: 'Source observed.' })], ctx, { systemPrompt: ['fixture'], userContext: {}, systemContext: {}, toolUseContext: ctx, forkContextMessages: [] }, true), APIUserAbortError)
  assert.equal(reads.get('unwritten-fixture.ts')?.content, 'original')
  assert.deepEqual([...nested], ['original'])
  assert.ok(api.messageRequests().length > 0)
  console.log('PASS cancellation after the real summary keeps the original context state')
} finally {
  await api.close()
}
