#!/usr/bin/env bun
// ============================================================================
//  scripts/engine-connector/prove-work-scope.ts — THE WORK-SCOPE LAWS:
//  the work views follow the FOCUSED session.
//
//  The root: the work stores were screen-global while every session runs in
//  its own runner — session A's workflows painted under session B, and a
//  runner's live workflow never painted at all. The fix: the runner answers
//  its WORK ROSTER in its session_facts answer; the connector serves it
//  through the censused workRoster()/subscribeWork doors; the views render
//  the focused connector's rows only.
//
//   P1  the projector: the runner's task store → wire rows (each kind, the
//       workflow's phases/agents, the main-session exclusion, clipping);
//   P2  the wire: `work` rides the published facts and an OLD answer
//       (no work field) still validates — absence reads as the empty roster;
//   P3  the connector: facts-backed rows; CONTENT-KEYED snapshots (an
//       unchanged publish keeps identity and emits nothing); a RETIRED
//       facts file empties the roster (a gone runner's rows never claim
//       motion); the blank chat answers the honest empty;
//   P4  THE HOP LAW (the operator's sentence): focus A → A's workflow row;
//       hop to B → the focused roster carries ZERO of A's rows;
//   P5  END-TO-END on the real artifact: a scratch daemon hosts TWO
//       sessions in ONE workspace; A's model launches a real scripted
//       workflow (the Workflow tool, agents over the fixture API); A's
//       connector paints the run LIVE (the workflows-board fold-row kill)
//       while B's roster stays empty the whole run; the leak-filter seam:
//       A's claims-running manifest is owned by A's live runner pid, which
//       sits in otherSessionRunnerPids(B) and not in
//       otherSessionRunnerPids(A).
//  Fixture-hermetic: scratch home + daemon dir + workspace; no live wires;
//  the daemon and its children are shut down and reaped by exact pid.
// ============================================================================
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'work-scope-')))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
const work2 = join(SCRATCH, 'work2')
for (const d of [home, daemonDir, work, work2]) mkdirSync(d, { recursive: true })
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
process.env.MERCURY_CONCOURSE = 'always'
process.env.ANTHROPIC_API_KEY = 'fixture-key-000'

const DIST = join(process.cwd(), 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}

// The timeout guard REAPS before it exits: process.exit would cut the
// finally-ladder and leak the daemon and its workers (the fixture-leak
// class — reap by exact pid, never a pattern).
const guardPids = new Set<number>()
const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — proof exceeded 240s')
  for (const pid of guardPids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
  process.exit(1)
}, 240_000)
guard.unref?.()

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const wait = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const untilAsync = async (pred: () => Promise<boolean> | boolean, ms: number): Promise<boolean> => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      if (await pred()) return true
    } catch {
      /* not yet */
    }
    await wait(150)
  }
  return false
}

