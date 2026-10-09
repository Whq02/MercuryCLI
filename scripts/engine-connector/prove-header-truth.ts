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
  const shells = [row({ id: 's1', kind: 'shell', status: 'running', startTime: NOW - 5 * M }), row({ id: 'm1', kind: 'monitor', status: 'running', startTime: NOW - M })]
  check('shells and monitors are not crew: no line, nothing active', bar.crewClockOf(shells, NOW).line === null && bar.crewActiveIn(shells) === false)
  for (const [name, rows] of [['none', []], ['one', one], ['both', both], ['settled', settled], ['paused', paused], ['shells', shells]] as const) {
    check(`crewActiveIn agrees with the clock's own fact (${name})`, bar.crewActiveIn(rows) === bar.crewClockOf(rows, NOW).active)
  }
}

section('§2 the row\'s words per state, with and without a crew, at three widths')
{
  const live = (phase: SessionLiveV1['phase'], inFlight = true, agentsWaiting = 0): SessionLiveV1 =>
    ({ ...IDLE_LIVE, inFlight, phase, agentsWaiting, turnStartedAtMs: inFlight ? NOW - 5_000 : null }) as SessionLiveV1
  const status = (over: Partial<SeatStatusV1> = {}): SeatStatusV1 =>
    ({ title: 'a chat', projectLabel: 'proj', interrupting: false, hardStopping: false, wait: null, quietMs: null, watchdogMs: 120_000, phaseMs: 28 * M, toolBudgetMs: 600_000, stuck: false, ...over }) as SeatStatusV1
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
  const wait: SeatStatusV1['wait'] = { kind: 'first-byte', cold: false, promptTokens: 900, model: 'Opus 5', budgetMs: 120_000, sinceMs: NOW - 3_000, attempt: 1 }
  check('the first-byte wait outranks the crew\'s clock, and speaks its budget in minutes', bar.statusLine(live('thinking'), status({ wait }), crew) === 'waiting for the first byte from Opus 5 — within 2m', bar.statusLine(live('thinking'), status({ wait }), crew))
  check('the wait on agents outranks the crew\'s clock (the runner\'s own count words)', bar.statusLine(live('waiting', true, 2), status(), crew) === 'waiting on 2 agents')
  check('the wait on agents by kind outranks the crew\'s clock', bar.statusLine({ ...live('waiting', true, 3), waitingOn: { workflows: 1, agents: 2, shells: 0, asks: 0 } }, status(), crew) === 'waiting on 1 workflow · 2 agents')
  check('the stuck verdict outranks the crew\'s clock', bar.statusLine(live('thinking'), status({ stuck: true, quietMs: 120_000 }), crew) === 'no stream events for 2m — the session may be stuck (the watchdog aborts at 2m)', bar.statusLine(live('thinking'), status({ stuck: true, quietMs: 120_000 }), crew))
  check('the interrupt outranks the crew\'s clock', bar.statusLine(live('thinking'), status({ interrupting: true }), crew) === 'interrupting — the request is torn down')
  check('the second press outranks everything', bar.statusLine(live('thinking'), status({ interrupting: true, hardStopping: true }), crew) === 'interrupting again — the request is torn down once more; x on its row stops the runner')
  const fixed = 2 + stringWidth('a chat') + stringWidth(' · proj') + 3 + 2 + stringWidth('esc interrupts · ⇧← back')
  const both = 'agents thought for 28m · workflow thought for 12m'
  for (const cols of [100, 110, 120]) {
    const fitted = bar.fitStatusLine(both, cols, fixed)
    check(`${cols} columns: the crew's clock is left whole for the row's own end cut`, fitted === both, fitted)
    const waitLine = bar.statusLine(live('thinking'), status({ wait: { ...wait, cold: true, promptTokens: 26_000 } }), crew)
    const fittedWait = bar.fitStatusLine(waitLine, cols, fixed)
    check(`${cols} columns: a wait line keeps its budget clause under the cut`, fittedWait.endsWith('within 2m') && stringWidth(fittedWait) <= Math.max(12, cols - fixed), fittedWait)
  }
}

