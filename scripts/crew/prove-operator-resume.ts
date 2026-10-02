#!/usr/bin/env bun
process.env.MERCURY_DESKTOP_DRIVER = 'none'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolUseContext } from '../../src/Tool.js'
import type { SpawnOutput, SpawnCrewmateConfig } from '../../src/tools/shared/spawnMultiAgent.js'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'operator-resume-home-'))
process.env.MERCURY_CREWS_DIR = join(process.env.MERCURY_CONFIG_DIR, 'crews')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
delete process.env.MERCURY_HOME
delete process.env.TMUX
delete process.env.TERM_PROGRAM
delete process.env.ITERM_SESSION_ID

await import('../../src/tasks.js')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const { stopAgentByOperator } = await import('../../src/services/agents/operatorStop.js')
const { operatorResumeWords, respawnCrewmateByOperator, crewmateRespawnConfig, crewmateRespawnWords } = await import('../../src/services/agents/operatorResume.js')
const { spawnInProcessCrewmate, unwindCrewmateSpawn } = await import('../../src/utils/swarm/spawnInProcess.js')
const { getCommandQueueSnapshot, resetCommandQueue } = await import('../../src/input-core/command-queue.js')
const { drainSdkEvents } = await import('../../src/utils/sdkEventQueue.js')
const { spawnCrewmate } = await import('../../src/tools/shared/spawnMultiAgent.js')
const { createUserMessage } = await import('../../src/utils/messages.js')
const savedMessages = [createUserMessage({ content: 'Retained crewmate history' })]
const readTranscript = async () => ({ messages: savedMessages, contentReplacements: [] })

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

type Task = { id: string; type: string; status: string; identity?: { agentId: string; agentName: string; crewName: string } }
type State = { tasks: Record<string, Task>; speculation: { status: string }; agentNameRegistry: Map<string, string>; crewContext?: unknown }
function makeStore(): { state: State; set: (fn: (prev: never) => never) => void; get: () => never } {
  const store = {
    state: { tasks: {}, speculation: { status: 'idle' }, agentNameRegistry: new Map<string, string>() } as State,
    set(fn: (prev: never) => never) {
      store.state = (fn as (p: unknown) => State)(store.state)
    },
    get: () => store.state as never,
  }
  return store
}
const contextOf = (store: ReturnType<typeof makeStore>): ToolUseContext =>
  ({
    toolUseId: 'toolu_last_turn',
    getAppState: store.get,
    setAppState: store.set,
    options: { mainLoopModel: 'claude-sonnet-5', agentDefinitions: { activeAgents: [] } },
    messages: [],
    abortController: new AbortController(),
  }) as never
const quick = { settleMs: 300, sleep: (ms: number) => new Promise<void>(r => setTimeout(r, Math.min(ms, 10))) }
const crewmateRows = (store: ReturnType<typeof makeStore>): Task[] => Object.values(store.state.tasks).filter(t => t.type === 'in_process_crewmate')
const notices = (): Array<{ value: string; priority: string | undefined }> => getCommandQueueSnapshot().filter(c => c.mode === 'task-notification').map(c => ({ value: String(c.value), priority: c.priority }))
const AGENT_ID = 'sonnet-ping@ping-crew'

