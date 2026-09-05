#!/usr/bin/env bun
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

const guardPids = new Set<number>()
const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — proof exceeded 240s')
  for (const pid of guardPids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
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
    }
    await wait(150)
  }
  return false
}

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
  check(
    'P1 the workflow row speaks its pulse (the runner\'s own fold: one in flight, one settled, the newest signal floored at the start)',
    wf?.pulse !== undefined && wf.pulse.running === 1 && wf.pulse.settled === 1 && wf.pulse.maxAttempt === 0 && wf.pulse.lastEventAt === t0 && wf.pulse.phaseTitle === 'Probe',
    JSON.stringify(wf?.pulse),
  )
  const tm = rows.find(r => r.id === 'tm1')
  check('P1 the teammate row names its team', tm?.kind === 'teammate' && tm.name === 'scout' && tm.team === 'crew')

  const { focusedWorkRows, runningWorkflowRows } = await import('../../src/components/tasks/useFocusedWork.ts')
  const hosted = {
    rows: [
      { id: 'wf1', kind: 'workflow', name: 'a stale copy of the local row', status: 'completed', startTime: t0 },
      { id: 'wf9', kind: 'workflow', name: 'hosted-run', status: 'running', startTime: t0 + 9, workflowRunId: 'run-9' },
      { id: 'wf8', kind: 'workflow', name: 'hosted-paused', status: 'paused', startTime: t0 + 8, workflowRunId: 'run-8' },
      { id: 'sh9', kind: 'shell', name: 'sleep 9', status: 'running', startTime: t0 + 7 },
    ],
    mission: [],
  } as const
  const union = focusedWorkRows(store, hosted as never)
  check('P6 the union carries every local row and every hosted row once', union.length === 4 + 3, JSON.stringify(union.map(r => r.id)))
  check('P6 a row held locally keeps its local projection (the hosted copy never wins)', union.find(r => r.id === 'wf1')?.name === 'scope-probe' && union.find(r => r.id === 'wf1')?.status === 'running')
  check('P6 the running workflows are the local run and the hosted run — never the paused one, never the shell', runningWorkflowRows(union).map(r => r.id).sort().join(',') === 'wf1,wf9')
  check('P6 a blank store still lists the hosted rows', focusedWorkRows(undefined, hosted as never).length === 4)
  const sh = rows.find(r => r.id === 'sh1')
  check('P1 the shell row keeps its settle time', sh?.kind === 'shell' && sh.endTime === t0 + 5 && sh.status === 'completed')
  check('P1 newest first, stable', rows[0]!.id === 'sh1' && rows[rows.length - 1]!.id === 'wf1')
}

