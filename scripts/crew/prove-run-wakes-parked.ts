import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { DIST, MODEL, NODE, argAfter, bound, childEnv, makeTally } from '../daemon/dupline-world.ts'
import { findFiles } from './crew-world.ts'
import { seedScratchHome, startScriptedFixture, type ScriptedRequest, type WireBlock } from '../lib/scriptedTurn.ts'
import { startFixtureApi, isHandoffRequest } from '../lib/fixtureApi.ts'
import { endProcessGroup, spawnInOwnGroup } from '../lib/processGroup.ts'

const { Database } = createRequire(import.meta.url)('bun:sqlite')
const tally = makeTally('prove-run-wakes-parked')
const scratch = process.env.MERCURY_CONFIG_DIR
assert(scratch, 'run with a scratch MERCURY_CONFIG_DIR')
assert(existsSync(DIST), `build first or pass --dist: ${DIST}`)
if (process.env.RUN_WAKE_PROOF_HOME === undefined) {
  const own = mkdtempSync(join(scratch, 'run-wake-home-'))
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, HOME: own, USERPROFILE: own, RUN_WAKE_PROOF_HOME: own } })
  rmSync(own, { recursive: true, force: true })
  process.exit(child.status ?? 1)
}
assert.equal(homedir(), process.env.RUN_WAKE_PROOF_HOME, 'the proof loads the product under its own scratch home')
const root = mkdtempSync(join(scratch, 'run-wakes-'))
const record = argAfter('--record')
const text = (words: string): WireBlock[] => [{ type: 'text', text: words }]
const tool = (name: string, input: Record<string, unknown>): WireBlock[] => [{ type: 'tool_use', name, input }]
const post = (id: string, words: string): WireBlock[] => tool('CrewBoard', { op: 'post', clientOpId: id, kind: 'result', text: words })
const launch = (name: string, extra: Record<string, unknown> = {}): WireBlock[] => tool('Crewmate', { description: `${name} run wake fixture`, name, team: 'research', prompt: `RUN-WAKE-${name}`, crewmate_type: 'mercury-crew', run_in_background: true, ...extra })

