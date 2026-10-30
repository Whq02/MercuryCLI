import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTurnDriver, type TurnDriverPorts } from '../../src/cli/headless/turnDriver.ts'
import type { QueuedCommand } from '../../src/types/textInputTypes.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'final-close-handoff-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_BARE
try {
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
  enableConfigs()
  const state = await import('../../src/bootstrap/state.ts')
  const lineage = await import('../../src/mneme/lineageSession.ts')
  const ask = await import('../../src/mneme/handoffAsk.ts')
  const exit = await import('../../src/mneme/exitHandoff.ts')
  const { saveCacheSafeParams } = await import('../../src/utils/forkedAgent.ts')
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
  const runSource = readFileSync(new URL('../../src/cli/run.ts', import.meta.url), 'utf8')
  assert.match(runSource, /beforeCloseOutput:\s*async[\s\S]*?leaveNoteBeforeExit/, 'run wires the ask to the shared final-close port')
  console.log('FINAL CLOSE HANDOFF GREEN')
} finally {
  rmSync(home, { recursive: true, force: true })
}