section('a stopped crewmate: r resumes it from its transcript with its identity, prompt, model and type under a new row, and the main agent is told')
{
  const store = makeStore()
  resetCommandQueue()
  const spawned = await spawnInProcessCrewmate({ name: 'sonnet-ping', crewName: 'ping-crew', prompt: 'reply ping', model: 'claude-sonnet-5', agentType: 'mercury-crew', cwd: '/place/of/work', worktree: '/place/of/work/.worktrees/ping' }, { setAppState: store.set as never })
  const id = spawned.taskId!
  const stopped = await stopAgentByOperator(id, { getAppState: store.get, setAppState: store.set as never }, quick)
  check('the crewmate is stopped first', stopped.outcome === 'applied' && store.state.tasks[id]?.status === 'killed', JSON.stringify(stopped))
  resetCommandQueue()
  const configs: SpawnCrewmateConfig[] = []
  const contexts: ToolUseContext[] = []
  const spawn = async (config: SpawnCrewmateConfig, context: ToolUseContext): Promise<{ data: SpawnOutput }> => {
    configs.push(config)
    contexts.push(context)
    const again = await spawnInProcessCrewmate(
      { name: config.name, crewName: config.crew_name!, prompt: config.prompt, ...(config.model !== undefined ? { model: config.model } : {}), ...(config.agent_type !== undefined ? { agentType: config.agent_type } : {}), ...(config.cwd !== undefined ? { cwd: config.cwd } : {}), ...(config.resume?.worktree !== undefined ? { worktree: config.resume.worktree } : {}) },
      { setAppState: store.set as never },
    )
    return { data: { crewmate_id: again.agentId, agent_id: again.agentId, model: config.model ?? '', name: config.name, color: 'blue', tmux_session_name: 'in-process', tmux_window_name: 'in-process', tmux_pane_id: 'in-process', crew_name: config.crew_name, is_splitpane: false } }
  }
  const receipt = await respawnCrewmateByOperator(id, { getAppState: store.get, toolUseContext: contextOf(store), prompt: 'Continue with the saved work' }, { spawn, readTranscript })
  check('the resume is applied as a respawn', receipt.outcome === 'applied', JSON.stringify(receipt))
  const running = crewmateRows(store).filter(t => t.status === 'running')
  check('one new crewmate row runs under a new id with the same agent id; the stopped row stays killed', receipt.outcome === 'applied' && running.length === 1 && running[0]!.id === receipt.taskId && receipt.taskId !== id && running[0]!.identity?.agentId === AGENT_ID && receipt.agentId === AGENT_ID && store.state.tasks[id]?.status === 'killed', JSON.stringify({ receipt, running }))
  check('the respawn carries the row\'s name, crew, prompt, model and type', configs.length === 1 && configs[0]!.name === 'sonnet-ping' && configs[0]!.crew_name === 'ping-crew' && configs[0]!.prompt === 'reply ping' && configs[0]!.model === 'claude-sonnet-5' && configs[0]!.agent_type === 'mercury-crew', JSON.stringify(configs))
  check('the respawn restores history and the operator note through the same transcript id', configs[0]?.resume?.messages[0]?.uuid === savedMessages[0]?.uuid && configs[0]?.resume?.prompt === 'Continue with the saved work' && configs[0]?.resume?.transcriptAgentId === spawned.transcriptAgentId)
  check('the respawn carries the row\'s working folder and its worktree to keep, never the lead\'s folder (RED on the base: no cwd, no worktree)', configs[0]?.cwd === '/place/of/work' && configs[0]?.resume?.worktree === '/place/of/work/.worktrees/ping', JSON.stringify({ cwd: configs[0]?.cwd, worktree: configs[0]?.resume?.worktree }))
  check('the respawn rides the last turn\'s context with a fresh controller and no stale tool-use id', contexts.length === 1 && (contexts[0] as { toolUseId?: string }).toolUseId === undefined && contexts[0]!.abortController !== undefined && !contexts[0]!.abortController.signal.aborted)
  const told = notices()
  check('the main agent is told once, at the next priority, naming the new row and the door', told.length === 1 && told[0]!.priority === 'next' && receipt.outcome === 'applied' && told[0]!.value.includes(`<task-id>${receipt.taskId}</task-id>`) && told[0]!.value.includes(`<summary>${crewmateRespawnWords('sonnet-ping')}</summary>`), JSON.stringify(told))
  const bare = { identity: { agentId: 'a@t', agentName: 'a', crewName: 't' }, prompt: 'p' }
  check('the config builder reads the identity\'s type before the definition\'s and carries no model when the row has none', crewmateRespawnConfig({ ...bare, agentDefinition: { agentType: 'from-definition' } } as never).agent_type === 'from-definition' && crewmateRespawnConfig(bare as never).model === undefined && crewmateRespawnConfig(bare as never).agent_type === undefined)

  await stopAgentByOperator(receipt.outcome === 'applied' ? receipt.taskId : '', { getAppState: store.get, setAppState: store.set as never }, quick)
  store.set((prev => ({ ...(prev as object), tasks: {} })) as never)
  resetCommandQueue()
  const evicted = await respawnCrewmateByOperator(id, { getAppState: store.get, toolUseContext: contextOf(store) }, { spawn, readTranscript })
  check('once both rows are evicted, r on the original id still resumes from the spawn record: the same identity, prompt, model and type, the same transcript', evicted.outcome === 'applied' && evicted.agentId === AGENT_ID && configs.length === 2 && configs[1]!.name === 'sonnet-ping' && configs[1]!.crew_name === 'ping-crew' && configs[1]!.prompt === 'reply ping' && configs[1]!.model === 'claude-sonnet-5' && configs[1]!.agent_type === 'mercury-crew' && configs[1]!.resume?.transcriptAgentId === spawned.transcriptAgentId && configs[1]!.resume?.prompt.startsWith('The operator resumed you from the crew view'), JSON.stringify({ evicted, config: configs[1] }))
  check('…and from the record alone the resume still carries the folder and the worktree (RED on the base)', configs[1]?.cwd === '/place/of/work' && configs[1]?.resume?.worktree === '/place/of/work/.worktrees/ping', JSON.stringify({ cwd: configs[1]?.cwd, worktree: configs[1]?.resume?.worktree }))
  check('the evicted-row resume runs under a new row and tells the main agent once more', evicted.outcome === 'applied' && crewmateRows(store).filter(t => t.status === 'running').length === 1 && notices().length === 1 && notices()[0]!.value.includes(`<task-id>${evicted.taskId}</task-id>`), JSON.stringify(notices()))
}