async function run(dist: string, home: string, cwd: string, base: string, extra: string[] = []) {
  const env = { ...childEnv(home, Number(new URL(base).port)), HOME: home, USERPROFILE: home }
  execFileSync(NODE, ['-e', "require('node:assert/strict').equal(require('node:os').homedir(), process.env.HOME)"], { cwd, env, stdio: 'pipe' })
  const child = spawnInOwnGroup(NODE, [dist, 'run', '--model', MODEL, '--sovereign', '--format', 'json', ...extra, '-'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = '', stderr = '', expired = false
  const timer = setTimeout(() => { expired = true; endProcessGroup(child) }, bound(60_000))
  child.stdout!.on('data', chunk => { stdout += chunk })
  child.stderr!.on('data', chunk => { stderr += chunk })
  child.stdin!.end('RUN-WAKE-main')
  const code = await new Promise<number | null>((resolve, reject) => { child.on('close', resolve); child.on('error', reject) })
  clearTimeout(timer)
  const outcome = stdout.trim().split('\n').flatMap(line => { try { return [JSON.parse(line) as Record<string, unknown>] } catch { return [] } }).findLast(row => row.type === 'outcome')
  return { code, outcome, expired, stdout, stderr }
}

async function journey(kind: 'captain' | 'held' | 'deadline'): Promise<void> {
  tally.section(kind)
  const world = join(root, kind), home = join(world, 'home'), cwd = join(world, 'work')
  seedScratchHome(home, cwd)
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ swarm: { enabled: true } }))
  if (kind === 'held') {
    writeFileSync(join(cwd, 'README.md'), '# fixture\n')
    execFileSync('git', ['init', cwd], { stdio: 'pipe' })
    execFileSync('git', ['-C', cwd, 'add', 'README.md'], { stdio: 'pipe' })
    execFileSync('git', ['-C', cwd, 'commit', '-m', 'fixture'], { stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } })
  }
  let captainStarted = false, posterStarted = false, serial = 0, captainCalls = 0, posterCalls = 0
  let moved: { from: string; to: string } | undefined
  const session = randomUUID()
  const board = (): string | undefined => findFiles(home, 'board.sqlite').find(path => path.includes(session))
  const moveWorktree = (): void => {
    const path = board()!
    const db = new Database(path, { readonly: true })
    const captain = db.query("SELECT agent FROM members WHERE name = 'captain'").get() as { agent: string }
    db.close()
    const metaFile = findFiles(home, `agent-${captain.agent}.meta.json`)[0]
    assert(metaFile, 'captain metadata is recorded before its completion notice')
    const metadata = JSON.parse(readFileSync(metaFile, 'utf8'))
    assert(typeof metadata.worktreePath === 'string')
    const within = relative(cwd, metadata.worktreePath)
    assert(within && !within.startsWith('..'))
    moved = { from: metadata.worktreePath, to: `${metadata.worktreePath}.away` }
    renameSync(moved.from, moved.to)
  }
  const isCaptain = (req: ScriptedRequest): boolean => req.opening.trim() === 'RUN-WAKE-captain'
  const isPoster = (req: ScriptedRequest): boolean => req.opening.trim() === 'RUN-WAKE-poster'
  const fixture = await startScriptedFixture(req => {
    if (isCaptain(req)) {
      const call = captainCalls++
      if (call < 2) return call === 0 ? post('captain-ready', '@main CAPTAIN-READY') : text('CAPTAIN-PARKED')
      if (call % 2 === 1) return text('CAPTAIN-RESUMED')
      return kind === 'deadline' ? post(`captain-ping-${++serial}`, '@poster PING-poster') : post('captain-final', '@main CAPTAIN-REPORT')
    }
    if (isPoster(req)) {
      const call = posterCalls++
      if (kind === 'held') {
        if (call === 0) return tool('CrewBoard', { op: 'read' })
        if (call === 1) { moveWorktree(); return post('poster-result', '@captain POSTER-RESULT') }
        return text('POSTER-PARKED')
      }
      if (call % 2 === 1) return text('POSTER-PARKED')
      return call === 0 ? post('poster-result', '@captain POSTER-RESULT') : post(`poster-ping-${++serial}`, '@captain PING-captain')
    }
    if (req.allTexts.some(t => t.includes('The board resume did not start:'))) return text('LEAD-HELD-NOTED')
    if (req.allTexts.some(t => t.includes('CAPTAIN-REPORT'))) return text('LEAD-FINAL-ANSWER')
    if (!captainStarted) {
      captainStarted = true
      if (kind === 'held') { posterStarted = true; return [...launch('captain', { captain: true, isolation: 'worktree' }), ...launch('poster')] }
      return launch('captain', { captain: true })
    }
    if (!posterStarted && req.ask.includes('<task-notification>') && req.ask.includes('CAPTAIN-PARKED')) {
      posterStarted = true
      return launch('poster')
    }
    return text('LEAD-WAITING')
  }, { answerDelayMs: req => {
    if (kind === 'held' && isPoster(req) && posterCalls === 1) return 3000
    if (isCaptain(req)) return captainCalls % 2 === 1 ? 600 : 0
    if (isPoster(req)) return posterCalls % 2 === 1 ? 600 : 0
    return 0
  } })
  try {
    const result = await run(DIST, home, cwd, fixture.base, ['--session-id', session, ...(kind === 'deadline' ? ['--max-time', '30s'] : [])])
    const path = board()
    assert(path, `board was created: ${result.stderr}`)
    const db = new Database(path, { readonly: true })
    try {
      const captain = db.query("SELECT agent FROM members WHERE name = 'captain'").get() as { agent: string } | null
      const dispatches = Number((db.query('SELECT COUNT(*) AS n FROM wake_dispatches').get() as { n: number }).n)
      const claims = db.query('SELECT state FROM wake_claims').all() as { state: string }[]
      const events = db.query('SELECT record FROM events ORDER BY seq').all()
      tally.check(`${kind}: the one-shot lead launched both seats and the captain parked`, captainStarted && posterStarted && fixture.requests.some(req => isCaptain(req) && req.step > 0), JSON.stringify(result))
      tally.check(`${kind}: the run exits without the proof killing it`, !result.expired, result.stderr)
      if (kind === 'captain') {
        tally.check('the pending wake resumed the captain exactly once', dispatches === 1, `dispatches=${dispatches}`)
        tally.check('the resumed request retained the captain transcript and triggering post', fixture.requests.some(req => isCaptain(req) && req.allTexts.some(t => t.includes('POSTER-RESULT'))))
        tally.check('the lead receives the captain post in a later turn', fixture.requests.some(req => !isCaptain(req) && !isPoster(req) && req.allTexts.some(t => t.includes('CAPTAIN-REPORT'))))
        tally.check('the final JSON answer is the lead last words, completed with exit zero', result.code === 0 && result.outcome?.status === 'completed' && result.outcome?.answer === 'LEAD-FINAL-ANSWER', JSON.stringify(result.outcome))
      } else if (kind === 'held') {
        tally.check('the missing worktree holds the wake without starting another captain', claims.some(claim => claim.state === 'held') && dispatches === 0 && !fixture.requests.some(req => isCaptain(req) && req.allTexts.some(t => t.includes('POSTER-RESULT'))), JSON.stringify(claims))
        tally.check('the lead is told of the held wake before the run completes', result.code === 0 && result.outcome?.status === 'completed' && result.outcome?.answer === 'LEAD-HELD-NOTED', JSON.stringify(result.outcome))
      } else {
        tally.check('the seats wake one another repeatedly before the deadline', dispatches >= 3, `dispatches=${dispatches}`)
        tally.check('max-time cuts the wake chain and returns its ordinary outcome', result.code === 1 && result.outcome?.status === 'time_limit', JSON.stringify(result.outcome))
      }
      if (record) writeFileSync(join(record, `${kind}.json`), JSON.stringify({ ...result, requests: fixture.requests, dispatches, claims, events }, null, 2))
    } finally { db.close() }
  } finally {
    if (moved && existsSync(moved.to)) renameSync(moved.to, moved.from)
    await fixture.close()
  }
}

