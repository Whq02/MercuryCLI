import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const scratch = mkdtempSync(join(tmpdir(), 'open-cite-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_DESKTOP_DRIVER = 'none'
delete process.env.MERCURY_HOME
assert(existsSync(join(import.meta.dir, '../../src/mneme/mnemeSignal.ts')), 'a completed Recall turn must have an open-and-cite log')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const { setIsInteractive } = await import('../../src/bootstrap/state.js')
setIsInteractive(false)
const { retainItems, readMemoryRecord } = await import('../../src/mneme/memoryVerbs.js')
const { maybeConsolidate } = await import('../../src/mneme/mnemeConsolidate.js')
const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.js')
const { RecallTool } = await import('../../src/tools/MemoryTools/MemoryTools.js')
const { pointerCitations } = await import('../../src/mneme/memoryCitations.js')
const { SIGNAL_TURN_LIMIT, finishMemorySignal, memorySignalScope, noteMemoryOffered, noteMemoryOpened, readSignalLog, signalCounts, signalLogPath } = await import('../../src/mneme/mnemeSignal.js')
const { runEventCore } = await import('../../src/run-core/turn-machine.js')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
const { createAssistantMessage, createUserMessage } = await import('../../src/utils/messages.js')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.js')

try {
  const dir = mnemeLibraryDir()
  retainItems(['amber', 'cobalt', 'quartz'].map(word => ({ content: `release signal ${word}`, topic: 'release' })), { session: 'fixture' })
  assert.equal(maybeConsolidate({ dir, force: true }).consolidated, true)
  const finalAnswer = 'Release is ready [seq 1]. Unopened seq:3 is not evidence. invented seq:999.'
  const calls = [{ query: 'release signal' }, { read: 'seq:1' }, { read: 'seq:2' }, { read: 'seq:999' }]
  let n = 0
  let state = getDefaultAppState()
  const context = {
    abortController: new AbortController(),
    options: { commands: [], tools: [RecallTool], engineModel: 'claude-opus-4-8', thinkingConfig: { type: 'enabled', budgetTokens: 1024 }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, debug: false, verbose: false, agentDefinitions: { activeAgents: [], allAgents: [] } },
    getAppState: () => state,
    setAppState: (f: (prior: typeof state) => typeof state) => { state = f(state) },
    messages: [], readFileState: createFileStateCacheWithSizeLimit(100), setInProgressToolUseIDs() {}, setResponseLength() {}, updateFileHistoryState() {}, updateAttributionState() {},
  }
  const machine = runEventCore({
    messages: [createUserMessage({ content: 'check the release signal' })], systemPrompt: ['fixture'], userContext: {}, systemContext: {}, querySource: 'sdk', toolUseContext: context,
    canUseTool: async (_tool: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input }),
    deps: {
      async *callModel() {
        const input = calls[n++]
        const message = createAssistantMessage({ content: input ? [{ type: 'tool_use', id: `read-${n}`, name: 'Recall', input }] as never : finalAnswer })
        message.message.stop_reason = input ? 'tool_use' : 'end_turn'
        yield message
      },
      autocompact: async () => ({ wasCompacted: false }), microcompact: async (messages: unknown[]) => ({ messages }), uuid: () => crypto.randomUUID(),
    },
  } as never, [])
  for await (const _event of machine) {}
  const turns = readSignalLog(dir)
  assert.equal(turns.length, 1, 'the real turn machine flushes once')
  assert.deepEqual(new Set(turns[0]!.queries.flatMap(q => q.offered)), new Set(['seq:1', 'seq:2', 'seq:3']))
  assert.deepEqual(turns[0]!.opened, ['seq:1', 'seq:2'])
  assert.deepEqual(turns[0]!.cited, ['seq:1'])
  const offeredFeatures = turns[0]!.queries[0]!.features
  assert.equal(Object.keys(offeredFeatures).length, 3, 'actual Recall offerings carry scored features')
  assert(Object.values(offeredFeatures).every(features => features.bm25 > 0 && features.kind === 'fact'))
  const { readUsage } = await import('../../src/mneme/mnemeUsage.js')
  const usage = readUsage(dir)
  assert.equal(usage['1']?.count, 1, 'a query does not increment the open count')
  assert.equal(usage['2']?.count, 1)
  assert.equal(usage['3']?.count ?? 0, 0, 'an offered but unopened fact has no uses')
  assert.deepEqual(signalCounts(turns), {
    'seq:1': { offered: 1, opened: 1, cited: 1 }, 'seq:2': { offered: 1, opened: 1, cited: 0 }, 'seq:3': { offered: 1, opened: 0, cited: 0 },
  })
  const bytes = readFileSync(signalLogPath(dir), 'utf8')
  for (const text of ['release signal', finalAnswer, 'amber', 'cobalt', 'fixture']) assert(!bytes.includes(text), `log must not hold ${text}`)
  assert.deepEqual([...pointerCitations('ruling seq:12; [seq 13] ledger:4 doc:release pending:2026-01-01T00:00:00.000Z')], ['seq:13', 'seq:12', 'ledger:4', 'doc:release', 'pending:2026-01-01T00:00:00.000Z'])
  assert.equal(pointerCitations('seq:12abc').size, 0)

  async function drain(body: () => Promise<void>): Promise<void> {
    for await (const _ of memorySignalScope((async function* () { await body() })())) {}
  }
  const isolated = join(scratch, 'isolated')
  await Promise.all([1, 2, 3, 4].map(id => drain(async () => {
    noteMemoryOffered(`query ${id}`, [{ id: `seq:${id}` }], isolated)
    await Promise.resolve()
    noteMemoryOpened([`seq:${id}`], isolated)
    await finishMemorySignal(`seq:${id}`)
  })))
  assert.equal(readSignalLog(isolated).length, 4, 'concurrent turns append without a lost row')
  assert(readSignalLog(isolated).every(t => t.opened.length === 1 && t.opened[0] === t.cited[0]), 'concurrent turns do not borrow opens')
  await drain(async () => { noteMemoryOpened(['seq:50'], isolated) })
  assert.equal(readSignalLog(isolated).length, 4, 'interruption is not a negative example')
  const bounded = join(scratch, 'bounded')
  await drain(async () => {
    noteMemoryOffered('seed', [{ id: 'seq:1' }], bounded)
    await finishMemorySignal('')
  })
  const seed = readSignalLog(bounded)[0]!
  writeFileSync(signalLogPath(bounded), JSON.stringify({ version: 1, turns: Array.from({ length: SIGNAL_TURN_LIMIT }, () => seed) }))
  await drain(async () => { noteMemoryOpened(['seq:2'], bounded); await finishMemorySignal('seq:2') })
  assert.equal(readSignalLog(bounded).length, SIGNAL_TURN_LIMIT)
  assert.deepEqual(readSignalLog(bounded).at(-1)?.cited, ['seq:2'])
  await drain(async () => {
    readMemoryRecord('doc:release', dir)
    await finishMemorySignal('doc:release and seq:3')
  })
  assert.deepEqual(new Set(readSignalLog(dir).at(-1)!.opened), new Set(['seq:1', 'seq:2', 'seq:3', 'doc:release']))
  assert.deepEqual(new Set(readSignalLog(dir).at(-1)!.cited), new Set(['seq:3', 'doc:release']))
  console.log('PASS open-and-cite: real Recall turn, final citations, counts, privacy, concurrency, interruption, full-page reads, 512-turn bound')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
process.exit(0)