section('the refusals: a running crewmate, a row that is not a crewmate, and a spawn the road refuses')
{
  const store = makeStore()
  resetCommandQueue()
  const never = async (): Promise<{ data: SpawnOutput }> => {
    throw new Error('never called')
  }
  const spawned = await spawnInProcessCrewmate({ name: 'busy', crewName: 'ping-crew', prompt: 'work' }, { setAppState: store.set as never })
  const live = await respawnCrewmateByOperator(spawned.taskId!, { getAppState: store.get, toolUseContext: contextOf(store) }, { spawn: never })
  check('a running crewmate is refused with its state, and nothing spawns', live.outcome === 'refused' && /running/.test(live.reason) && crewmateRows(store).length === 1, JSON.stringify(live))
  const miss = await respawnCrewmateByOperator('anope1234', { getAppState: store.get, toolUseContext: contextOf(store) }, { spawn: never })
  check('an id that is not a crewmate row is refused', miss.outcome === 'refused' && miss.reason.includes('anope1234'), JSON.stringify(miss))
  await stopAgentByOperator(spawned.taskId!, { getAppState: store.get, setAppState: store.set as never }, quick)
  resetCommandQueue()
  const noTranscript = await respawnCrewmateByOperator(spawned.taskId!, { getAppState: store.get, toolUseContext: contextOf(store) }, { spawn: never, readTranscript: async () => null })
  check('an absent transcript refuses without silently restarting the original prompt', noTranscript.outcome === 'refused' && noTranscript.reason.includes('No transcript found'))
  const refused = await respawnCrewmateByOperator(spawned.taskId!, { getAppState: store.get, toolUseContext: contextOf(store) }, {
    readTranscript,
    spawn: async () => {
      throw new Error('Crew "ping-crew" does not exist')
    },
  })
  check('a spawn the road refuses answers refused with its words, and the main agent hears nothing', refused.outcome === 'refused' && refused.reason.includes('does not exist') && notices().length === 0, JSON.stringify(refused))
}

section('the spawn road: a crew word that names nothing names the session\'s crew, and a row whose first dispatch fails is bookended failed, never left running')
{
  const store = makeStore()
  drainSdkEvents()
  const { sessionCrewName } = await import('../../src/utils/crew/crewBirth.js')
  const { getSessionId } = await import('../../src/bootstrap/state.js')
  const { readCrewFile } = await import('../../src/utils/swarm/crewHelpers.js')
  const crew = sessionCrewName(String(getSessionId()))
  let thrown: unknown = null
  try {
    await spawnCrewmate({ name: 'ghost', prompt: 'haunt', crew_name: 'no-such-crew' }, contextOf(store))
  } catch (error) {
    thrown = error
  }
  check('the spawn is not refused for a missing crew: the row is registered against the session\'s crew and fails only at its first dispatch (this harness carries no tools)', thrown instanceof Error && !/does not exist/.test(thrown.message) && /first dispatch/.test(thrown.message), String(thrown))
  const rows = crewmateRows(store)
  check('no running crewmate row stands after the failed dispatch', rows.every(r => r.status !== 'running'), JSON.stringify(rows.map(r => ({ id: r.id, status: r.status }))))
  const events = drainSdkEvents() as Array<{ subtype?: string; task_id?: string; status?: string; summary?: string }>
  const started = events.find(e => e.subtype === 'task_started')
  const ended = events.find(e => e.subtype === 'task_notification' && e.task_id === started?.task_id)
  check('the row that was registered is bookended failed under the crew\'s agent id, so a reader of the frames sees no running crewmate', started !== undefined && ended !== undefined && ended.status === 'failed' && String(ended.summary) === `ghost@${crew}`, JSON.stringify(events))
  const roster = readCrewFile(crew)
  check('the crew roster on disk no longer lists the ghost after its failed dispatch', roster !== null && roster.members.every(m => m.name !== 'ghost'), JSON.stringify(roster?.members.map(m => m.name)))
}