// ── P1: the projector ───────────────────────────────────────────────────────
section('P1 the projector: the runner\'s task store → wire rows')
{
  const { projectWorkRoster } = await import('../../src/utils/task/workRoster.ts')
  const t0 = 1_000_000_000_000
  const store = {
    wf1: {
      id: 'wf1',
      type: 'local_workflow',
      status: 'running',
      description: 'probe run',
      startTime: t0,
      outputFile: '/nowhere',
      outputOffset: 0,
      notified: false,
      script: 'export const meta = {}',
      prompt: 'export const meta = {}',
      workflowName: 'scope-probe',
      workflowRunId: 'run-1',
      workflowProgress: [
        { type: 'workflow_phase', index: 1, title: 'Probe' },
        { type: 'workflow_agent', index: 0, label: 'probe:a', state: 'progress', phaseIndex: 1, phaseTitle: 'Probe' },
        { type: 'workflow_agent', index: 1, label: 'probe:b', state: 'done', phaseIndex: 1, phaseTitle: 'Probe' },
      ],
      progressVersion: 3,
      agentCount: 2,
      totalTokens: 1234,
      totalToolCalls: 3,
      logs: [],
      retain: false,
      pendingPermissions: new Map([['tu-1', {} as never]]),
    },
    ag1: {
      id: 'ag1',
      type: 'local_agent',
      status: 'running',
      description: 'audit the fixtures',
      agentId: 'ag1',
      prompt: 'p',
      agentType: 'general-purpose',
      isBackgrounded: true,
      startTime: t0 + 1,
      outputFile: '/nowhere',
      outputOffset: 0,
      notified: false,
    },
    main1: {
      id: 'main1',
      type: 'local_agent',
      status: 'running',
      description: 'the session itself',
      agentId: 'main1',
      prompt: 'p',
      agentType: 'main-session',
      isBackgrounded: true,
      startTime: t0 + 2,
      outputFile: '/nowhere',
      outputOffset: 0,
      notified: false,
    },
    tm1: {
      id: 'tm1',
      type: 'in_process_teammate',
      status: 'running',
      description: 'teammate',
      identity: { agentId: 'scout@crew', agentName: 'scout', teamName: 'crew' },
      prompt: 'p',
      awaitingPlanApproval: false,
      startTime: t0 + 3,
      outputFile: '/nowhere',
      outputOffset: 0,
      notified: false,
    },
    sh1: {
      id: 'sh1',
      type: 'local_bash',
      status: 'completed',
      description: 'shell',
      command: 'echo hello',
      completionStatusSentInAttachment: false,
      shellCommand: null,
      lastReportedTotalLines: 0,
      startTime: t0 + 4,
      endTime: t0 + 5,
      outputFile: '/nowhere',
      outputOffset: 0,
      notified: false,
    },
  } as never
  const rows = projectWorkRoster(store)
  check('P1 every kind projects, the main-session row excluded', rows.length === 4 && !rows.some(r => r.id === 'main1'), JSON.stringify(rows.map(r => r.id)))
  const wf = rows.find(r => r.id === 'wf1')
  check('P1 the workflow row carries its run facts', wf !== undefined && wf.kind === 'workflow' && wf.workflowRunId === 'run-1' && wf.agentCount === 2 && wf.totalTokens === 1234 && wf.pendingAsks === 1)
  check(
    'P1 the phases project grouped with agent states',
    wf?.phases?.length === 1 && wf.phases[0]!.title === 'Probe' && wf.phases[0]!.agents.length === 2 && wf.phases[0]!.agents.map(a => a.state).join(',') === 'progress,done',
    JSON.stringify(wf?.phases),
  )
  const tm = rows.find(r => r.id === 'tm1')
  check('P1 the teammate row names its team', tm?.kind === 'teammate' && tm.name === 'scout' && tm.team === 'crew')
  const sh = rows.find(r => r.id === 'sh1')
  check('P1 the shell row keeps its settle time', sh?.kind === 'shell' && sh.endTime === t0 + 5 && sh.status === 'completed')
  check('P1 newest first, stable', rows[0]!.id === 'sh1' && rows[rows.length - 1]!.id === 'wf1')
}

// ── P2: the wire ────────────────────────────────────────────────────────────
section('P2 the wire: `work` rides the facts; an old answer still validates')
const proj = await import('../../src/services/engine-connector/seatProjections.ts')
const SID_A = '00000000-0000-4000-8000-00000000000a'
const SID_B = '00000000-0000-4000-8000-00000000000b'
const baseAnswer = {
  model: { effective: 'claude-opus-5', setting: null },
  usage: {
    totalCostUSD: 0, totalAPIDurationMs: 0, totalDurationMs: 0, totalLinesAdded: 0, totalLinesRemoved: 0,
    totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadInputTokens: 0, totalCacheCreationInputTokens: 0,
    hasUnknownModelCost: false,
  },
  identity: { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null },
  skills: [],
  mcp: [],
  permissionMode: 'flow' as const,
  workspace: { cwd: work, originalCwd: work, projectRoot: work, instructionRoots: [] },
  queue: [],
}
const wfRow = {
  id: 'wf-a', kind: 'workflow' as const, name: 'scope-probe', status: 'running',
  startTime: Date.now(), totalTokens: 5, workflowRunId: 'run-a', agentCount: 1,
  phases: [{ title: 'Probe', planned: false, agents: [{ index: 0, label: 'probe:a', state: 'progress' }] }],
}
{
  proj.publishSessionFacts({ schema: 1, sessionId: SID_A, atMs: Date.now(), pendingModel: null, busy: false, ...baseAnswer, work: [wfRow] })
  check('P2 the published facts carry the roster', await untilAsync(() => proj.readSessionFacts(SID_A)?.work?.length === 1, 5_000))
  proj.publishSessionFacts({ schema: 1, sessionId: SID_B, atMs: Date.now(), pendingModel: null, busy: false, ...baseAnswer })
  check('P2 an old answer (no work field) still validates — absence = empty', await untilAsync(() => {
    const f = proj.readSessionFacts(SID_B)
    return f !== null && f.work === undefined
  }, 5_000))
}