section('§3 the title row is gone: the pane opens on the berth card')
{
  check('the header module is gone from the tree', !existsSync('src/components/HelmCenterHeader.tsx'))
  const fsl = readFileSync('src/components/FullscreenLayout.tsx', 'utf8')
  check('the layout mounts no header: the centre pane\'s first interior row is the berth card, then the transcript', !fsl.includes('HelmCenterHeader') && /borderColor=\{centerFrame \? t\.borderStrong : undefined\}\s*>\s*(?:\{\s*(?:\/\*[^]*?\*\/)?\s*\}\s*)?<TerminalSizeContext\.Provider value=\{sizeVal\}>\s*\{isCompact \? <CompactIdentityBand \/> : null\}\s*\{centerFrame && statusBand \? \(/.test(fsl))
  check('the bar keeps no title reader for a row that no longer paints', !('seatDisplayTitle' in bar) && !readFileSync('src/components/SwitchboardTagBar.tsx', 'utf8').includes('seatDisplayTitle'))
  const naming = await import('../../src/services/concourse/sessionNaming.ts')
  check('the unnamed word has one owner, the naming owner', naming.UNNAMED_SESSION_WORD === 'new session' && naming.newSessionTitle('/tmp/proj').startsWith(`${naming.UNNAMED_SESSION_WORD} · `))
}

section('§4 structure: the clock is gone; the glyph reads the crew')
{
  check('the clock module is gone', !existsSync('src/utils/cockpit/liveClock.ts'))
  const registry = readFileSync('src/substrate/flagRegistry.ts', 'utf8')
  check('the clock\'s flag left the registry with its reader', !registry.includes('MERCURY_LIVE_CLOCK'))
  const tag = readFileSync('src/components/SwitchboardTagBar.tsx', 'utf8')
  check('the bottom row paints no glyph and no session name (the title row alone names the session)', !tag.includes('<WorkingGlyph') && !tag.includes('{title}') && !/seatDisplayTitle\(status\)/.test(tag))
  check('the model and its effort lead the bottom row in every state; the state words follow them; the project never leads', !tag.includes('{status.projectLabel}') && tag.includes("const resting = daemonBuild === '' && held === null && line === 'ready'") && tag.includes("const head = [resting ? restingStatusWords(shownModel, shownEffort) : modelWords, motionWords].filter(Boolean).join(' · ')") && tag.includes("const rest = held ?? (resting ? '' : line)"))
  check('the resting row reads ready · the model · the effort (the one display-label owner, the chip\'s own effort word, no asked mark)', bar.restingStatusWords('Opus 5', 'high') === 'ready · Opus 5 · high' && bar.restingStatusWords('GLM-5.3', null) === 'ready · GLM-5.3' && bar.restingStatusWords('', 'high') === 'ready' && tag.includes('useDisplayedSessionModel().compact') && tag.includes('focusedEffortLabelOf(effectiveModel, seatEffort, sentEffort, effortValue, bornEffort, false)'))
  check('the resting row paints ready in the state ink and the pair in the muted ink the project wore', tag.includes('<Text color={t.textInstruction}> ready</Text>') && tag.includes("<Text color={t.textMuted}>{head.slice('ready'.length)}</Text>"))
  check('a seat receipt takes the row while it stands, in the muted ink, and yields to the warning arms', tag.includes('const held = receipt !== \'\' && !statusRowWarns(live, status) ? receipt : null') && tag.includes('<Text color={held !== null || resting ? t.textMuted : t.textInstruction}>{fitted}</Text>') && bar.statusRowWarns({ ...IDLE_LIVE, inFlight: true }, { interrupting: true, hardStopping: false, wait: null, stuck: false }) && !bar.statusRowWarns(IDLE_LIVE, { interrupting: false, hardStopping: false, wait: null, stuck: false }))
  check('the receipt slot paints only while a row paints, stands for the composer receipt\'s eight seconds, and clears itself', bar.paintStatusRowReceipt('Effort set to medium for this session') === false && bar.statusRowReceipt() === '' && bar.STATUS_ROW_RECEIPT_MS === 8000 && tag.includes('rowsPainting += 1'))
  check('the row\'s words are statusLine over the crew\'s clock', tag.includes('statusLine(live, status, crew)'))
  check('the row\'s tick is armed only while a sub-agent runs or the runner is still booting (the boot clock)', tag.includes('useNowTick(crewActive || runnerBooting ? 1000 : null)'))
  check('the crew\'s clock reads the one work-row list and the crew facts owner', tag.includes('useFocusedWorkRows()') && tag.includes('crewAgentsOf(rows, null)') && tag.includes('focusedWorkflowRows(rows)'))
  check('the row omits the words\' separator when there are no words', tag.includes("{fitted !== '' ? (") && tag.includes("(restFloor > 0 && head !== '' ? 3 : 0)"))
}

console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
