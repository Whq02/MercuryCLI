#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail.slice(0, 1500) : ''}`)
  if (!cond) failures++
}

const ledgerModule = await import('../../src/screen/app-state/crewLedger.ts')
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
check('a hosted running crewmate is seen from the runner\'s roster', seenRunning.length === 1 && seenRunning[0]!.hosted && seenRunning[0]!.facts.running, JSON.stringify(seenRunning) + ' — seenCrewOf in src/screen/app-state/crewLedger.ts is to return one hosted, running entry for a running agent row of the runner roster')
const listed = foldCrewLedger({}, seenRunning, SID, true, 2_000)
check('…and listed in the ledger', listed['agent-sleeper8b']?.listed === true, JSON.stringify(listed) + ' — foldCrewLedger in src/screen/app-state/crewLedger.ts is to record an entry it is shown as listed')

const stillThere = foldCrewLedger(listed, [], SID, true, 3_000)
const stillRows = sessionCrewRows(stillThere, [], SID, true, 3_000)
check('a crewmate its live runner no longer lists settles as stopped, with the words, and stays until cleared (unchanged)', stillRows.length === 1 && stillRows[0]!.facts.state === 'stopped' && stillRows[0]!.facts.stopReason === CREW_UNLISTED_STOP_WORDS, JSON.stringify(stillRows) + ' — with the runner still live, foldCrewLedger and sessionCrewRows in src/screen/app-state/crewLedger.ts are to keep a hosted row the roster no longer lists as stopped with CREW_UNLISTED_STOP_WORDS')

const gone = foldCrewLedger(listed, [], SID, true, 3_000, true)
const goneRows = sessionCrewRows(gone, [], SID, true, 3_000, true)
check('the runner gone with its daemon: the row leaves the ledger with the work — no stopped row remains', Object.keys(gone).length === 0 && goneRows.length === 0, JSON.stringify({ gone, goneRows }) + ' — with runnerGone set, foldCrewLedger in src/screen/app-state/crewLedger.ts is to delete this session\'s hosted rows and sessionCrewRows is to skip them')
const settledThenGone = foldCrewLedger(stillThere, [], SID, true, 4_000, true)
check('a row already settled as unlisted leaves too when the runner is gone', Object.keys(settledThenGone).length === 0 && sessionCrewRows(settledThenGone, [], SID, true, 4_000, true).length === 0, JSON.stringify(settledThenGone) + ' — the runnerGone branch of foldCrewLedger in src/screen/app-state/crewLedger.ts is to drop a hosted row whether or not it is still listed')
const other = foldCrewLedger({ ...listed, 'agent-elsewhere': { ...listed['agent-sleeper8b']!, facts: { ...listed['agent-sleeper8b']!.facts, id: 'agent-elsewhere', sessionId: 'another-session' } } }, [], SID, true, 3_000, true)
check("another session's row is not this runner's to drop", other['agent-elsewhere'] !== undefined && other['agent-sleeper8b'] === undefined, JSON.stringify(Object.keys(other)) + ' — the runnerGone branch of foldCrewLedger in src/screen/app-state/crewLedger.ts is to skip rows whose facts.sessionId is not the sessionId it is given')
check('the rows read for the rail hide a hosted row while the runner is gone even before the fold lands', sessionCrewRows(listed, [], SID, true, 3_000, true).length === 0, 'sessionCrewRows in src/screen/app-state/crewLedger.ts is to skip a hosted row when its runnerGone argument is true, without waiting for the fold')

console.log('\n(2) the connector says when the runner is gone')
{
  const { WorkPart } = await import('../../src/engine/connector/daemon/work.ts')
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
  check('refreshWork reads the carrier-gone verdict into the roster snapshot (gone: true) and stamps it', live.gone === undefined && live.wakes === 1 && dead.gone === true && dead.wakes === 2 && again === 2 && back.gone === undefined && back.wakes === 3, JSON.stringify({ live, dead, again, back }) + ' — WorkPart.refreshWork in src/engine/connector/daemon/work.ts is to put needs.carrierGone() into the roster snapshot (gone: true, absent otherwise) and wake subscribers only when the snapshot stamp changes')
}
{
  const scratch = mkdtempSync(join(tmpdir(), 'crew-rail-leaves-'))
  const planeBefore = process.env.MERCURY_DAEMON_DIR
  process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
  mkdirSync(process.env.MERCURY_DAEMON_DIR, { recursive: true })
  const { DaemonSessionConnector } = await import('../../src/engine/connector/daemonConnector.ts')
  const { publishSessionFacts } = await import('../../src/engine/connector/seatProjections.ts')
  const { daemonStatePath } = await import('../../src/daemon/control/controlSocket.ts')
  await import('../../src/daemon/control/ownerWatch.ts')
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
  const seconds: Array<() => void> = []
  const realSetInterval = globalThis.setInterval
  globalThis.setInterval = ((fire: () => void, ms: number) => {
    if (ms === 1000) seconds.push(fire)
    const never = realSetInterval(() => {}, 0x3fffffff)
    never.unref?.()
    return never
  }) as typeof setInterval
  const seen: Array<{ rows: number; gone: boolean }> = []
  let before = { rows: -1, gone: false }
  try {
    await seat.attach()
    before = { rows: seat.workRoster().rows.length, gone: seat.workRoster().gone === true }
    seat.subscribeWork(() => seen.push({ rows: seat.workRoster().rows.length, gone: seat.workRoster().gone === true }))
    const aSecondPasses = async (): Promise<void> => {
      for (const fire of [...seconds]) fire()
      for (let i = 0; i < 8; i++) await readFile(daemonStatePath(), 'utf8').catch(() => null)
      await new Promise(resolve => setImmediate(resolve))
    }
    writeFileSync(daemonStatePath(), JSON.stringify({ pid: process.pid, version: '1.0.0', origin: 'transient', startedAt: Date.now(), dir: process.env.MERCURY_DAEMON_DIR, controlSock: join(process.env.MERCURY_DAEMON_DIR, 'control.sock') }))
    for (let i = 0; i < 3; i++) await aSecondPasses()
    rmSync(daemonStatePath(), { force: true })
    for (let i = 0; i < 40 && seat.workRoster().gone !== true; i++) await aSecondPasses()
  } finally {
    seat.detach()
    globalThis.setInterval = realSetInterval
  }
  check(
    'settleCarrierGone sets the verdict before it refreshes the work (the roster carries both at once)',
    before.rows === 1 && !before.gone && seen.length === 1 && seen[0]!.rows === 0 && seen[0]!.gone,
    `${JSON.stringify({ before, seen, tickers: seconds.length })} — an attached window on a busy turn, its daemon's record read alive once and then gone at each second: the work listener is to wake once, on a roster that is empty and gone together; CarrierPart.settleCarrierGone in src/engine/connector/daemon/carrier.ts latches the verdict before it calls carrierWentAway, and carrierWentAway of daemonConnector.ts strips the facts before it refreshes the work`,
  )
  if (planeBefore === undefined) delete process.env.MERCURY_DAEMON_DIR
  else process.env.MERCURY_DAEMON_DIR = planeBefore
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? '✅ the crew rail leaves with the runner — PROVEN' : `❌ ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
