import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTurnDriver, type TurnDriverPorts } from '../../src/daemon/runner/turnDriver.ts'
import type { QueuedCommand } from '../../src/screen/composer/input-core/textInput.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'final-close-handoff-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = join(home, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_BARE
try {
  const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
  enableConfigs()
  const state = await import('../../src/boot/process-state/processState.ts')
  const lineage = await import('../../src/sessions/mneme/lineageSession.ts')
  const ask = await import('../../src/sessions/mneme/handoffAsk.ts')
  const exit = await import('../../src/sessions/mneme/exitHandoff.ts')
  const { saveCacheSafeParams } = await import('../../src/crew/agents/forkedAgent.ts')
  const params = { systemPrompt: [] as never, userContext: {}, systemContext: {}, toolUseContext: {} as never, forkContextMessages: [] }
  async function scenario(oneShot: boolean, status = 'completed'): Promise<void> {
    state.switchSession(crypto.randomUUID())
    ask._resetHandoffAskForTesting()
    lineage._resetLineageSessionForTesting()
    lineage.noteSessionEngine('fixture')
    saveCacheSafeParams(params)
    state.setRunInputClosed(oneShot)
    let asks = 0
    const run = async () => { asks++; return { messages: [] } }
    let waiting = !oneShot
    const queue = [{ mode: 'prompt', value: 'work' }] as QueuedCommand[]
    let closed!: () => void
    const done = new Promise<void>(resolve => { closed = resolve })
    const ports = {
      dequeue: () => queue.shift(), dequeueCommand: () => undefined, peek: () => queue[0],
      notifyLifecycle: () => {}, enqueueOutput: () => {}, writeDirect: async () => {}, drainRows: () => [],
      beforeCycle: async () => {}, onTurnStart: () => {}, turnIdOf: () => 'turn',
      openTurnRow: () => ({ type: 'turn', state: 'started' }), onTurnSettled: () => {},
      executeTurn: async (_command, _batch, emit) => {
        if (status === 'completed' && ask.handoffAskDue({ querySource: 'sdk' })) await ask.askForHandoff({ cacheSafeParams: params, run })
        emit({ type: 'outcome', status } as never)
      },
      hasWaitableBackgroundTasks: () => waiting, hasHoldableBackgroundAgents: () => waiting,
      settleIdle: async () => 'close', beforeCloseOutput: async () => { await exit.leaveNoteBeforeExit({ run }) },
      closeOutput: async () => closed(), isShuttingDown: () => false,
      idleTimerStop: () => {}, idleTimerStart: () => {}, onCycleError: () => ({ type: 'outcome', status: 'failed' }), shutdown: () => {},
      clock: { sleep: async () => {
        assert.equal(driver.phase(), 'waiting_for_agents')
        state.setRunInputClosed(true)
        waiting = false
      } },
    } as TurnDriverPorts
    const driver = createTurnDriver(ports)
    driver.kick()
    await done
    await driver.closeOutputOnce()
    assert.equal(asks, status === 'completed' ? 1 : 0, `${oneShot ? 'one shot' : 'EOF during waiting_for_agents'}: only a successful turn asks, exactly once`)
    if (status === 'completed') assert.equal(exit.exitNoteDue(), false, '/exit after a turn-end or close ask never asks again, even when no note was returned')
  }
  await scenario(false)
  await scenario(true)
  await scenario(false, 'failed')
  await scenario(false, 'aborted')

  const MODEL = 'claude-opus-4-8'
  const STEP_USD = 0.01
  const NOTE_USD = 0.02
  const realQueryEvents = (await import('../../src/engine/turnDoor.ts')).queryEvents
  const realQuery = { ...(await import('../../src/engine/turnDoor.ts')) }
  let scripted: Record<string, unknown> | null = null
  mock.module('../../src/engine/turnDoor.ts', () => ({
    ...realQuery,
    queryEvents: async function* (given: Record<string, unknown>): AsyncGenerator<unknown, unknown> {
      return yield* realQueryEvents((scripted === null ? given : { ...given, deps: scripted }) as never)
    },
  }))
  const tracker = await import('../../src/models/usage/sessionCost.ts')
  const { EMPTY_USAGE } = await import('../../src/engine/request-parts/emptyUsage.ts')
  const { createAssistantMessage } = await import('../../src/engine/message-shapes/factories.ts')
  const realFork = { ...(await import('../../src/crew/agents/forkedAgent.ts')) }
  let notes = 0
  mock.module('../../src/crew/agents/forkedAgent.ts', () => ({
    ...realFork,
    runForkedAgent: async () => {
      notes++
      const usage = { ...EMPTY_USAGE, input_tokens: 120, output_tokens: 12 }
      tracker.addToTotalSessionCost(NOTE_USD, usage, MODEL)
      return { messages: [createAssistantMessage({ content: `The session read the close row's totals and left them standing; note ${notes} for the next session.` })], terminal: { reason: 'completed' }, totalUsage: usage }
    },
  }))
  const { Conversation } = await import('../../src/engine/rows/turn.ts')
  const { printDriverPorts } = await import('../../src/daemon/runner/runnerDriver.ts')
  const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
  const { createFileStateCacheWithSizeLimit } = await import('../../src/platform/files/fileStateCache.ts')
  state.setIsInteractive(false)
  type Row = { type?: string; cost_usd?: number; usage?: { input_tokens?: number }; models?: Record<string, { cost_usd?: number; input_tokens?: number }> }
  const turnRows = async (): Promise<Row[]> => {
    let appState = getDefaultAppState()
    const engine = new Conversation({
      cwd: process.cwd(),
      tools: [],
      commands: [],
      mcpClients: [],
      agents: [],
      canUseTool: async (_tool: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input }),
      getAppState: () => appState,
      setAppState: (update: (prev: typeof appState) => typeof appState) => { appState = update(appState) },
      readFileState: createFileStateCacheWithSizeLimit(100),
      userSpecifiedModel: MODEL,
    } as never)
    scripted = {
      callModel: async function* (): AsyncGenerator<unknown, void> {
        tracker.addToTotalSessionCost(STEP_USD, { ...EMPTY_USAGE, input_tokens: 100, output_tokens: 10 }, MODEL)
        const reply = createAssistantMessage({ content: 'DONE' })
        reply.message.stop_reason = 'end_turn'
        yield reply
      },
      autocompact: async () => ({ wasCompacted: false }),
      microcompact: async (messages: unknown[]) => ({ messages }),
      uuid: () => crypto.randomUUID(),
    }
    const rows: Row[] = []
    try {
      for await (const row of engine.turn('work')) rows.push(row as Row)
    } finally {
      scripted = null
    }
    return rows
  }
  const openSession = (inputClosed: boolean): { usd: number; tokens: number } => {
    state.switchSession(crypto.randomUUID())
    ask._resetHandoffAskForTesting()
    lineage._resetLineageSessionForTesting()
    lineage.noteSessionEngine('fixture')
    state.setRunInputClosed(inputClosed)
    return { usd: state.getTotalCostUSD(), tokens: state.getTotalInputTokens() }
  }
  const usdOf = (rows: Row[]): number => rows.reduce((sum, row) => sum + (row.type === 'outcome' ? (row.cost_usd ?? 0) : Object.values(row.models ?? {}).reduce((each, model) => each + (model.cost_usd ?? 0), 0)), 0)
  const tokensOf = (rows: Row[]): number => rows.reduce((sum, row) => sum + (row.type === 'outcome' ? (row.usage?.input_tokens ?? 0) : Object.values(row.models ?? {}).reduce((each, model) => each + (model.input_tokens ?? 0), 0)), 0)
  const said = (rows: Row[], spent: { usd: number; tokens: number }): string =>
    `${rows.map(row => `${row.type} ${row.type === 'outcome' ? row.cost_usd : usdOf([row])}`).join(', ')}: ${usdOf(rows).toFixed(4)} USD and ${tokensOf(rows)} input tokens on the rows, ${spent.usd.toFixed(4)} USD and ${spent.tokens} on the ledger`
  const addsUp = (rows: Row[], spent: { usd: number; tokens: number }): boolean => Math.abs(usdOf(rows) - spent.usd) < 1e-9 && tokensOf(rows) === spent.tokens && usdOf(rows.filter(row => row.type === 'close')) > 0

  const insideAt = openSession(true)
  const inside = (await turnRows()).filter(row => row.type === 'outcome' || row.type === 'close')
  const insideSpent = { usd: state.getTotalCostUSD() - insideAt.usd, tokens: state.getTotalInputTokens() - insideAt.tokens }

  const afterAt = openSession(false)
  const after = (await turnRows()).filter(row => row.type === 'outcome' || row.type === 'close')
  state.setRunInputClosed(true)
  saveCacheSafeParams(params)
  const closing = { io: { outbound: { enqueue: (row: Row) => { after.push(row) } } }, isConcourseWorker: false, liveScope: () => ({ session_id: String(state.getSessionId()), turn: 1 }) }
  await printDriverPorts(closing as never).beforeCloseOutput?.()
  const afterSpent = { usd: state.getTotalCostUSD() - afterAt.usd, tokens: state.getTotalInputTokens() - afterAt.tokens }

  assert.deepEqual([inside.map(row => row.type), after.map(row => row.type)], [['close', 'outcome'], ['outcome', 'close']], 'the note is written inside the turn the input closed in, before its outcome, and after the last outcome when the input closes after a turn')
  assert.ok(
    addsUp(inside, insideSpent) && addsUp(after, afterSpent),
    `in both orders the cost and the input tokens of the outcomes and of the close row's models add up to what the ledger grew by, and the close row carries the note's cost — the input closed inside a turn: ${said(inside, insideSpent)} · the input closed after a turn: ${said(after, afterSpent)}`,
  )
  assert.ok(Math.abs((inside.find(row => row.type === 'outcome')?.cost_usd ?? 0) - STEP_USD) < 1e-9, `the outcome of the turn the input closed in counts the turn's own call alone (${said(inside, insideSpent)})`)
  console.log('FINAL CLOSE HANDOFF GREEN')
} finally {
  rmSync(home, { recursive: true, force: true })
}