section('the unwind itself: a running crewmate row is removed and bookended failed; a settled or missing row is left alone')
{
  const store = makeStore()
  drainSdkEvents()
  const spawned = await spawnInProcessCrewmate({ name: 'undone', crewName: 'ping-crew', prompt: 'p' }, { setAppState: store.set as never, toolUseId: 'toolu_spawn' })
  drainSdkEvents()
  const unwound = unwindCrewmateSpawn(spawned.taskId!, store.set as never, 'the crew is gone')
  check('the running row is unwound: removed from the store, its controller aborted', unwound && store.state.tasks[spawned.taskId!] === undefined && spawned.abortController?.signal.aborted === true)
  const events = drainSdkEvents() as Array<{ subtype?: string; task_id?: string; status?: string; summary?: string; tool_use_id?: string }>
  check('the bookend names the row, its tool use and the cause', events.length === 1 && events[0]!.subtype === 'task_notification' && events[0]!.task_id === spawned.taskId && events[0]!.status === 'failed' && events[0]!.summary === 'the crew is gone' && events[0]!.tool_use_id === 'toolu_spawn', JSON.stringify(events))
  check('a second unwind of the same id answers false and emits nothing', unwindCrewmateSpawn(spawned.taskId!, store.set as never, 'again') === false && drainSdkEvents().length === 0)
  const settled = await spawnInProcessCrewmate({ name: 'done', crewName: 'ping-crew', prompt: 'p' }, { setAppState: store.set as never })
  await stopAgentByOperator(settled.taskId!, { getAppState: store.get, setAppState: store.set as never }, quick)
  drainSdkEvents()
  check('a settled row is left alone', unwindCrewmateSpawn(settled.taskId!, store.set as never, 'late') === false && store.state.tasks[settled.taskId!]?.status === 'killed')
}

section('the doors in source: the runner\'s resume routes a crewmate row, or an evicted row whose record is a crewmate\'s, to the transcript continuation before the agent resume and tells the main agent of an agent resume; the spawn road unwinds in the membership\'s catch')
{
  const runner = readFileSync(join(import.meta.dir, '../../src/cli/print.ts'), 'utf8')
  const arm = runner.slice(runner.indexOf("case 'resume_task': {"), runner.indexOf("case 'generate_session_title': {"))
  check('the resume arm continues a crewmate row through the operator resume owner with the operator\'s note and answers its receipt', arm.includes('isInProcessCrewmateTask(target)') && arm.includes('readAgentMetadata(asAgentId(request.task_id)))?.crewmate !== undefined') && arm.includes('respawnCrewmateByOperator(request.task_id, { getAppState, toolUseContext: params.toolUseContext, prompt: request.note })') && arm.includes('respawnCrewmateByOperator(') && arm.includes('resumeAgentBackground({') && arm.indexOf('respawnCrewmateByOperator(') < arm.indexOf('resumeAgentBackground({'))
  check('the resume arm tells the main agent of an agent resumed from the board with its continuation note', arm.includes("enqueueAgentReceiptRow({ taskId: resumed.agentId, description: resumed.description, summary: operatorResumeWords(resumed.description) + (resumed.note ?? '') })"))
  const view = readFileSync(join(import.meta.dir, '../../src/components/mercury-ui/screens/CrewView.tsx'), 'utf8')
  check('the crew view paints the continuation line for a crewmate row and the shipped resume line for an agent', view.includes("target.kind === 'named' ? `${target.name} resumed from its transcript — it continues under a new row` : `${target.name} resumed from its transcript — it runs on under the same id`"))
  check('the resume words name the door and the id', operatorResumeWords('scout') === 'Agent "scout" resumed from the crew view · it runs on under the same id')
  const spawnRoad = readFileSync(join(import.meta.dir, '../../src/tools/shared/spawnMultiAgent.ts'), 'utf8')
  const inProcess = spawnRoad.slice(spawnRoad.indexOf('async function spawnInProcessStrategy('))
  const appendAt = inProcess.indexOf('await appendCrewMember(crewName, {')
  const catchAt = inProcess.indexOf('unwindCrewmateSpawn(spawnResult.taskId', appendAt)
  check('the in-process strategy unwinds the registered row when the membership append refuses, then rethrows', appendAt !== -1 && catchAt !== -1 && catchAt < inProcess.indexOf('startInProcessCrewmate({') && /catch \(error\) \{\s*if \(spawnResult\.taskId !== undefined\) unwindCrewmateSpawn\(spawnResult\.taskId, context\.setAppStateForTasks \?\? context\.setAppState, errorMessage\(error\)\)\s*throw error/.test(inProcess))
}

rmSync(process.env.MERCURY_CONFIG_DIR!, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} OPERATOR-RESUME PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL OPERATOR-RESUME PROOFS PASS')
