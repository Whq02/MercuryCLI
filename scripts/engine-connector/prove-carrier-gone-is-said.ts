#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'carrier-gone-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
const daemonDir = join(SCRATCH, 'daemon')
mkdirSync(daemonDir, { recursive: true })
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const REPO = join(import.meta.dir, '../..')
const SRC = join(REPO, 'src')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log(`\n${t}`)
const j = (v: unknown): string => JSON.stringify(v)
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const until = async (pred: () => boolean, budgetMs: number): Promise<number> => {
  const started = Date.now()
  while (!pred() && Date.now() - started < budgetMs) await sleep(100)
  return Date.now() - started
}

const connectorModule = await import(join(SRC, 'services/engine-connector/daemonConnector.ts'))
const { DaemonSessionConnector, CARRIER_GONE_WORDS } = connectorModule
const proj = await import(join(SRC, 'services/engine-connector/seatProjections.ts'))
const { daemonStatePath } = await import(join(SRC, 'daemon/controlSocket.ts'))

const work = join(SCRATCH, 'work')
mkdirSync(work, { recursive: true })
const baseAnswer = {
  model: { effective: 'claude-sonnet-5-5', setting: null },
  usage: {
    totalCostUSD: 0, totalAPIDurationMs: 0, totalDurationMs: 0, totalLinesAdded: 0, totalLinesRemoved: 0,
    totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadInputTokens: 0, totalCacheCreationInputTokens: 0,
    hasUnknownModelCost: false,
  },
  identity: { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null },
  skills: [],
  mcp: [],
  permissionMode: 'default' as const,
  workspace: { cwd: work, originalCwd: work, projectRoot: work, instructionRoots: [] },
  queue: [],
}
const crewRow = { id: 'agent-sleep', agentId: 'agent-sleep', kind: 'agent' as const, name: 'Run sleep command', status: 'running', startTime: Date.now() - 20_000 }

type Guts = {
  rpc: (req: Record<string, unknown>) => Promise<Record<string, unknown>>
  displayRows: Array<{ row: { type?: string; subtype?: string; content?: string; level?: string } }>
  factsBusy: boolean
  carrierGoneAtFactsMs: number | null
  readFacts: () => void
}
type Live = { inFlight: boolean; phase: string }
type Roster = { rows: Array<{ status: string }> }

function mount(sessionId: string): { connector: { attach(): Promise<void>; detach(): void; live(): Live; workRoster(): Roster }; g: Guts } {
  const connector = new DaemonSessionConnector({ sessionId, runnerId: `runner-${sessionId}`, title: 'the chat', projectLabel: 'proof', workspaceId: work, home: SCRATCH, modelKey: 'claude-sonnet-5-5' })
  const g = connector as unknown as Guts
  g.rpc = async () => { throw new Error('ENOCONN: no daemon answers') }
  return { connector, g }
}
const publishBusy = (sessionId: string, atMs: number): void => {
  proj.publishSessionFacts({ schema: 1, sessionId, atMs, pendingModel: null, busy: true, turnStartedAt: atMs - 30_000, ...baseAnswer, work: [crewRow] }, daemonDir)
}
const noticeRows = (g: Guts): string[] => g.displayRows.map(d => d.row).filter(r => r.type === 'system' && r.subtype === 'seat_receipt').map(r => String(r.content))

const liveRecord = (extra: Record<string, unknown> = {}): void => {
  writeFileSync(daemonStatePath(), JSON.stringify({ pid: process.pid, version: '1.0.0', origin: 'transient', startedAt: Date.now(), dir: daemonDir, controlSock: join(daemonDir, 'control.sock'), ...extra }))
}

section("§1 the daemon carrying a busy, waiting session is gone (its record cleared by the stop): the chat says so within 10 s and stops claiming work in flight (RELEASE-29-AIR R29A-05a)")
{
  const sid = 'carrier-gone-a'
  liveRecord()
  publishBusy(sid, Date.now())
  const { connector, g } = mount(sid)
  await connector.attach()
  await sleep(1_500)
  check('while the daemon lives (its record names a living pid), the facts read busy and waiting on the crew row', connector.live().inFlight === true && connector.workRoster().rows.some(r => r.status === 'running'), j({ live: connector.live(), rows: connector.workRoster().rows.length }))
  rmSync(daemonStatePath(), { force: true })
  const waited = await until(() => connector.live().inFlight === false, 10_000)
  check(`within 10 s the view is no longer in flight (took ${waited} ms; red on the base: the 45 s stall probe is the only fallback)`, connector.live().inFlight === false && waited < 10_000, j(connector.live()))
  check('the running crew row of the dead daemon is gone from the roster', !connector.workRoster().rows.some(r => r.status === 'running'), j(connector.workRoster().rows))
  check(`one notice row names the daemon's end: "${CARRIER_GONE_WORDS}"`, noticeRows(g).length === 1 && noticeRows(g)[0] === CARRIER_GONE_WORDS, j(noticeRows(g)))
  g.readFacts()
  check("a re-read of the same stale facts (another road's refresh) does not revive the dead daemon's busy word", connector.live().inFlight === false && g.factsBusy === false && !connector.workRoster().rows.some(r => r.status === 'running'), j(connector.live()))
  await sleep(1_200)
  check('the notice is said once', noticeRows(g).length === 1, j(noticeRows(g)))
  publishBusy(sid, Date.now())
  g.readFacts()
  check('a FRESH publication (a new daemon speaks: a new stamp) lifts the latch and the busy word is believed again', g.carrierGoneAtFactsMs === null && g.factsBusy === true, j({ latch: g.carrierGoneAtFactsMs, busy: g.factsBusy }))
  connector.detach()
}

section('§2 control: a live daemon (its record names a living pid) keeps the busy view — nothing is said')
{
  const sid = 'carrier-alive-b'
  liveRecord()
  publishBusy(sid, Date.now())
  const { connector, g } = mount(sid)
  await connector.attach()
  await sleep(5_000)
  check('five seconds on, the turn is still in flight and the crew row stands', connector.live().inFlight === true && connector.workRoster().rows.some(r => r.status === 'running'), j(connector.live()))
  check('no notice', noticeRows(g).length === 0, j(noticeRows(g)))
  connector.detach()
  rmSync(daemonStatePath(), { force: true })
}

section("§3 a daemon record that says stopping is a gone carrier too; a connector that never saw a daemon (a fixture with no record) says nothing")
{
  const sid = 'carrier-stopping-c'
  liveRecord({ state: 'stopping', stoppingAt: Date.now() })
  publishBusy(sid, Date.now())
  const { connector, g } = mount(sid)
  await connector.attach()
  const waited = await until(() => connector.live().inFlight === false, 10_000)
  check(`a stopping daemon: idle within 10 s (${waited} ms) and the notice said`, connector.live().inFlight === false && noticeRows(g).length === 1, j({ live: connector.live(), notices: noticeRows(g) }))
  connector.detach()
  rmSync(daemonStatePath(), { force: true })
  const never = mount('carrier-never-d')
  publishBusy('carrier-never-d', Date.now())
  await never.connector.attach()
  await sleep(5_000)
  check('no daemon record was ever seen: the busy view stands and nothing is said (a fixture or a resume before the daemon speaks is not a death)', never.connector.live().inFlight === true && noticeRows(never.g).length === 0, j({ live: never.connector.live(), notices: noticeRows(never.g) }))
  never.connector.detach()
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-carrier-gone-is-said: all green' : `\nprove-carrier-gone-is-said: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