// ── P3 + P4: the connector, hermetic ────────────────────────────────────────
section('P3/P4 the connector: content-keyed rows · retire clears · the hop law')
{
  const seat = await import('../../src/services/engine-connector/daemonConnector.ts')
  const slot = await import('../../src/services/engine-connector/focusedConnector.ts')
  const recordOf = (sid: string, title: string) => ({
    sessionId: sid,
    runnerId: 'concourse-w0',
    title,
    projectLabel: basename(work),
    workspaceId: work,
    home: join(SCRATCH, 'transcripts'),
  })
  mkdirSync(join(SCRATCH, 'transcripts'), { recursive: true })
  const a = seat.daemonSessionConnectorFor(recordOf(SID_A, 'A'))
  const b = seat.daemonSessionConnectorFor(recordOf(SID_B, 'B'))
  check('P3 the constructor reads the facts synchronously — A has its row', a.workRoster().rows.length === 1 && a.workRoster().rows[0]!.name === 'scope-probe')
  check('P3 B answers the honest empty', b.workRoster().rows.length === 0)
  check('P3 the snapshot is stable between changes (the uSES law)', a.workRoster() === a.workRoster())

  // The hop law, at the slot: focus A, then hop to B.
  await seat.focusDaemonSession(recordOf(SID_A, 'A'))
  const focusedRows = (): readonly { name: string }[] => slot.getFocusedSessionConnector().workRoster().rows
  check('P4 focus A → the focused roster carries A\'s workflow', focusedRows().some(r => r.name === 'scope-probe'))
  let workPings = 0
  const composed = slot.subscribeThroughFocused((c, l) => c.subscribeWork(l))
  const offComposed = composed(() => workPings++)
  await seat.focusDaemonSession(recordOf(SID_B, 'B'))
  check('P4 hop to B → ZERO of A\'s rows (the operator\'s sentence)', focusedRows().length === 0)
  check('P4 the composed feed heard the hop', workPings > 0, `pings=${workPings}`)

  // Content-keying: an identical publish emits nothing and keeps identity;
  // a changed roster emits and swaps the snapshot.
  await seat.focusDaemonSession(recordOf(SID_A, 'A'))
  const before = a.workRoster()
  let aPings = 0
  const offA = a.subscribeWork(() => aPings++)
  proj.publishSessionFacts({ schema: 1, sessionId: SID_A, atMs: Date.now(), pendingModel: null, busy: false, ...baseAnswer, work: [wfRow] })
  await wait(1200)
  check('P3 an unchanged roster keeps its snapshot identity and emits nothing', a.workRoster() === before && aPings === 0, `pings=${aPings}`)
  const settledRow = { ...wfRow, status: 'completed', endTime: Date.now() }
  proj.publishSessionFacts({ schema: 1, sessionId: SID_A, atMs: Date.now(), pendingModel: null, busy: false, ...baseAnswer, work: [settledRow] })
  check('P3 a changed roster emits and the rows follow', await untilAsync(() => aPings > 0 && a.workRoster().rows[0]?.status === 'completed', 5_000), `pings=${aPings}`)

  // The mission ledger rides the same snapshot (the /tasks mission board
  // keyed on the screen's own process session and read empty over a
  // resumed session's ledger — the lead's handed-in frames).
  proj.publishSessionFacts({
    schema: 1, sessionId: SID_A, atMs: Date.now(), pendingModel: null, busy: false, ...baseAnswer,
    work: [settledRow],
    mission: [{ id: '1', subject: 'audit the fixtures', activeForm: 'Auditing the fixtures', status: 'in_progress' }],
  })
  check('P3 the mission ledger rides the work snapshot', await untilAsync(() => a.workRoster().mission.length === 1 && a.workRoster().mission[0]?.status === 'in_progress', 5_000))

  // The retirement law: the facts file goes (the runner settled) — the
  // roster empties instead of leaving rows behind a gone engine.
  proj.retireSeatProjections(SID_A)
  check('P3 a retired facts file empties the roster', await untilAsync(() => a.workRoster().rows.length === 0 && a.workRoster().mission.length === 0, 6_000))
  offA()
  offComposed()

  const { NoSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.ts')
  const blank = new NoSessionConnector()
  check('P3 the resting slot (no chat open) answers the stable honest empty', blank.workRoster().rows.length === 0 && blank.workRoster() === blank.workRoster())
  slot._resetFocusedSessionConnectorForTesting()
}

// ── P5: end-to-end on the real artifact ─────────────────────────────────────
section('P5 end-to-end: two sessions, one workspace — A\'s run paints, B stays empty')
proj.resetSeatProjections()
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(home, [work])
// The Workflow tool is allowed by rule — the consent road has its own pin
// (the seat-daemon laws' D2); this proof is about the roster.
const { writeFileSync } = await import('node:fs')
writeFileSync(join(home, 'settings.json'), JSON.stringify({ permissions: { allow: ['Workflow', 'Agent', 'Task'] } }))
// A second session in one workspace needs git (the isolation law: the
// concourse forks it into a worktree of this repo on its own).
{
  const { execFileSync } = await import('node:child_process')
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'pin', GIT_AUTHOR_EMAIL: 'pin@scratch', GIT_COMMITTER_NAME: 'pin', GIT_COMMITTER_EMAIL: 'pin@scratch' }
  execFileSync('git', ['init', '-q'], { cwd: work, env: gitEnv })
  execFileSync('git', ['add', '-A'], { cwd: work, env: gitEnv })
  execFileSync('git', ['commit', '-qm', 'seed', '--allow-empty'], { cwd: work, env: gitEnv })
}

