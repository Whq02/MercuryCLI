#!/usr/bin/env bun
// gate-watch: src/components/tasks/BackgroundTasksDialog.tsx src/services/engine-connector/crewFacts.ts src/state/crewLedger.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const ROOT = join(import.meta.dir, '..', '..')
const src = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

await import('../../src/tools/AgentTool/AgentTool.tsx')
type WorkRowV1 = import('../../src/services/engine-connector/types.ts').WorkRowV1
type CrewAgentFacts = import('../../src/services/engine-connector/crewFacts.ts').CrewAgentFacts
const crew = await import('../../src/services/engine-connector/crewFacts.ts')
const ledgerMod = await import('../../src/state/crewLedger.ts')
const board = (await import('../../src/components/tasks/BackgroundTasksDialog.tsx')) as {
  rosterRowsOf: (rows: readonly WorkRowV1[], kind: WorkRowV1['kind'], excludeIds?: ReadonlySet<string>) => WorkRowV1[]
  boardAgentRowsOf?: (rows: readonly WorkRowV1[], crewFacts: readonly CrewAgentFacts[], excludeIds?: ReadonlySet<string>) => WorkRowV1[]
  boardRowElapsedMs?: (item: { work?: WorkRowV1 }, now: number) => number | null
}
const { formatDuration } = await import('../../src/utils/format.ts')

const boardAgentRows = board.boardAgentRowsOf ?? ((rows, _crewFacts, excludeIds) => board.rosterRowsOf(rows, 'agent', excludeIds))
const boardElapsed = board.boardRowElapsedMs ?? ((item, now) => (item.work === undefined || !Number.isFinite(item.work.startTime) || item.work.startTime === 0 ? null : Math.max(0, now - item.work.startTime)))

const SID = 'sess-1'
const t0 = 1_800_000_000_000
const row = (over: Partial<WorkRowV1> & Pick<WorkRowV1, 'id' | 'status' | 'startTime'>): WorkRowV1 =>
  ({ kind: 'agent', name: `Helper ${over.id.toUpperCase()}`, model: 'claude-opus-5-5', inputTokens: 4500, outputTokens: 200, contextTokens: 940, toolUses: 4, agentType: 'mercury-crew', ...over }) as WorkRowV1

console.log('— §1 one clock, stopped at the end —')
{
  const landed = row({ id: 'b', status: 'completed', startTime: t0 - 120_000, endTime: t0 - 100_000 })
  const running = row({ id: 'a', status: 'running', startTime: t0 - 30_000 })
  const factsB = crew.crewAgentFactsOf(landed, SID)!
  const factsA = crew.crewAgentFactsOf(running, SID)!
  for (const later of [t0, t0 + 23_000, t0 + 10 * 60_000]) {
    const boardAge = boardElapsed({ work: landed }, later)
    check(`a landed helper's time on the runs board is its real length (20s) at +${(later - t0) / 1000}s, the crew view's own figure`, boardAge !== null && formatDuration(boardAge) === crew.crewElapsedLabel(factsB, later) && formatDuration(boardAge) === formatDuration(20_000), `board ${boardAge === null ? 'null' : formatDuration(boardAge)} · crew ${crew.crewElapsedLabel(factsB, later)}`)
  }
  const boardRunning = boardElapsed({ work: running }, t0 + 5_000)
  check('a running helper ticks the same on both views', boardRunning !== null && formatDuration(boardRunning) === crew.crewElapsedLabel(factsA, t0 + 5_000) && formatDuration(boardRunning) === formatDuration(35_000), `board ${boardRunning === null ? 'null' : formatDuration(boardRunning)} · crew ${crew.crewElapsedLabel(factsA, t0 + 5_000)}`)
  check('a row with no start has no age', boardElapsed({ work: row({ id: 'z', status: 'running', startTime: 0 }) }, t0) === null)
}

