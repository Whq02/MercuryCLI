#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const bar = await import('../../src/components/SwitchboardTagBar.tsx')
const header = await import('../../src/components/HelmCenterHeader.tsx')
const { IDLE_LIVE } = await import('../../src/services/engine-connector/seatLive.ts')
const { stringWidth } = await import('../../src/ink/stringWidth.ts')
type SessionLiveV1 = import('../../src/services/engine-connector/seatLive.ts').SessionLiveV1
type SeatStatusV1 = import('../../src/services/engine-connector/seatLive.ts').SeatStatusV1
type WorkRowV1 = import('../../src/services/engine-connector/types.ts').WorkRowV1

const NOW = 1_800_000_000_000
const M = 60_000
const row = (over: Partial<WorkRowV1> & Pick<WorkRowV1, 'id' | 'kind' | 'status' | 'startTime'>): WorkRowV1 =>
  ({ name: over.id, ...over }) as WorkRowV1
const PHASE_WORDS = /\b(thinking|running a tool|replying|compacting)\b/

section('§1 the crew\'s clock')
{
  check('no rows ⇒ no line, nothing active', bar.crewClockOf([], NOW).line === null && bar.crewClockOf([], NOW).active === false)
  const one = [row({ id: 'a1', kind: 'agent', status: 'running', startTime: NOW - 5_000 })]
  check('one running agent: "agent thought for 5s", active', bar.crewClockOf(one, NOW).line === 'agent thought for 5s' && bar.crewClockOf(one, NOW).active, bar.crewClockOf(one, NOW).line ?? 'null')
  const two = [row({ id: 'a1', kind: 'agent', status: 'running', startTime: NOW - 28 * M }), row({ id: 'a2', kind: 'agent', status: 'running', startTime: NOW - 20 * M })]
  check('two running agents: the clock counts from the earliest start — "agents thought for 28m"', bar.crewClockOf(two, NOW).line === 'agents thought for 28m', bar.crewClockOf(two, NOW).line ?? 'null')
  const named = [row({ id: 'n1', kind: 'teammate', status: 'running', startTime: NOW - 3 * M })]
  check('a named agent is crew (the crew facts\' law)', bar.crewClockOf(named, NOW).line === 'agent thought for 3m' && bar.crewActiveIn(named))
  const pending = [row({ id: 'a1', kind: 'agent', status: 'pending', startTime: NOW - 2_000 })]
  check('a pending agent runs (the counting law)', bar.crewActiveIn(pending) && bar.crewClockOf(pending, NOW).line === 'agent thought for 2s')
  const wf = [row({ id: 'w1', kind: 'workflow', status: 'running', startTime: NOW - 12 * M })]
  check('one running workflow: "workflow thought for 12m"', bar.crewClockOf(wf, NOW).line === 'workflow thought for 12m' && bar.crewActiveIn(wf))
  const wfs = [row({ id: 'w1', kind: 'workflow', status: 'running', startTime: NOW - 12 * M }), row({ id: 'w2', kind: 'workflow', status: 'pending', startTime: NOW - 2 * M })]
  check('two workflows: the plural', bar.crewClockOf(wfs, NOW).line === 'workflows thought for 12m')
  const both = [...two, ...wf]
  check('both kinds: both sentences, the larger first', bar.crewClockOf(both, NOW).line === 'agents thought for 28m · workflow thought for 12m', bar.crewClockOf(both, NOW).line ?? 'null')
  const bothWfFirst = [...one, ...wf]
  check('both kinds, the workflow larger: the workflow first', bar.crewClockOf(bothWfFirst, NOW).line === 'workflow thought for 12m · agent thought for 5s')
  const settled = [row({ id: 'a1', kind: 'agent', status: 'completed', startTime: NOW - 60_000, endTime: NOW - 32_000 }), row({ id: 'a2', kind: 'agent', status: 'killed', startTime: NOW - 55_000, endTime: NOW - 40_000 })]
  const s = bar.crewClockOf(settled, NOW)
  check('settled agents: the receipt is the span they stood (first start → last end), past tense, not active', s.line === 'agents thought for 28s' && s.active === false, s.line ?? 'null')
  check('the settled receipt reads the rows\' own end stamps, never the clock', bar.crewClockOf(settled, NOW + 10 * M).line === 'agents thought for 28s')
  const mixed = [row({ id: 'a1', kind: 'agent', status: 'completed', startTime: NOW - 60 * M, endTime: NOW - 50 * M }), row({ id: 'a2', kind: 'agent', status: 'running', startTime: NOW - 4 * M })]
  check('a running agent beside a settled one: the running clock alone (the settled row waits for its eviction)', bar.crewClockOf(mixed, NOW).line === 'agent thought for 4m' && bar.crewActiveIn(mixed))
  const paused = [row({ id: 'w1', kind: 'workflow', status: 'paused', startTime: NOW - 9 * M })]
  check('a paused workflow runs nothing (the glyph is still) and its span stands as the receipt', bar.crewActiveIn(paused) === false && bar.crewClockOf(paused, NOW).line === 'workflow thought for 0s')
  const shells = [row({ id: 's1', kind: 'shell', status: 'running', startTime: NOW - 5 * M }), row({ id: 'm1', kind: 'monitor', status: 'running', startTime: NOW - M }), row({ id: 'd1', kind: 'dream', status: 'running', startTime: NOW - M })]
  check('shells, monitors and dreams are not crew: no line, nothing active', bar.crewClockOf(shells, NOW).line === null && bar.crewActiveIn(shells) === false)
  for (const [name, rows] of [['none', []], ['one', one], ['both', both], ['settled', settled], ['paused', paused], ['shells', shells]] as const) {
    check(`crewActiveIn agrees with the clock's own fact (${name})`, bar.crewActiveIn(rows) === bar.crewClockOf(rows, NOW).active)
  }
}