const WORKFLOW_SCRIPT = [
  "export const meta = { name: 'scope-probe', description: 'work-scope pin', phases: [{ title: 'Probe' }] }",
  "phase('Probe')",
  // The agent runs on its own model so the fixture scripts ITS turn (the
  // Sleep hold below, then 'done') without racing the main turn's rows.
  "const a = await agent('hold the probe open for a while, then reply with the word done', { model: 'claude-opus-5' })",
  'return { a }',
].join('\n')

// THE HOLD: the run must be OBSERVABLY live while the
// connector reads it and while session B opens — a paced model reply was
// meant to hold it, but the row order handed the agent the instant
// 'workflow launched.' text instead, so the probe finished in ~90 ms and
// the two live-window legs raced it (red in two batches here and in a
// FIELD-SPEED run, green when the race went the other way). A latch held
// through a Bash wait was the first re-cut; the fixture's own request
// ledger then showed the headless runner's FLOW classifier denying the
// Bash before any allow rule mattered ("The classifier answered without a
// tool-use block — blocking for safety" — the classifier's own model call
// ate a fixture row). The hold is therefore a SLEEP turn: the Sleep tool
// is read-only (an engine allow — no ask, no classifier), permission-free
// and bounded; the B checks land well inside its window on a quiet box,
// and the settle check outwaits it.
const HOLD_SECONDS = 40

