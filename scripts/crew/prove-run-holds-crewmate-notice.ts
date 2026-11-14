import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DIST, MODEL, NODE, bound, childEnv, makeTally } from '../daemon/dupline-world.ts'
import { seedScratchHome, startScriptedFixture, type ScriptedRequest, type WireBlock } from '../lib/scriptedTurn.ts'
import { endProcessGroup, spawnInOwnGroup } from '../lib/processGroup.ts'

const scratch = process.env.MERCURY_CONFIG_DIR
assert(scratch, 'run with a scratch MERCURY_CONFIG_DIR')
assert(existsSync(DIST), `build first or pass --dist: ${DIST}`)
if (process.env.RUN_NOTICE_PROOF_HOME === undefined) {
  const own = mkdtempSync(join(scratch, 'run-notice-home-'))
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, HOME: own, USERPROFILE: own, RUN_NOTICE_PROOF_HOME: own } })
  rmSync(own, { recursive: true, force: true })
  process.exit(child.status ?? 1)
}
assert.equal(homedir(), process.env.RUN_NOTICE_PROOF_HOME, 'the proof loads the product under its own scratch home')

const tally = makeTally('prove-run-holds-crewmate-notice')
const root = mkdtempSync(join(scratch, 'run-notice-'))
const text = (words: string): WireBlock[] => [{ type: 'text', text: words }]

