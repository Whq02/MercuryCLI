#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)

let failures = 0
let checks = 0
let where = 'crewClockOf, crewActiveIn, statusLine and fitStatusLine in src/screen/chat/SwitchboardTagBar.tsx'
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}${ok ? '' : ` — to change: ${where}`}`)
}
const section = (t: string): void => {
  if (t.startsWith('§3')) where = 'UNNAMED_SESSION_WORD and newSessionTitle in src/screen/concourse-model/sessionNaming.ts'
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const bar = await import('../../src/screen/chat/SwitchboardTagBar.tsx')
const { IDLE_LIVE } = await import('../../src/engine/connector/seatLive.ts')
const { stringWidth } = await import('../../src/screen/renderer/stringWidth.ts')
type SessionLiveV1 = import('../../src/engine/connector/seatLive.ts').SessionLiveV1
type SeatStatusV1 = import('../../src/engine/connector/seatLive.ts').SeatStatusV1
type WorkRowV1 = import('../../src/engine/connector/types.ts').WorkRowV1

const NOW = 1_800_000_000_000
const M = 60_000
const row = (over: Partial<WorkRowV1> & Pick<WorkRowV1, 'id' | 'kind' | 'status' | 'startTime'>): WorkRowV1 =>
  ({ name: over.id, ...over }) as WorkRowV1
const PHASE_WORDS = /\b(thinking|running a tool|replying|compacting)\b/

section('§1 the crew\'s clock')
{
  check('no rows ⇒ no line, nothing active', bar.crewClockOf([], NOW).line === null && bar.crewClockOf([], NOW).active === false)
  const one = [row({ id: 'a1', kind: 'agent', status: 'running', startTime: NOW - 5_000 })]
  check('one running agent: "crewmate thought for 5s", active', bar.crewClockOf(one, NOW).line === 'crewmate thought for 5s' && bar.crewClockOf(one, NOW).active, bar.crewClockOf(one, NOW).line ?? 'null')
  const two = [row({ id: 'a1', kind: 'agent', status: 'running', startTime: NOW - 28 * M }), row({ id: 'a2', kind: 'agent', status: 'running', startTime: NOW - 20 * M })]
  check('two running agents: the clock counts from the earliest start — "crewmates thought for 28m"', bar.crewClockOf(two, NOW).line === 'crewmates thought for 28m', bar.crewClockOf(two, NOW).line ?? 'null')
  const pending = [row({ id: 'a1', kind: 'agent', status: 'pending', startTime: NOW - 2_000 })]
  check('a pending agent runs (the counting law)', bar.crewActiveIn(pending) && bar.crewClockOf(pending, NOW).line === 'crewmate thought for 2s')
  const settled = [row({ id: 'a1', kind: 'agent', status: 'completed', startTime: NOW - 60_000, endTime: NOW - 32_000 }), row({ id: 'a2', kind: 'agent', status: 'killed', startTime: NOW - 55_000, endTime: NOW - 40_000 })]
  const s = bar.crewClockOf(settled, NOW)
  check('settled agents: no line and nothing active — the row rests on ready once the crew lands', s.line === null && s.active === false, s.line ?? 'null')
  check('a settled crew never ticks or stands as a receipt, however long ago it landed', bar.crewClockOf(settled, NOW + 10 * M).line === null)
  const mixed = [row({ id: 'a1', kind: 'agent', status: 'completed', startTime: NOW - 60 * M, endTime: NOW - 50 * M }), row({ id: 'a2', kind: 'agent', status: 'running', startTime: NOW - 4 * M })]
  check('a running agent beside a settled one: the running clock alone (the settled row waits for its eviction)', bar.crewClockOf(mixed, NOW).line === 'crewmate thought for 4m' && bar.crewActiveIn(mixed))
  const shells = [row({ id: 's1', kind: 'shell', status: 'running', startTime: NOW - 5 * M }), row({ id: 'm1', kind: 'monitor', status: 'running', startTime: NOW - M })]
  check('shells and monitors are not crew: no line, nothing active', bar.crewClockOf(shells, NOW).line === null && bar.crewActiveIn(shells) === false)
  for (const [name, rows] of [['none', []], ['one', one], ['two', two], ['settled', settled], ['shells', shells]] as const) {
    check(`crewActiveIn agrees with the clock's own fact (${name})`, bar.crewActiveIn(rows) === bar.crewClockOf(rows, NOW).active)
  }
}

