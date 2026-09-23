#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'esc-receipt-once-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)

const crew = await import('../../src/services/engine-connector/crewFacts.ts')
const focusedSlot = await import('../../src/services/engine-connector/focusedConnector.ts')
const { interruptFocusedTurn } = await import('../../src/hooks/useCancelRequest.ts')

console.log('============================================================')
console.log(' esc paints its receipt once per turn: the second and every later esc paint nothing new')
console.log(" red on the base: R1's second press painted the same row again (two identical rows one under the other); R3's chooser does not exist")
console.log('============================================================')

type Row = { message?: { content?: unknown }; content?: unknown }
const textOfRow = (row: Row): string => {
  const content = row.message?.content ?? row.content
  return typeof content === 'string' ? content : Array.isArray(content) ? (content as Array<{ text?: string }>).map(b => b.text ?? '').join('') : j(content)
}

function fixtureConnector(agents: number) {
  const rows: Row[] = []
  const state = { interrupting: false, hardStopping: false, inFlight: true }
  const roster = () => ({
    reported: true,
    rows: Array.from({ length: agents }, (_, i) => ({ id: `agent-${i}`, kind: 'agent', description: `helper ${i}`, status: 'running' })),
  })
  const connector = {
    workRoster: roster,
    interrupt: (): boolean => {
      if (!state.inFlight) return false
      if (state.interrupting && state.hardStopping) return true
      if (state.interrupting) state.hardStopping = true
      else state.interrupting = true
      return true
    },
    status: () => ({ interrupting: state.interrupting, hardStopping: state.hardStopping, wait: null, quietMs: null, watchdogMs: null, phaseMs: null, toolBudgetMs: null, stuck: false, title: 't', projectLabel: 'p' }),
    live: () => ({ inFlight: state.inFlight, phase: 'tool', agentsWaiting: 0, inProgressToolUseIDs: new Set<string>(), turnStartedAtMs: 1 }),
    subscribeLive: () => () => {},
    tail: () => null,
    addDisplayRow: (row: Row): void => {
      rows.push(row)
    },
    newTurn: (): void => {
      state.interrupting = false
      state.hardStopping = false
      state.inFlight = true
    },
  }
  return { connector, rows, state }
}

section('R1 three esc presses in one turn: the first paints the still-running receipt, the second and the third paint nothing — never the same row twice')
{
  const fx = fixtureConnector(3)
  focusedSlot.setFocusedSessionConnector(fx.connector as never)
  const first = interruptFocusedTurn()
  const second = interruptFocusedTurn()
  const third = interruptFocusedTurn()
  const texts = fx.rows.map(textOfRow)
  check('every press reports a running turn (the connector took each)', first && second && third)
  check('the first press paints the still-running receipt, in its words', texts[0] === '3 sub-agents still running — open the crew view (/teammates) and press x twice on its row to stop one', j(texts))
  check('the second press paints nothing new (no second row, no cut words anywhere)', texts.length === 1 && !texts.some(t => /cut|hard stop/.test(t)), j(texts))
  check('a third press paints nothing either: one row for the whole turn', texts.length === 1, j(texts))
}

section('R2 a new turn starts the receipts over; a changed count paints the new count')
{
  const fx = fixtureConnector(3)
  focusedSlot.setFocusedSessionConnector(fx.connector as never)
  interruptFocusedTurn()
  fx.connector.newTurn()
  const fewer = fixtureConnector(2)
  fewer.rows.length = 0
  focusedSlot.setFocusedSessionConnector(fewer.connector as never)
  interruptFocusedTurn()
  const texts = [...fx.rows, ...fewer.rows].map(textOfRow)
  check('two turns, two counts, two rows', texts.length === 2 && texts[0]!.startsWith('3 sub-agents') && texts[1]!.startsWith('2 sub-agents'), j(texts))
}

section('R3 the words, pure')
{
  check('no cut receipt exists: the crew owner spells no hard-stop line', !('crewHardStopLine' in crew))
  check('the receipt chooser: first press ⇒ still-running line, a press over a turn already interrupting ⇒ nothing, no seat facts ⇒ still-running line', crew.interruptReceiptLine(2, null) === crew.crewStillRunningLine(2) && crew.interruptReceiptLine(2, { interrupting: false }) === crew.crewStillRunningLine(2) && crew.interruptReceiptLine(2, { interrupting: true }) === null)
  check('the still-running words are byte-identical', crew.crewStillRunningLine(3) === '3 sub-agents still running — open the crew view (/teammates) and press x twice on its row to stop one')
}

section('R4 no crew running: no receipt on either press (byte-identical to today)')
{
  const fx = fixtureConnector(0)
  focusedSlot.setFocusedSessionConnector(fx.connector as never)
  interruptFocusedTurn()
  interruptFocusedTurn()
  check('nothing painted', fx.rows.length === 0, j(fx.rows.map(textOfRow)))
}

focusedSlot._resetFocusedSessionConnectorForTesting()
rmSync(HOME, { recursive: true, force: true })
console.log('\n' + '═'.repeat(60))
if (failures === 0) console.log('✅ ALL ESC-RECEIPT-ONCE PROOFS PASS')
else console.log(`❌ ${failures} ESC-RECEIPT-ONCE PROOF(S) FAILED`)
console.log('═'.repeat(60))
process.exit(failures === 0 ? 0 : 1)