const { startFixtureApi } = await import('../lib/fixtureApi.ts')
// The rows serve in dispatch order (FIFO under the whenModel gates), so
// the drive sequences its turns: A's 'ready'; the grant-notice turn
// launches the Workflow; the workflow's agent (opus) takes the Sleep hold,
// then its 'done'; the main turn's continuation takes 'workflow
// launched.'; B (sonnet, its own workspace) takes a catch-all; the
// completion notification takes its cushion; the helper turn dispatches
// the Agent on haiku.
const api = await startFixtureApi([
  // Consumption is awaited turn by turn (gated rows outrank catch-alls per
  // matching request, so each family maps to ONE actor at any moment):
  // A(opus) 'ready' — awaited settled; the grant notice turn(opus) launches
  // the Workflow; the workflow's agent (opus) holds through the Sleep, then
  // says done; the main turn's continuation (opus) reads 'workflow
  // launched.'; B's floored-to-default first turn and A's
  // completion-notification turn take catch-alls (no gated opus remains);
  // the helper turn runs on HAIKU after an idle model switch, so its rows
  // are its own.
  { kind: 'text', whenModel: 'opus', text: 'ready.' },
  { kind: 'tool_use', whenModel: 'opus', name: 'Workflow', input: { script: WORKFLOW_SCRIPT }, preText: 'launching the probe. ' },
  { kind: 'tool_use', whenModel: 'opus', name: 'Sleep', input: { seconds: HOLD_SECONDS }, preText: 'holding the probe. ' },
  { kind: 'text', whenModel: 'opus', text: 'done' },
  { kind: 'text', whenModel: 'opus', text: 'workflow launched.' },
  { kind: 'tool_use', whenModel: 'haiku', name: 'Agent', input: { description: 'helper', prompt: 'reply with the word done', run_in_background: true }, preText: 'dispatching a helper. ' },
  { kind: 'text', whenModel: 'haiku', text: 'helper dispatched.' },
  { kind: 'text', text: 'hi from B.' },
  { kind: 'text', text: 'noted.' },
  { kind: 'text', text: 'done.' },
  { kind: 'text', text: 'done.' },
  { kind: 'text', text: 'done.' },
  { kind: 'text', text: 'done.' },
  { kind: 'text', text: 'done.' },
  { kind: 'text', text: 'done.' },
])