section('§2 the row\'s words per state, with and without a crew, at three widths')
{
  const live = (phase: SessionLiveV1['phase'], inFlight = true, agentsWaiting = 0): SessionLiveV1 =>
    ({ ...IDLE_LIVE, inFlight, phase, agentsWaiting, turnStartedAtMs: inFlight ? NOW - 5_000 : null }) as SessionLiveV1
  const status = (over: Partial<SeatStatusV1> = {}): SeatStatusV1 =>
    ({ title: 'a chat', projectLabel: 'proj', interrupting: false, hardStopping: false, wait: null, quietMs: null, watchdogMs: 120_000, phaseMs: 28 * M, toolBudgetMs: 600_000, stuck: false, ...over }) as SeatStatusV1
  const crew = { active: true, line: 'crewmates thought for 28m' }
  const receipt = bar.crewClockOf([row({ id: 'a1', kind: 'agent', status: 'completed', startTime: NOW - 60_000, endTime: NOW - 32_000 })], NOW)
  const none = { active: false, line: null }
  const mains: Array<[string, SessionLiveV1]> = [['thinking', live('thinking')], ['a tool', live('tool')], ['replying', live('responding')], ['compacting', live('compacting')]]
  for (const [name, l] of mains) {
    check(`${name}, no crew: the row paints nothing`, bar.statusLine(l, status(), none) === '' && bar.statusLine(l, status()) === '', bar.statusLine(l, status()))
    check(`${name}, a crew running: the crew's clock`, bar.statusLine(l, status(), crew) === 'crewmates thought for 28m')
    check(`${name}, a settled crew: the row paints nothing (no receipt stands)`, bar.statusLine(l, status(), receipt) === '')
    for (const c of [none, crew, receipt]) check(`${name}: no phase word on the row (crew ${c.line === null ? 'none' : c.active ? 'running' : 'settled'})`, !PHASE_WORDS.test(bar.statusLine(l, status(), c)))
  }
  check('idle, no crew: "ready"', bar.statusLine(live('idle', false), status(), none) === 'ready')
  check('idle, the crew running on (esc left them): the crew\'s clock, never "ready"', bar.statusLine(live('idle', false), status(), crew) === 'crewmates thought for 28m')
  check('idle, the crew settled: "ready" (the landed rows keep their time in the crew panel)', bar.statusLine(live('idle', false), status(), receipt) === 'ready')
  const wait: SeatStatusV1['wait'] = { kind: 'first-byte', cold: false, promptTokens: 900, model: 'Opus 5', budgetMs: 120_000, sinceMs: NOW - 3_000, attempt: 1 }
  check('the first-byte wait outranks the crew\'s clock, and speaks its limit in minutes', bar.statusLine(live('thinking'), status({ wait }), crew) === 'waiting for the first byte from Opus 5 — gives up after 2m', bar.statusLine(live('thinking'), status({ wait }), crew))
  check('the wait on agents outranks the crew\'s clock (the runner\'s own count words)', bar.statusLine(live('waiting', true, 2), status(), crew) === 'waiting on 2 crewmates')
  check('the wait on agents by kind outranks the crew\'s clock', bar.statusLine({ ...live('waiting', true, 3), waitingOn: { agents: 2, shells: 1, asks: 0 } }, status(), crew) === 'waiting on 2 crewmates · 1 shell')
  check('the stuck verdict outranks the crew\'s clock', bar.statusLine(live('thinking'), status({ stuck: true, quietMs: 120_000 }), crew) === 'no stream events for 2m — the session may be stuck (the watchdog aborts at 2m)', bar.statusLine(live('thinking'), status({ stuck: true, quietMs: 120_000 }), crew))
  check('the interrupt outranks the crew\'s clock', bar.statusLine(live('thinking'), status({ interrupting: true }), crew) === 'interrupting — the request is torn down')
  check('the second press outranks everything', bar.statusLine(live('thinking'), status({ interrupting: true, hardStopping: true }), crew) === 'interrupting again — the request is torn down once more; x on its row stops the runner')
  const fixed = 2 + stringWidth('a chat') + stringWidth(' · proj') + 3 + 2 + stringWidth('esc interrupts · ⇧← back')
  const clock = 'crewmates thought for 28m'
  for (const cols of [100, 110, 120]) {
    const fitted = bar.fitStatusLine(clock, cols, fixed)
    check(`${cols} columns: the crew's clock is left whole for the row's own end cut`, fitted === clock, fitted)
    const waitLine = bar.statusLine(live('thinking'), status({ wait: { ...wait, cold: true, promptTokens: 26_000 } }), crew)
    const fittedWait = bar.fitStatusLine(waitLine, cols, fixed)
    check(`${cols} columns: a wait line keeps its limit clause without cutting words`, fittedWait.endsWith('gives up after 2m') && !fittedWait.includes('…') && stringWidth(fittedWait) <= Math.max(12, cols - fixed), fittedWait)
  }
}

section('§3 the title row is gone: the pane opens on the berth card')
{
  const naming = await import('../../src/screen/concourse-model/sessionNaming.ts')
  check('the unnamed word has one owner, the naming owner', naming.UNNAMED_SESSION_WORD === 'new session' && naming.newSessionTitle('/tmp/proj').startsWith(`${naming.UNNAMED_SESSION_WORD} · `))
}


console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