async function endings(): Promise<void> {
  const source = join(dirname(DIST), '..', 'src')
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  const boot = await import(join(source, 'bootstrap/state.ts'))
  boot.setOriginalCwd(root); boot.setCwdState(root); boot.setProjectRoot(root)
  const { enableConfigs } = await import(join(source, 'utils/config/globalConfig.ts'))
  enableConfigs()
  const { getDefaultAppState } = await import(join(source, 'state/AppStateStore.ts'))
  const { getCommandQueue, resetCommandQueue } = await import(join(source, 'input-core/command-queue.ts'))
  const { registerAsyncAgent } = await import(join(source, 'tasks/LocalAgentTask/LocalAgentTask.tsx'))
  const { createAssistantMessage } = await import(join(source, 'utils/messages/factories.ts'))
  const { AbortError } = await import(join(source, 'utils/errors.ts'))
  const lifecycle = await import(join(source, 'tools/AgentTool/agentToolUtils.ts'))
  const { resumeAgentBackground } = await import(join(source, 'tools/AgentTool/resumeAgent.ts'))
  type AppState = ReturnType<typeof getDefaultAppState>
  const owed = (): boolean => lifecycle.crewmateNoticeOwed?.() === true
  const notes = (): string[] => getCommandQueue().filter((command: { mode: string }) => command.mode === 'task-notification').map((command: { value: unknown }) => String(command.value))
  let serial = 0
  const world = (kind: string) => {
    resetCommandQueue()
    let state = getDefaultAppState()
    const set = (update: (before: AppState) => AppState): void => { state = update(state) }
    const taskId = `a${String(++serial).padStart(8, '0')}`
    const task = registerAsyncAgent({ agentId: taskId, description: kind, prompt: 'work', setAppState: set })
    const context = { getAppState: () => state, setAppState: set, setAppStateForTasks: set, options: { tools: [] }, abortController: new AbortController(), messages: [] } as never
    const run = (stream: () => AsyncGenerator<unknown, void>, getWorktreeResult: () => Promise<Record<string, never>>): Promise<void> =>
      lifecycle.runAsyncAgentLifecycle({ taskId, abortController: task.abortController!, makeStream: stream, metadata: { prompt: 'work', resolvedAgentModel: 'fixture', isBuiltInAgent: false, startTime: Date.now(), agentType: 'mercury-crew', isAsync: true }, description: kind, toolUseContext: context, rootSetAppState: set, agentIdForCleanup: taskId, enableSummarization: false, getWorktreeResult })
    return { taskId, controller: task.abortController as AbortController, context, run, status: (): string | undefined => state.tasks[taskId]?.status }
  }

  for (const kind of ['completed', 'failed', 'stopped'] as const) {
    tally.section(`a crewmate that ends ${kind}: between the end of its task and its notice`)
    const seat = world(kind)
    let reached!: () => void, release!: () => void
    const held = new Promise<void>(resolve => { reached = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    async function* stream(): AsyncGenerator<unknown, void> {
      yield createAssistantMessage({ content: 'CREW-WORDS' })
      if (kind === 'failed') throw new Error('PROVIDER-DOWN')
      if (kind === 'stopped') { seat.controller.abort(); throw new AbortError('stopped') }
    }
    const done = seat.run(stream, async () => { reached(); await gate; return {} })
    await held
    tally.check(`${kind}: the task no longer runs and no notice is queued yet`, seat.status() !== undefined && seat.status() !== 'running' && notes().length === 0, `status=${seat.status()} notes=${notes().length}`)
    tally.check(`${kind}: the lifecycle owes the lead its notice`, owed())
    release()
    await done
    tally.check(`${kind}: the notice is queued and nothing is owed`, notes().length === 1 && notes()[0]!.includes('CREW-WORDS') && !owed(), `notes=${notes().length} owed=${owed()}`)
  }

  tally.section('a lifecycle that cannot reach its notice leaves nothing owed')
  {
    const seat = world('thrown')
    let reached!: () => void, release!: () => void
    const held = new Promise<void>(resolve => { reached = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    async function* stream(): AsyncGenerator<unknown, void> { yield createAssistantMessage({ content: 'CREW-WORDS' }) }
    const done = seat.run(stream, async () => { reached(); await gate; throw new Error('WORKTREE-UNREADABLE') }).then(() => 'settled', () => 'threw')
    await held
    tally.check('while the lifecycle is held between its end and its notice it owes one', owed() && seat.status() === 'completed')
    release()
    const ended = await done
    tally.check('a throw between the end and the notice ends the lifecycle with no notice and nothing owed', ended === 'threw' && notes().length === 0 && !owed(), `ended=${ended} notes=${notes().length} owed=${owed()}`)
    const refused = await resumeAgentBackground({ agentId: 'a99999999', prompt: 'RESUME', toolUseContext: seat.context }).then(() => 'resumed', () => 'refused')
    tally.check('a resume that is refused starts no lifecycle and owes nothing', refused === 'refused' && !owed(), refused)
  }
}

async function run(home: string, cwd: string, base: string, path: string) {
  const env = { ...childEnv(home, Number(new URL(base).port)), HOME: home, USERPROFILE: home, PATH: path }
  const child = spawnInOwnGroup(NODE, [DIST, 'run', '--model', MODEL, '--sovereign', '--format', 'json', '-'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = '', stderr = '', expired = false
  const timer = setTimeout(() => { expired = true; endProcessGroup(child) }, bound(60_000))
  child.stdout!.on('data', chunk => { stdout += chunk })
  child.stderr!.on('data', chunk => { stderr += chunk })
  child.stdin!.end('RUN-NOTICE-main')
  const code = await new Promise<number | null>((resolve, reject) => { child.on('close', resolve); child.on('error', reject) })
  clearTimeout(timer)
  const outcome = stdout.trim().split('\n').flatMap(line => { try { return [JSON.parse(line) as Record<string, unknown>] } catch { return [] } }).findLast(row => row.type === 'outcome')
  return { code, outcome, expired, stderr }
}

async function journey(isolation: boolean): Promise<void> {
  const label = isolation ? 'a crewmate in its own worktree' : 'a crewmate in the lead’s directory'
  tally.section(`a one-shot run whose last crewmate is ${label}`)
  const world = join(root, isolation ? 'worktree' : 'plain'), home = join(world, 'home'), cwd = join(world, 'work')
  seedScratchHome(home, cwd)
  writeFileSync(join(cwd, 'README.md'), '# fixture\n')
  const identity = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }
  execFileSync('git', ['init', cwd], { stdio: 'pipe' })
  execFileSync('git', ['-C', cwd, 'add', 'README.md'], { stdio: 'pipe' })
  execFileSync('git', ['-C', cwd, 'commit', '-m', 'fixture'], { stdio: 'pipe', env: identity })
  let path = process.env.PATH ?? ''
  if (process.platform !== 'win32') {
    const slow = join(world, 'slow-git')
    mkdirSync(slow, { recursive: true })
    writeFileSync(join(slow, 'git'), `#!/bin/sh\ncase " $* " in *" worktree unlock "*) sleep 2 ;; esac\nPATH='${path.replaceAll("'", `'\\''`)}' exec git "$@"\n`)
    chmodSync(join(slow, 'git'), 0o755)
    path = `${slow}${delimiter}${path}`
  }
  let launched = false
  const isCrew = (req: ScriptedRequest): boolean => req.opening.trim() === 'RUN-NOTICE-crew'
  const fixture = await startScriptedFixture(req => {
    if (isCrew(req)) return text('CREW-RESULT')
    if (req.allTexts.some(words => words.includes('CREW-RESULT'))) return text('LEAD-SAW-RESULT')
    if (!launched) {
      launched = true
      return [{ type: 'tool_use', name: 'Crewmate', input: { description: 'notice fixture', prompt: 'RUN-NOTICE-crew', crewmate_type: 'mercury-crew', run_in_background: true, ...(isolation ? { isolation: 'worktree' } : {}) } }]
    }
    return text('LEAD-WAITING')
  }, { answerDelayMs: req => isCrew(req) ? 4000 : 0 })
  try {
    const result = await run(home, cwd, fixture.base, path)
    tally.check('the lead’s first turn ended before the crewmate did, and the run ended by itself', fixture.requests.some(isCrew) && fixture.requests.some(req => !isCrew(req) && req.step > 0) && !result.expired, result.stderr.slice(-600))
    tally.check('the lead is given the crewmate’s result and its last words are the answer', fixture.requests.some(req => !isCrew(req) && req.allTexts.some(words => words.includes('CREW-RESULT'))) && result.code === 0 && result.outcome?.status === 'completed' && result.outcome?.answer === 'LEAD-SAW-RESULT', JSON.stringify(result.outcome))
  } finally { await fixture.close() }
}

try {
  await journey(true)
  await journey(false)
  await endings()
} finally { rmSync(root, { recursive: true, force: true }) }
tally.finish()