section('P2 the wire: `work` rides the facts; an old answer still validates')
const proj = await import('../../src/services/engine-connector/seatProjections.ts')
const SID_A = '00000000-0000-4000-8000-00000000000a'
const SID_B = '00000000-0000-4000-8000-00000000000b'
const SID_C = '00000000-0000-4000-8000-00000000000c'
const SID_D = '00000000-0000-4000-8000-00000000000d'
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
  check('P3 A\'s reported roster carries no unreported flag (the rows are the runner\'s word)', a.workRoster().reported !== false)
  check('P3 B (no facts file yet) reads as UNREPORTED — nothing the runner said', b.workRoster().reported === false && b.workRoster().rows.length === 0, JSON.stringify(b.workRoster()))
  proj.publishSessionFacts({ schema: 1, sessionId: SID_C, atMs: Date.now(), pendingModel: null, busy: false, ...baseAnswer })
  check('P3 the skeleton-shaped answer landed on disk before the read', await untilAsync(() => proj.readSessionFacts(SID_C) !== null, 5_000))
  const c = seat.daemonSessionConnectorFor(recordOf(SID_C, 'C'))
  check('P3 a facts answer with NO work reads as UNREPORTED (reported: false), rows empty', c.workRoster().reported === false && c.workRoster().rows.length === 0, JSON.stringify(c.workRoster()))
  proj.publishSessionFacts({ schema: 1, sessionId: SID_D, atMs: Date.now(), pendingModel: null, busy: false, ...baseAnswer, work: [] })
  check('P3 the empty-work answer landed on disk before the read', await untilAsync(() => proj.readSessionFacts(SID_D)?.work !== undefined, 5_000))
  const d = seat.daemonSessionConnectorFor(recordOf(SID_D, 'D'))
  check('P3 a facts answer with an EMPTY work list reads as reported (the runner said nothing runs)', d.workRoster().reported !== false && d.workRoster().rows.length === 0, JSON.stringify(d.workRoster()))
  check('P3 the snapshot is stable between changes (the uSES law)', a.workRoster() === a.workRoster())

  await seat.focusDaemonSession(recordOf(SID_A, 'A'))
  const focusedRows = (): readonly { name: string }[] => slot.getFocusedSessionConnector().workRoster().rows
  check('P4 focus A → the focused roster carries A\'s workflow', focusedRows().some(r => r.name === 'scope-probe'))
  let workPings = 0
  const composed = slot.subscribeThroughFocused((c, l) => c.subscribeWork(l))
  const offComposed = composed(() => workPings++)
  await seat.focusDaemonSession(recordOf(SID_B, 'B'))
  check('P4 hop to B → ZERO of A\'s rows (the operator\'s sentence)', focusedRows().length === 0)
  check('P4 the composed feed heard the hop', workPings > 0, `pings=${workPings}`)

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

  proj.publishSessionFacts({
    schema: 1, sessionId: SID_A, atMs: Date.now(), pendingModel: null, busy: false, ...baseAnswer,
    work: [settledRow],
    mission: [{ id: '1', subject: 'audit the fixtures', activeForm: 'Auditing the fixtures', status: 'in_progress' }],
  })
  check('P3 the mission ledger rides the work snapshot', await untilAsync(() => a.workRoster().mission.length === 1 && a.workRoster().mission[0]?.status === 'in_progress', 5_000))

  proj.retireSeatProjections(SID_A)
  check('P3 a retired facts file empties the roster', await untilAsync(() => a.workRoster().rows.length === 0 && a.workRoster().mission.length === 0, 6_000))
  offA()
  offComposed()

  const { NoSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.ts')
  const blank = new NoSessionConnector()
  check('P3 the resting slot (no chat open) answers the stable honest empty', blank.workRoster().rows.length === 0 && blank.workRoster() === blank.workRoster())
  check('P3 the resting slot\'s empty is reported (no session runs nothing — not an unreported runner)', blank.workRoster().reported !== false)
  slot._resetFocusedSessionConnectorForTesting()
}

section('P5 end-to-end: two sessions, one workspace — A\'s run paints, B stays empty')
proj.resetSeatProjections()
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(home, [work])
const { writeFileSync } = await import('node:fs')
writeFileSync(join(home, 'settings.json'), JSON.stringify({ permissions: { allow: ['Workflow', 'Agent', 'Task'] } }))
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
  "const a = await agent('hold the probe open for a while, then reply with the word done', { model: 'claude-opus-5' })",
  'return { a }',
].join('\n')

const HOLD_SECONDS = 40

const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const api = await startFixtureApi([
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
    MERCURY_TOOL_SEARCH: '0',
  },
  stdio: ['ignore', logFd, logFd],
})
if (daemon.pid !== undefined) guardPids.add(daemon.pid)
const workerPids: number[] = []
try {
  const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
  const { clientVersionFacts } = await import('../../src/daemon/handshake.ts')
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

  const grant = (await daemonControlRpc({ op: 'concourseControl', action: 'grant-workflows', sessionId: A.sessionId, by: 'operator' } as never)) as { ok?: boolean }
  check('P5 the workflows-allowed tag grants', grant.ok === true, JSON.stringify(grant))

  check(
    'P5 A\'s live workflow paints on A\'s connector (running, named)',
    await untilAsync(() => rowsA().some(r => r.kind === 'workflow' && r.status === 'running' && r.name === 'scope-probe'), 90_000),
    JSON.stringify(rowsA()),
  )
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
  check(
    'P5 the run\'s agents reach the roster while it runs',
    await untilAsync(() => rowsA().some(r => r.kind === 'workflow' && (r.phases ?? []).some(p => p.agents.length > 0)), 60_000),
    JSON.stringify(rowsA()),
  )

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
  }
  daemon.kill('SIGTERM')
  await wait(500)
  for (const pid of workerPids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
    }
  }
  try {
    daemon.kill('SIGKILL')
  } catch {
  }
  await api.close()
  if (process.env.WORKSCOPE_KEEP === '1' || failures > 0) console.log(`[keep] ${SCRATCH}`)
  else rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-work-scope: ALL LAWS HOLD' : `\nprove-work-scope: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