async function ordinary(): Promise<void> {
  tally.section('no parked seats')
  const reference = argAfter('--reference') ?? DIST
  const home = join(root, 'ordinary-home'), cwd = join(root, 'ordinary-work')
  const fixture = await startFixtureApi(Array.from({ length: 4 }, () => ({ kind: 'text' as const, text: 'ORDINARY-FINAL' })))
  const readings: { on: boolean; dist: string; result: Awaited<ReturnType<typeof run>>; bodies: unknown[] }[] = []
  try {
    const sessionId = randomUUID()
    for (const on of [false, true]) for (const dist of [reference, DIST]) {
      seedScratchHome(home, cwd)
      writeFileSync(join(home, 'settings.json'), JSON.stringify({ swarm: { enabled: on } }))
      const before = fixture.messageRequests().length
      const result = await run(dist, home, cwd, fixture.url, ['--session-id', sessionId])
      const bodies = fixture.messageRequests().slice(before).filter(req => !isHandoffRequest(req)).map(req => req.body)
      readings.push({ on, dist, result, bodies })
      tally.check(`ordinary swarm ${on ? 'on' : 'off'} ${dist === reference ? 'reference' : 'tip'}: one request, answer and exit`, bodies.length === 1 && result.code === 0 && result.outcome?.status === 'completed' && result.outcome?.answer === 'ORDINARY-FINAL', JSON.stringify(result))
    }
    for (const on of [false, true]) {
      const [before, after] = readings.filter(reading => reading.on === on)
      tally.check(`ordinary swarm ${on ? 'on' : 'off'}: the complete request is byte-identical`, JSON.stringify(before!.bodies) === JSON.stringify(after!.bodies))
      const stable = (outcome: Record<string, unknown> | undefined): unknown => Object.fromEntries(Object.entries(outcome ?? {}).filter(([key]) => !['turn_id', 'timestamp', 'wall_ms', 'api_ms'].includes(key)))
      tally.check(`ordinary swarm ${on ? 'on' : 'off'}: the outcome row is unchanged apart from its clock and turn id`, JSON.stringify(stable(before!.result.outcome)) === JSON.stringify(stable(after!.result.outcome)))
    }
    if (record) writeFileSync(join(record, 'ordinary.json'), JSON.stringify(readings, null, 2))
  } finally { await fixture.close() }
}