console.log('— §2 the same crew in both views —')
{
  const rows: WorkRowV1[] = [
    row({ id: 'a', status: 'running', startTime: t0 - 30_000 }),
    row({ id: 'b', status: 'completed', startTime: t0 - 120_000, endTime: t0 - 100_000 }),
    row({ id: 'c', status: 'completed', startTime: t0 - 300_000, endTime: t0 - 290_000 }),
  ]
  const evicted = crew.crewAgentFactsOf(row({ id: 'd', status: 'running', startTime: t0 - 400_000 }), SID)!
  const seen = ledgerMod.seenCrewOf({}, { rows }, SID)
  let ledger = ledgerMod.foldCrewLedger({ d: { facts: evicted, hosted: true, listed: true, cleared: false, stamp: ledgerMod.crewFactsStamp(evicted) } }, seen, SID, true, t0)
  ledger = ledgerMod.clearCrewLedgerRow(ledger, 'c')
  const crewRows = ledgerMod.sessionCrewRows(ledger, seen, SID, true, t0)
  const crewIds = crewRows.map(r => r.facts.id)
  check('the crew view lists the running, the landed and the evicted helper, never the cleared one', crewIds.join(',') === 'a,b,d', crewIds.join(','))
  const boardRows = boardAgentRows(rows, crewRows.map(r => r.facts), new Set())
  const boardIds = boardRows.map(r => r.id)
  check('the runs board lists exactly the rows the crew view lists, in the same order', boardIds.join(',') === crewIds.join(','), `board ${boardIds.join(',')} · crew ${crewIds.join(',')}`)
  const d = boardRows.find(r => r.id === 'd')
  check('a helper the runner stopped listing mid-run reads stopped on the board with the crew view’s own reason, its time frozen where the view froze it', d !== undefined && crew.crewStateLabel(crew.crewAgentFactsOf(d, SID)!) === 'stopped' && d.stopReason === ledgerMod.CREW_UNLISTED_STOP_WORDS && boardElapsed({ work: d }, t0 + 60_000) === 400_000, d === undefined ? 'absent' : JSON.stringify({ status: d.status, stopReason: d.stopReason, age: boardElapsed({ work: d }, t0 + 60_000) }))
  const screenOwned = boardAgentRows(rows, crewRows.map(r => r.facts), new Set(['a']))
  check('a helper the cockpit itself hosts is left to its own section', screenOwned.map(r => r.id).join(',') === 'b,d', screenOwned.map(r => r.id).join(','))
  check('three helpers side by side: running first, newest first, on both', boardIds[0] === 'a' && boardIds[1] === 'b' && boardIds[2] === 'd' && crewIds[0] === 'a')
}

console.log('— §3 the facts round-trip to a board row —')
{
  const full = row({ id: 'r', status: 'killed', startTime: t0 - 50_000, endTime: t0 - 10_000, description: 'count slowly', error: undefined, cacheReadTokens: 12, costUSD: 0.06, unpricedTurns: 1, activity: 'Bash', toolUseId: 'tu-r', pendingAsks: 0, crew: 'alpha', effort: 'high', transcriptAgentId: 'ag-r', stopReason: 'interrupted by the operator on its screen', unreadNotices: 2, cwd: '/tmp/x', worktree: '/tmp/x/.wt' })
  const facts = crew.crewAgentFactsOf(full, SID)!
  const back = crew.workRowOfCrewFacts !== undefined ? crew.crewAgentFactsOf(crew.workRowOfCrewFacts(facts), SID) : null
  check('a board row rebuilt from the crew facts yields the same facts (one derivation, both ways)', back !== null && JSON.stringify(back) === JSON.stringify(facts), back === null ? 'no workRowOfCrewFacts' : JSON.stringify(back).slice(0, 200))
}

console.log('— §4 the board paints through the one derivation —')
{
  const dialog = src('src/components/tasks/BackgroundTasksDialog.tsx')
  check('the board’s agent section rides boardAgentRowsOf over the session crew', dialog.includes('boardAgentRowsOf(roster.rows, sessionCrew.map(row => row.facts), screenIds)'))
  check('the age cell rides boardRowElapsedMs (frozen at the end)', dialog.includes('const elapsed = boardRowElapsedMs(item, now)'))
  check('the board reads the same crew ledger the crew view reads', dialog.includes("import { useSessionCrew } from './useCrewLedger.js'") && src('src/components/mercury-ui/screens/CrewView.tsx').includes("import { useSessionCrew } from '../../tasks/useCrewLedger.js'"))
}

console.log(failures === 0 ? '\nprove-crew-views-agree: ALL LAWS HOLD' : `\nprove-crew-views-agree: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
