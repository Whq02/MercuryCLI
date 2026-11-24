;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { runnerDriverPorts } from '../../src/daemon/runner/runnerDriver.ts'
import { createRunnerState } from '../../src/daemon/runner/runnerPorts.ts'
import { createTurnDriver } from '../../src/daemon/runner/turnDriver.ts'
import { outcomeRow, turnStartedRow } from '../../src/engine/rows/project.ts'
import { EMPTY_USAGE } from '../../src/engine/request-parts/emptyUsage.ts'

const live = createRunnerState()
const state = {
  get currentTurn(): number | null {
    return live.currentTurn
  },
  set currentTurn(value: number | null) {
    live.currentTurn = value
  },
  get turnsRun(): number {
    return live.turnsRun
  },
  set turnsRun(value: number) {
    live.turnsRun = value
  },
  turnId: '',
}
const onCycleError = runnerDriverPorts({ live } as never).onCycleError
const queue = ['first', 'second', 'third'].map((value, index) => ({ value, mode: 'bash', uuid: `prompt-${index + 1}` }))
const rows: Array<Record<string, any>> = []
const shutdowns: number[] = []
let settle!: () => void
const settled = new Promise<void>(resolve => { settle = resolve })
const driver = createTurnDriver({
  dequeue: () => queue.shift(),
  dequeueCommand: command => { const at = queue.indexOf(command as never); return at < 0 ? undefined : queue.splice(at, 1)[0] },
  peek: () => queue[0],
  enqueueOutput: row => rows.push(row as never),
  writeDirect: async row => { rows.push(row as never) },
  notifyLifecycle: () => {},
  drainRows: () => [],
  beforeCycle: async () => {},
  onTurnStart: () => { state.turnId = `turn-${state.turnsRun + 1}` },
  turnIdOf: () => state.turnId,
  openTurnRow: messageIds => turnStartedRow({ session_id: 'ordinal-session', turn: state.turnsRun }, { turnId: state.turnId, model: 'fixture', messageIds: messageIds as string[] }),
  executeTurn: async (_command, _batch, emit) => {
    state.turnsRun++
    state.currentTurn = state.turnsRun
    try {
      emit(turnStartedRow({ session_id: 'ordinal-session', turn: state.currentTurn }, { turnId: state.turnId, model: 'fixture', messageIds: [] }))
      if (state.turnsRun === 2) throw new Error('second turn failed at the turn driver seam')
      emit(outcomeRow({ session_id: 'ordinal-session', turn: state.currentTurn }, { turnId: state.turnId, status: 'completed', steps: 0, wallMs: 0, usage: EMPTY_USAGE, models: {}, denials: [], answer: 'done' }))
    } finally {
      state.currentTurn = null
    }
  },
  onTurnSettled: () => {},
  hasWaitableBackgroundTasks: () => false,
  hasHoldableBackgroundAgents: () => false,
  settleIdle: async () => { settle(); return 'stay' },
  closeOutput: async () => {},
  notifySessionState: () => {},
  isShuttingDown: () => false,
  idleTimerStop: () => {},
  idleTimerStart: () => {},
  onCycleError,
  shutdown: code => { shutdowns.push(code); settle() },
  clock: { sleep: async () => {} },
} as never)
driver.kick()
await settled
const outcomes = rows.filter(row => row.type === 'outcome')
const opened = rows.filter(row => row.type === 'turn')
const pass = outcomes.length === 3 && outcomes.every((row, index) => row.turn === index + 1 && row.turn_id === opened[index]?.turn_id) && outcomes[1]?.status === 'failed' && outcomes[1]?.error.message.includes('second turn') && outcomes[2]?.status === 'completed' && shutdowns.length === 0
console.log(`[${pass ? 'PASS' : 'FAIL'}] the real print error callback keeps the second failed turn ordinal and identity through driver recovery`)
console.log(JSON.stringify({ opened, outcomes, shutdowns }))
if (!pass) console.log('expected three outcome rows numbered 1 to 3, each with the turn_id of its opening turn row, the second failed with its error message and no shutdown; change onCycleError in src/daemon/runner/runnerDriver.ts, or the recovery that calls it in src/daemon/runner/turnDriver.ts')
process.exit(pass ? 0 : 1)