async function pendingLiveness(): Promise<void> {
  tally.section('dispatch liveness between board and task state')
  const source = join(dirname(DIST), '..', 'src')
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  const boot = await import(join(source, 'bootstrap/state.ts'))
  boot.setOriginalCwd(root); boot.setCwdState(root); boot.setProjectRoot(root)
  const { enableConfigs } = await import(join(source, 'utils/config/globalConfig.ts'))
  enableConfigs()
  const { updateSettingsForSource } = await import(join(source, 'utils/settings/settings.ts'))
  updateSettingsForSource('userSettings', { swarm: { enabled: true } })
  const seam = await import(join(source, 'services/crewBoard/seam.ts'))
  const { BoardResumeDirectoryError } = await import(join(source, 'tools/AgentTool/resumeAgent.ts'))
  const { flushSessionStorage } = await import(join(source, 'utils/sessionStorage/writer.ts'))
  const { getCommandQueue, dequeue, peek } = await import(join(source, 'input-core/command-queue.ts'))
  const { createTurnDriver } = await import(join(source, 'cli/headless/turnDriver.ts'))
  const { runSwarmCommand } = await import(join(source, 'commands/swarm/swarm.ts'))
  assert(runSwarmCommand('on').startsWith('Swarm on'))
  await seam.latchSwarmAgent('target', 'Target')
  await seam.latchSwarmAgent('poster', 'Poster')
  const board = seam.swarmStore()!
  const target = seam.swarmPrincipal('target')!, poster = seam.swarmPrincipal('poster')!
  const tasks = { target: { type: 'local_agent', id: 'target', agentId: 'target', status: 'running' } }
  const context = { getAppState: () => ({ tasks }), options: {}, abortController: new AbortController() }
  let resumed = 0
  let entered!: () => void, release!: () => void
  const admission = new Promise<void>(resolve => { entered = resolve })
  const finish = new Promise<void>(resolve => { release = resolve })
  const watcher = seam.watchSwarmResumes(() => context, async () => ({ behavior: 'allow', updatedInput: {} }), () => true, async () => {
    resumed++
    entered()
    await finish
    throw new BoardResumeDirectoryError(join(root, 'absent-worktree'), 'worktree')
  })
  const pending = (): boolean => watcher.hasPending?.() === true
  try {
    tally.check('the dispatcher exposes liveness without keeping an empty board alive', typeof watcher.hasPending === 'function' && !pending())
    assert(board.post(target, { clientOpId: 'wait', kind: 'ask', text: '@main wake me when kind result' }).ok)
    assert(board.post(poster, { clientOpId: 'trigger', kind: 'result', text: 'PENDING-WAKE' }).ok)
    seam.settleSwarmAgent('target')
    seam.mirrorSwarmNotice('target', 'completed', 'Target completed', 'completed')
    await flushSessionStorage()
    await new Promise<void>(resolve => setImmediate(resolve))
    tally.check('a task still running is not resumed beside itself', resumed === 0 && board.pendingWakes().length === 1)
    tasks.target.status = 'completed'
    runSwarmCommand('off')
    tally.check('turning the swarm off leaves its undeliverable pending wake out of run liveness', !pending())
    runSwarmCommand('on')
    const waiting = pending()
    tally.check('a completion without another board event makes the pending wake live and retries it', waiting)
    if (waiting) await admission
    tally.check('a reserved asynchronous admission remains live after leaving pendingWakes', waiting && pending() && board.pendingWakes().length === 0 && resumed === 1)
    let heldQuiet = false, told = false
    if (waiting) {
      let closed!: () => void
      const ended = new Promise<void>(resolve => { closed = resolve })
      const driver = createTurnDriver({
        dequeue: () => dequeue(), dequeueCommand: command => dequeue((queued: unknown) => queued === command), peek: () => peek(),
        notifyLifecycle: () => {}, enqueueOutput: () => {}, writeDirect: async () => {}, drainRows: () => [],
        beforeCycle: async () => {}, onTurnStart: () => {}, turnIdOf: () => 'held-turn',
        openTurnRow: () => ({ type: 'turn', schema: 1, session_id: 'held-session', state: 'started', turn_id: 'held-turn', message_ids: [] }),
        executeTurn: async () => { told = board.boundary(seam.swarmPrincipal(), new Set())?.text.includes('The board resume did not start:') === true },
        onTurnSettled: () => {}, hasWaitableBackgroundTasks: pending, hasHoldableBackgroundAgents: () => false,
        settleIdle: async () => 'close', closeOutput: async () => { closed() }, isShuttingDown: () => false,
        idleTimerStop: () => {}, idleTimerStart: () => {}, onCycleError: error => { throw error }, shutdown: () => { closed() },
        clock: { sleep: async () => {
          release()
          await new Promise<void>(resolve => setImmediate(resolve))
          heldQuiet = !pending() && board.pendingWakes().length === 0 && board.seats().find((seat: { agent: string }) => seat.agent === 'target')?.wakeProblem?.kind === 'worktree-missing' && getCommandQueue().some((command: { mode: string }) => command.mode === 'task-notification')
        } },
      } satisfies import('../../src/cli/headless/turnDriver.ts').TurnDriverPorts)
      driver.kick()
      await ended
    }
    tally.check('a held admission ceases to keep the run alive and queues the existing lead notice', heldQuiet)
    tally.check('with no running task the driver takes the held notice before closing output', told)
  } finally {
    release()
    watcher.stop()
    runSwarmCommand('off')
    seam.settleSwarmAgent('poster'); seam.settleSwarmAgent('target')
  }
}

try {
  await journey('captain')
  await journey('held')
  await journey('deadline')
  await ordinary()
  await pendingLiveness()
} finally { rmSync(root, { recursive: true, force: true }) }
tally.finish()