section('§2 the row\'s words per state, with and without a crew, at three widths')
{
  const live = (phase: SessionLiveV1['phase'], inFlight = true, agentsWaiting = 0): SessionLiveV1 =>
    ({ ...IDLE_LIVE, inFlight, phase, agentsWaiting, turnStartedAtMs: inFlight ? NOW - 5_000 : null }) as SessionLiveV1
  const status = (over: Partial<SeatStatusV1> = {}): SeatStatusV1 =>
    ({ title: 'a chat', projectLabel: 'proj', interrupting: false, hardStopping: false, wait: null, quietMs: null, watchdogMs: 300_000, phaseMs: 28 * M, toolBudgetMs: 600_000, stuck: false, ...over }) as SeatStatusV1
  const crew = { active: true, line: 'agents thought for 28m' }
  const receipt = { active: false, line: 'agents thought for 28m' }
  const none = { active: false, line: null }
  const mains: Array<[string, SessionLiveV1]> = [['thinking', live('thinking')], ['a tool', live('tool')], ['replying', live('responding')], ['compacting', live('compacting')]]
  for (const [name, l] of mains) {
    check(`${name}, no crew: the row paints nothing`, bar.statusLine(l, status(), none) === '' && bar.statusLine(l, status()) === '', bar.statusLine(l, status()))
    check(`${name}, a crew running: the crew's clock`, bar.statusLine(l, status(), crew) === 'agents thought for 28m')
    check(`${name}, a settled crew: the receipt`, bar.statusLine(l, status(), receipt) === 'agents thought for 28m')
    for (const c of [none, crew, receipt]) check(`${name}: no phase word on the row (crew ${c.line === null ? 'none' : c.active ? 'running' : 'settled'})`, !PHASE_WORDS.test(bar.statusLine(l, status(), c)))
  }
  check('idle, no crew: "ready"', bar.statusLine(live('idle', false), status(), none) === 'ready')
  check('idle, the crew running on (esc left them): the crew\'s clock, never "ready"', bar.statusLine(live('idle', false), status(), crew) === 'agents thought for 28m')
  check('idle, the crew settled: the receipt stands', bar.statusLine(live('idle', false), status(), receipt) === 'agents thought for 28m')
  const wait: SeatStatusV1['wait'] = { kind: 'first-byte', cold: false, promptTokens: 900, model: 'Opus 5', budgetMs: 300_000, sinceMs: NOW - 3_000, attempt: 1 }
  check('the first-byte wait outranks the crew\'s clock', bar.statusLine(live('thinking'), status({ wait }), crew) === 'waiting for the first byte from Opus 5 — within 300 s')
  check('the wait on agents outranks the crew\'s clock (the runner\'s own count words)', bar.statusLine(live('waiting', true, 2), status(), crew) === 'waiting on 2 agents')
  check('the wait on agents by kind outranks the crew\'s clock', bar.statusLine({ ...live('waiting', true, 3), waitingOn: { workflows: 1, agents: 2, teammates: 0, shells: 0, asks: 0 } }, status(), crew) === 'waiting on 1 workflow · 2 agents')
  check('the stuck verdict outranks the crew\'s clock', bar.statusLine(live('thinking'), status({ stuck: true, quietMs: 300_000 }), crew) === 'no stream events for 5m — the session may be stuck (the watchdog aborts at 5m)')
  check('the interrupt outranks the crew\'s clock', bar.statusLine(live('thinking'), status({ interrupting: true }), crew) === 'interrupting — the request is torn down')
  check('the hard stop outranks everything', bar.statusLine(live('thinking'), status({ interrupting: true, hardStopping: true }), crew) === 'stopping — the runner is cut if the turn is still open in a second')
  const fixed = 2 + stringWidth('a chat') + stringWidth(' · proj') + 3 + 2 + stringWidth('esc interrupts · ⇧← back')
  const both = 'agents thought for 28m · workflow thought for 12m'
  for (const cols of [100, 110, 120]) {
    const fitted = bar.fitStatusLine(both, cols, fixed)
    check(`${cols} columns: the crew's clock is left whole for the row's own end cut`, fitted === both, fitted)
    const waitLine = bar.statusLine(live('thinking'), status({ wait: { ...wait, cold: true, promptTokens: 26_000 } }), crew)
    const fittedWait = bar.fitStatusLine(waitLine, cols, fixed)
    check(`${cols} columns: a wait line keeps its budget clause under the cut`, fittedWait.endsWith('within 300 s') && stringWidth(fittedWait) <= Math.max(12, cols - fixed), fittedWait)
  }
}

