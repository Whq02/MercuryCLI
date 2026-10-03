;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { createTurnDriver } from '../../src/cli/headless/turnDriver.ts'
import { outcomeRow, turnStartedRow } from '../../src/rows/project.ts'
import { EMPTY_USAGE } from '../../src/services/api/emptyUsage.ts'

const source = readFileSync(join(import.meta.dir, '../../src/cli/print.ts'), 'utf8')
const ast = ts.createSourceFile('print.ts', source, ts.ScriptTarget.Latest, true)
let callback: ts.Expression | undefined
function visit(node: ts.Node): void {
  if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'onCycleError') callback = node.initializer
  ts.forEachChild(node, visit)
}
visit(ast)
if (callback === undefined) throw new Error('the print turn driver has no error callback')
const state = { currentTurn: null as number | null, turnsRun: 0, turnId: '' }
const build = new Bun.Transpiler({ loader: 'ts' }).transformSync(`const callback = (${callback.getText(ast)});`)
const onCycleError = new Function('state', 'outcomeRow', 'EMPTY_USAGE', 'getSessionId', 'errorMessage', 'getInMemoryErrors', `return (error, turnId) => { const { currentTurn, turnsRun } = state; ${build} return callback(error, turnId) }`)(state, outcomeRow, EMPTY_USAGE, () => 'ordinal-session', (error: Error) => error.message, () => [])
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
process.exit(pass ? 0 : 1)
