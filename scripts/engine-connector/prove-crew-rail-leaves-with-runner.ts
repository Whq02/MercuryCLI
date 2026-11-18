#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const ROOT = resolve(import.meta.dir, '..', '..')
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail.slice(0, 500) : ''}`)
  if (!cond) failures++
}

const ledgerModule = await import('../../src/state/crewLedger.ts')
const { foldCrewLedger, sessionCrewRows, seenCrewOf, CREW_UNLISTED_STOP_WORDS } = ledgerModule
const SID = 'session-air-8b'
const sleeper = {
  id: 'agent-sleeper8b',
  agentId: 'sleeper8b',
  kind: 'agent' as const,
  name: 'sleeper8b',
  status: 'running',
  startTime: 1_000,
  description: 'Sleep 300 then reply',
}

console.log("the crew rail's rows leave with the runner when its daemon is gone (RELEASE-30-AIR R30A-04)")
console.log('\n(1) the ledger fold')
const seenRunning = seenCrewOf({}, { rows: [sleeper] }, SID)
check('a hosted running crewmate is seen from the runner\'s roster', seenRunning.length === 1 && seenRunning[0]!.hosted && seenRunning[0]!.facts.running, JSON.stringify(seenRunning))
const listed = foldCrewLedger({}, seenRunning, SID, true, 2_000)
check('…and listed in the ledger', listed['agent-sleeper8b']?.listed === true, JSON.stringify(listed))

const stillThere = foldCrewLedger(listed, [], SID, true, 3_000)
const stillRows = sessionCrewRows(stillThere, [], SID, true, 3_000)
check('a crewmate its live runner no longer lists settles as stopped, with the words, and stays until cleared (unchanged)', stillRows.length === 1 && stillRows[0]!.facts.state === 'stopped' && stillRows[0]!.facts.stopReason === CREW_UNLISTED_STOP_WORDS, JSON.stringify(stillRows))

const gone = foldCrewLedger(listed, [], SID, true, 3_000, true)
const goneRows = sessionCrewRows(gone, [], SID, true, 3_000, true)
check('the runner gone with its daemon: the row leaves the ledger with the work — no stopped row remains', Object.keys(gone).length === 0 && goneRows.length === 0, JSON.stringify({ gone, goneRows }))
const settledThenGone = foldCrewLedger(stillThere, [], SID, true, 4_000, true)
check('a row already settled as unlisted leaves too when the runner is gone', Object.keys(settledThenGone).length === 0 && sessionCrewRows(settledThenGone, [], SID, true, 4_000, true).length === 0, JSON.stringify(settledThenGone))
const other = foldCrewLedger({ ...listed, 'agent-elsewhere': { ...listed['agent-sleeper8b']!, facts: { ...listed['agent-sleeper8b']!.facts, id: 'agent-elsewhere', sessionId: 'another-session' } } }, [], SID, true, 3_000, true)
check("another session's row is not this runner's to drop", other['agent-elsewhere'] !== undefined && other['agent-sleeper8b'] === undefined, JSON.stringify(Object.keys(other)))
check('the rows read for the rail hide a hosted row while the runner is gone even before the fold lands', sessionCrewRows(listed, [], SID, true, 3_000, true).length === 0)

console.log('\n(2) the connector says when the runner is gone')
{
  const { WorkPart } = await import('../../src/services/engine-connector/daemon/work.ts')
  let carrierGone = false
  const roster = new WorkPart({ facts: () => ({ work: [sleeper] }) as never, carrierGone: () => carrierGone })
  let wakes = 0
  roster.subscribeWork(() => wakes++)
  roster.refreshWork()
  const live = { gone: roster.workRoster().gone, wakes }
  carrierGone = true
  roster.refreshWork()
  const dead = { gone: roster.workRoster().gone, wakes }
  roster.refreshWork()
  const again = wakes
  carrierGone = false
  roster.refreshWork()
  const back = { gone: roster.workRoster().gone, wakes }
  check('refreshWork reads the carrier-gone verdict into the roster snapshot (gone: true) and stamps it', live.gone === undefined && live.wakes === 1 && dead.gone === true && dead.wakes === 2 && again === 2 && back.gone === undefined && back.wakes === 3, JSON.stringify({ live, dead, again, back }))
}
{
  const scratch = mkdtempSync(join(tmpdir(), 'crew-rail-leaves-'))
  process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
  mkdirSync(process.env.MERCURY_DAEMON_DIR, { recursive: true })
  const { DaemonSessionConnector } = await import('../../src/services/engine-connector/daemonConnector.ts')
  const { publishSessionFacts } = await import('../../src/services/engine-connector/seatProjections.ts')
  const seat = new DaemonSessionConnector({ sessionId: SID, runnerId: 'runner-air-8b', title: 'the chat', projectLabel: 'proof', workspaceId: scratch, home: scratch })
  publishSessionFacts({
    schema: 1,
    sessionId: SID,
    atMs: 1,
    pendingModel: null,
    busy: true,
    model: { effective: 'claude-sonnet-5-5', setting: null },
    usage: { totalCostUSD: 0, totalAPIDurationMs: 0, totalDurationMs: 0, totalLinesAdded: 0, totalLinesRemoved: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadInputTokens: 0, totalCacheCreationInputTokens: 0, hasUnknownModelCost: false },
    identity: { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null },
    skills: [],
    mcp: [],
    workspace: { cwd: scratch, originalCwd: scratch, projectRoot: scratch },
    queue: [],
    work: [sleeper],
  })
  const reaches = seat as unknown as { readFacts(): void; settleCarrierGone(): void }
  reaches.readFacts()
  const seen: Array<{ rows: number; gone: boolean }> = []
  seat.subscribeWork(() => seen.push({ rows: seat.workRoster().rows.length, gone: seat.workRoster().gone === true }))
  const before = { rows: seat.workRoster().rows.length, gone: seat.workRoster().gone === true }
  reaches.settleCarrierGone()
  check('settleCarrierGone sets the verdict before it refreshes the work (the roster carries both at once)', before.rows === 1 && !before.gone && seen.length === 1 && seen[0]!.rows === 0 && seen[0]!.gone, JSON.stringify({ before, seen }))
  rmSync(scratch, { recursive: true, force: true })
}
const types = readFileSync(join(ROOT, 'src/services/engine-connector/types.ts'), 'utf8')
check('WorkRosterV1 carries the additive gone flag', /reported\?: boolean\s*\n\s*gone\?: boolean/.test(types))
const hook = readFileSync(join(ROOT, 'src/components/tasks/useCrewLedger.ts'), 'utf8')
check('the rail\'s hook hands the flag to the fold and the rows', /const gone = roster\.gone === true/.test(hook) && /foldCrewLedger\(prev\.crewLedger, seen, sessionId, reported, Date\.now\(\), gone\)/.test(hook) && /sessionCrewRows\(ledger, seen, sessionId, reported, Date\.now\(\), gone\)/.test(hook))

console.log(`\n${failures === 0 ? '✅ the crew rail leaves with the runner — PROVEN' : `❌ ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