section('§3 the title row\'s name')
{
  check('the stage-1 title reads the unnamed word', bar.seatDisplayTitle({ title: 'new session · proj · ready', projectLabel: 'proj' }) === 'new session')
  check('a stored name reads verbatim', bar.seatDisplayTitle({ title: 'fix-auth-tests', projectLabel: 'proj' }) === 'fix-auth-tests')
  check('the chat\'s first words read verbatim', bar.seatDisplayTitle({ title: 'hello plain world', projectLabel: 'proj' }) === 'hello plain world')
  check('an empty title is never blank', bar.seatDisplayTitle({ title: '', projectLabel: 'proj' }) === 'new session')
  const naming = await import('../../src/services/concourse/sessionNaming.ts')
  check('the header\'s unnamed word IS the naming owner\'s stage-1 word (one export, read by the header and the tag bar)', header.UNNAMED_SESSION === naming.UNNAMED_SESSION_WORD && header.headerSessionName('', 40) === naming.UNNAMED_SESSION_WORD && bar.seatDisplayTitle({ title: '', projectLabel: 'proj' }) === naming.UNNAMED_SESSION_WORD && naming.newSessionTitle('/tmp/proj').startsWith(`${naming.UNNAMED_SESSION_WORD} · `))
  const long = 'a session name long enough to outrun the row at every cockpit width, and then some more words so the cut is real at one hundred and twenty columns'
  for (const cols of [100, 110, 120]) {
    const budget = header.headerNameBudget(cols, false)
    const shown = header.headerSessionName(long, budget)
    check(`${cols} columns: the name is end-cut to its budget (${budget})`, stringWidth(shown) <= budget && shown.endsWith('…'), shown)
    const beside = header.headerNameBudget(cols, true)
    check(`${cols} columns: beside a mission the name keeps half the free cells (${beside})`, beside === Math.max(12, Math.floor(budget / 2)) && stringWidth(header.headerSessionName(long, beside)) <= beside)
  }
  check('a short name is never cut', header.headerSessionName('hdr: launch', header.headerNameBudget(100, false)) === 'hdr: launch')
  check('the budget clears the padding, the SESSION label and one cell of air', header.headerNameBudget(120, false) === 120 - 2 - (2 + header.SESSION_LABEL.length) - 1)
}

section('§4 structure: no timer feeds the title row; the clock is gone; the glyph reads the crew')
{
  const hch = readFileSync('src/components/HelmCenterHeader.tsx', 'utf8')
  check('the title row keeps no timer (no setInterval, no shared clock, no now tick)', !/setInterval|subscribeUiClock|useNowTick|liveClock/.test(hch))
  check('the title row reads the seat\'s name through the same owner the bottom row paints (seatDisplayTitle)', hch.includes('seatDisplayTitle(c.status())'))
  check('the title row paints the name where the clock stood, in the accent and bold', /<Text color=\{accent\} bold>\s*\{name\}\s*<\/Text>/.test(hch))
  check('the clock module is gone', !existsSync('src/utils/cockpit/liveClock.ts'))
  const registry = readFileSync('src/substrate/flagRegistry.ts', 'utf8')
  check('the clock\'s flag left the registry with its reader', !registry.includes('MERCURY_LIVE_CLOCK'))
  const tag = readFileSync('src/components/SwitchboardTagBar.tsx', 'utf8')
  check('the bottom row paints no glyph and no session name (the title row alone names the session)', !tag.includes('<WorkingGlyph') && !tag.includes('{title}') && !/seatDisplayTitle\(status\)/.test(tag))
  check('the project leads the bottom row', tag.includes('<Text color={t.textMuted}> {status.projectLabel}</Text>'))
  check('the row\'s words are statusLine over the crew\'s clock', tag.includes('statusLine(live, status, crew)'))
  check('the crew tick is armed only while a sub-agent runs', tag.includes('useNowTick(crewActive ? 1000 : null)'))
  check('the crew\'s clock reads the one work-row list and the crew facts owner', tag.includes('useFocusedWorkRows()') && tag.includes('crewAgentsOf(rows, null)') && tag.includes('focusedWorkflowRows(rows)'))
  check('the row omits the words\' separator when there are no words', tag.includes("fitted !== '' ? (") && tag.includes("(line !== '' ? 3 : 0)"))
}

console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