const logFd = openSync(join(SCRATCH, 'daemon.log'), 'a')
const daemon = spawn('node', [DIST, 'daemon', 'run', work], {
  cwd: work,
  env: {
    ...process.env,
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: daemonDir,
    ANTHROPIC_API_KEY: 'fixture-key-000',
    ANTHROPIC_BASE_URL: api.url,
    MERCURY_CACHE_CLOCK: '0',
    MERCURY_PARTY: '0',
    // No tool deferral: the scripted model calls Workflow directly (the
    // fixture cannot answer a ToolSearch round first).
    MERCURY_TOOL_SEARCH: '0',
  },
  stdio: ['ignore', logFd, logFd],
})
if (daemon.pid !== undefined) guardPids.add(daemon.pid)
const workerPids: number[] = []
try {
  const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
  const { clientVersionFacts } = await import('../../src/daemon/handshake.ts')
  // READY, not merely serving: `ping` answers ahead of the daemon's
  // readiness gate, so a dispatch fired on it raced the adoption / lock
  // work and was refused ESTARTING (batch 2 and 3 of the liveness lane, a
  // FIELD-SPEED run elsewhere) — every later P5 leg then failed on an
  // undefined session id. The `hello` handshake carries the daemon's own
  // `ready` bit (the same fact every keyed op answers ESTARTING against).
  const client = clientVersionFacts()
  check(
    'P5 the daemon serves and is READY (hello.ready — past adoption / lock acquisition)',
    await untilAsync(async () => {
      const hello = (await daemonControlRpc({ op: 'hello', proto: client.proto, clientVersion: client.version, clientBuildTree: client.buildTree } as never)) as { ok?: boolean; ready?: boolean }
      return hello.ok === true && hello.ready === true
    }, 60_000),
  )

  const dispatch2 = async (prompt: string, title: string, modelKey: string, dir: string): Promise<{ sessionId: string; runnerId: string }> => {
    const d = (await daemonControlRpc({
      op: 'concourseDispatch',
      clientMessageId: `work-scope-${title}`,
      prompt,
      workspaceDir: dir,
      title,
      modelKey,
      effort: 'high',
    } as never)) as { ok?: boolean; sessionId?: string; runnerId?: string }
    check(`P5 session ${title} dispatched`, d.ok === true && d.sessionId !== undefined, JSON.stringify(d))
    return { sessionId: d.sessionId ?? '', runnerId: d.runnerId ?? '' }
  }

  const A = await dispatch2('say ready', 'A', 'claude-opus-5', work)
  // A's first turn SETTLES before anything else moves (its transcript
  // carries the reply) — the launch belongs to the grant-notice turn.
  {
    const root = join(home, 'projects')
    const aReplied = (): boolean => {
      if (!existsSync(root)) return false
      for (const entry of readdirSync(root)) {
        const candidate = join(root, entry, `${A.sessionId}.jsonl`)
        if (existsSync(candidate) && readFileSync(candidate, 'utf8').includes('ready.')) return true
      }
      return false
    }
    check('P5 A\'s first turn settles', await untilAsync(aReplied, 60_000))
  }

  const sup = await import('../../src/daemon/concourseSupervisor.ts')
  const pidOf = (sid: string): number | undefined =>
    Object.values(sup.readSessionWorkers(daemonDir)).find(r => r.sessionId === sid && r.endedAt === undefined)?.pid
  await untilAsync(() => pidOf(A.sessionId) !== undefined, 30_000)
  {
    const p = pidOf(A.sessionId)
    if (p !== undefined) {
      workerPids.push(p)
      guardPids.add(p)
    }
  }

  const seat = await import('../../src/services/engine-connector/daemonConnector.ts')
  const paths = await import('../../src/utils/sessionStorage/paths.ts')
  const recordFor = (sid: string, runnerId: string, title: string) => ({
    sessionId: sid,
    runnerId,
    title,
    projectLabel: basename(work),
    workspaceId: title === 'A' ? work : work2,
    home: paths.getProjectDir(title === 'A' ? work : work2),
    modelKey: title === 'A' ? 'claude-opus-5' : 'claude-sonnet-5',
  })
  const connA = await seat.focusDaemonSession(recordFor(A.sessionId, A.runnerId, 'A'))
  const rowsA = (): readonly { kind: string; status: string; name: string; phases?: readonly { agents: readonly { state: string }[] }[] }[] => connA.workRoster().rows

  // A backgrounded runner launches workflows only under the concourse's
  // ONE workflows-allowed tag (the launch-authority law) — granted here
  // the sanctioned way. The grant's switchboard notice spins the next
  // turn, and the fixture answers it with the Workflow launch (one model
  // request per scripted row — deterministic order).
  const grant = (await daemonControlRpc({ op: 'concourseControl', action: 'grant-workflows', sessionId: A.sessionId, by: 'operator' } as never)) as { ok?: boolean }
  check('P5 the workflows-allowed tag grants', grant.ok === true, JSON.stringify(grant))

  // THE FOLD-ROW KILL: the runner's live workflow PAINTS on the connector.
  check(
    'P5 A\'s live workflow paints on A\'s connector (running, named)',
    await untilAsync(() => rowsA().some(r => r.kind === 'workflow' && r.status === 'running' && r.name === 'scope-probe'), 90_000),
    JSON.stringify(rowsA()),
  )
  // THE HOLD'S OWN LEDGER (the fixture's request log — every request the
  // runner and its agents sent): a tool_use rides a request body only once
  // its result does (the agent's NEXT request carries both), so "served
  // and standing" cannot be read off the bodies — it reads off the FIFO
  // law instead: the hold row is the third gated opus row, served to the
  // third opus request (A's 'ready', the grant-notice turn's launch, then
  // the agent's own), so `served` is that request having gone out while
  // no request yet carries the Sleep's result; RETURNED is the result
  // carrying the tool's slept_seconds — a denial or a missing tool reads
  // there too, verbatim.
  type Block = { type?: string; id?: string; name?: string; input?: { seconds?: number }; tool_use_id?: string; content?: unknown }
  const holdLedger = (): { served: boolean; results: string[] } => {
    const ids = new Set<string>()
    const results: string[] = []
    const opusRequests = api.messageRequests().filter(r => String((r.body as { model?: string }).model ?? '').includes('opus')).length
    for (const r of api.messageRequests()) {
      const messages = (r.body as { messages?: Array<{ content?: unknown }> }).messages ?? []
      for (const m of messages) {
        if (!Array.isArray(m.content)) continue
        for (const b of m.content as Block[]) {
          if (b.type === 'tool_use' && b.name === 'Sleep' && typeof b.id === 'string' && b.input?.seconds === HOLD_SECONDS) ids.add(b.id)
        }
      }
      for (const m of messages) {
        if (!Array.isArray(m.content)) continue
        for (const b of m.content as Block[]) {
          if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string' || !ids.has(b.tool_use_id)) continue
          const text = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? (b.content as Array<{ text?: string }>).map(x => x.text ?? '').join('') : JSON.stringify(b.content)
          if (!results.includes(text)) results.push(text)
        }
      }
    }
    return { served: opusRequests >= 3 || ids.size > 0, results }
  }
  check(
    'P5 the agent\'s Sleep hold was served and STANDS (the agent\'s own request went out, no result yet)',
    (await untilAsync(() => holdLedger().served, 30_000)) && holdLedger().results.length === 0,
    JSON.stringify(holdLedger()),
  )
  // The roster follows the run INSIDE the tool call: the agent appears
  // (task_progress narration / the 1 s work poll — no settled turn needed).
  check(
    'P5 the run\'s agents reach the roster while it runs',
    await untilAsync(() => rowsA().some(r => r.kind === 'workflow' && (r.phases ?? []).some(p => p.agents.length > 0)), 60_000),
    JSON.stringify(rowsA()),
  )

  // THE TWO-SESSION LAW: session B opens INSIDE the run's live window
  // (the paced agent holds it open; every gated-opus row is consumed by
  // now, so B's floored-to-default first turn takes a catch-all). B's
  // roster carries ZERO of A's rows while A's run is genuinely live.
  const B = await dispatch2('just say hi', 'B', 'claude-sonnet-5', work2)
  await untilAsync(() => pidOf(B.sessionId) !== undefined, 30_000)
  {
    const p = pidOf(B.sessionId)
    if (p !== undefined) {
      workerPids.push(p)
      guardPids.add(p)
    }
  }
  const connB = seat.daemonSessionConnectorFor(recordFor(B.sessionId, B.runnerId, 'B'))
  await connB.attach()
  const stillRunning = rowsA().some(r => r.kind === 'workflow' && r.status === 'running')
  check('P5 A\'s run is still live as B opens', stillRunning)
  check('P5 B\'s roster carries ZERO of A\'s rows while A runs', connB.workRoster().rows.length === 0, JSON.stringify(connB.workRoster().rows))

  // The leak-filter seam: A's claims-running manifest is owned by A's live
  // runner pid — in otherSessionRunnerPids(B), not in (A).
  const runsRoot = join(work, '.mercury', 'workflows', 'runs')
  check('P5 the run manifest exists in the SHARED workspace', await untilAsync(() => existsSync(runsRoot) && readdirSync(runsRoot).length > 0, 30_000))
  const fw = await import('../../src/components/tasks/useFocusedWork.ts')
  const manifestOwner = ((): number | undefined => {
    try {
      const dirs = readdirSync(runsRoot)
      for (const d of dirs) {
        const m = JSON.parse(readFileSync(join(runsRoot, d, 'run.json'), 'utf8')) as { ownerPid?: number }
        if (m.ownerPid !== undefined) return m.ownerPid
      }
    } catch {
      /* unreadable yet */
    }
    return undefined
  })()
  const pidsForB = fw.otherSessionRunnerPids(B.sessionId)
  const pidsForA = fw.otherSessionRunnerPids(A.sessionId)
  check(
    'P5 the leak filter\'s seam: A\'s manifest owner ∈ otherPids(B), ∉ otherPids(A)',
    manifestOwner !== undefined && pidsForB.has(manifestOwner) && !pidsForA.has(manifestOwner),
    `owner=${manifestOwner} B=${[...pidsForB].join('/')} A=${[...pidsForA].join('/')}`,
  )

  // THE B CHECKS ARE DONE inside the hold's window: the run must still be
  // held open here; the Sleep then returns on its own, the agent says done,
  // the run settles and the roster follows (the completed row stands until
  // the runner evicts it).
  check('P5 the run is still held open after the B checks (running, named — the Sleep stands)', rowsA().some(r => r.kind === 'workflow' && r.status === 'running' && r.name === 'scope-probe'), JSON.stringify({ rows: rowsA(), hold: holdLedger() }))
  check(
    'P5 the run settles on A\'s roster',
    await untilAsync(() => rowsA().some(r => r.kind === 'workflow' && r.status !== 'running' && r.status !== 'pending'), 90_000),
    JSON.stringify(rowsA()),
  )
  check(
    'P5 the hold RETURNED through the tool (the Sleep result carries slept_seconds — a denial or a missing tool would read here verbatim)',
    await untilAsync(() => holdLedger().results.some(t => t.includes('slept_seconds')), 30_000),
    JSON.stringify(holdLedger()),
  )
  check('P5 B\'s roster is STILL empty after A\'s run', connB.workRoster().rows.length === 0, JSON.stringify(connB.workRoster().rows))

  // THE SUBAGENT LEG (item 3): a background helper dispatched in A's
  // runner registers an agent task there — the row rides A's roster
  // (nested spawns land in the same store and ride the same road) and
  // never B's.
  // The helper turn runs on its OWN family (an idle setModel applies now),
  // so its gated rows can never be eaten by A's completion-notification
  // turn — gated rows outrank catch-alls per matching request.
  const switched = await connA.setModel('claude-haiku-4-5')
  check('P5 the model switch applies while idle', switched.state === 'applied' || switched.state === 'queued', JSON.stringify(switched))
  const sentAgent = await connA.sendWords('dispatch a background helper')
  check('P5 the helper words deliver', sentAgent.state === 'accepted' || sentAgent.state === 'queued', JSON.stringify(sentAgent))
  check(
    'P5 the helper\'s agent row rides A\'s roster',
    await untilAsync(() => rowsA().some(r => r.kind === 'agent'), 60_000),
    JSON.stringify(rowsA()),
  )
  check('P5 B\'s roster still carries no agent row (subagents scoped)', connB.workRoster().rows.length === 0, JSON.stringify(connB.workRoster().rows))

  // B is a live session of its own (its runner answered its turn) — the
  // empty roster is scoping, not deadness. B may land in a worktree of the
  // shared repo (the isolation law), so its transcript is found by session
  // id across the projects root.
  const transcriptB = (): string | null => {
    const root = join(home, 'projects')
    if (!existsSync(root)) return null
    for (const entry of readdirSync(root)) {
      const candidate = join(root, entry, `${B.sessionId}.jsonl`)
      if (existsSync(candidate)) return candidate
    }
    return null
  }
  check('P5 B answered its own turn (empty = scoped, not dead)', await untilAsync(() => {
    const p = transcriptB()
    return p !== null && readFileSync(p, 'utf8').includes('"kind":"output"')
  }, 60_000))
} finally {
  try {
    await (await import('../../src/daemon/controlSocket.ts')).daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
  } catch {
    /* already down */
  }
  daemon.kill('SIGTERM')
  await wait(500)
  // Exact-pid reaping: no prover child outlives the proof.
  for (const pid of workerPids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
  try {
    daemon.kill('SIGKILL')
  } catch {
    /* already gone */
  }
  await api.close()
  // A red run keeps its scratch (the daemon log, the transcripts, the run
  // manifests) for the reader — the evidence of WHY is in there, and a
  // removed scratch has already cost one blind round.
  if (process.env.WORKSCOPE_KEEP === '1' || failures > 0) console.log(`[keep] ${SCRATCH}`)
  else rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-work-scope: ALL LAWS HOLD' : `\nprove-work-scope: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
