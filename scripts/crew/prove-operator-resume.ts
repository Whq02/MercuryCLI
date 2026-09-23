#!/usr/bin/env bun
process.env.MERCURY_DESKTOP_DRIVER = 'none'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolUseContext } from '../../src/Tool.js'
import type { SpawnOutput, SpawnTeammateConfig } from '../../src/tools/shared/spawnMultiAgent.js'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'operator-resume-home-'))
process.env.MERCURY_TEAMS_DIR = join(process.env.MERCURY_CONFIG_DIR, 'teams')
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
const { operatorResumeWords, respawnTeammateByOperator, teammateRespawnConfig, teammateRespawnWords } = await import('../../src/services/agents/operatorResume.js')
const { spawnInProcessTeammate, unwindTeammateSpawn } = await import('../../src/utils/swarm/spawnInProcess.js')
const { getCommandQueueSnapshot, resetCommandQueue } = await import('../../src/input-core/command-queue.js')
const { drainSdkEvents } = await import('../../src/utils/sdkEventQueue.js')
const { spawnTeammate } = await import('../../src/tools/shared/spawnMultiAgent.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

type Task = { id: string; type: string; status: string; identity?: { agentId: string; agentName: string; teamName: string } }
type State = { tasks: Record<string, Task>; speculation: { status: string }; agentNameRegistry: Map<string, string>; teamContext?: unknown }
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
const teammateRows = (store: ReturnType<typeof makeStore>): Task[] => Object.values(store.state.tasks).filter(t => t.type === 'in_process_teammate')
const notices = (): Array<{ value: string; priority: string | undefined }> => getCommandQueueSnapshot().filter(c => c.mode === 'task-notification').map(c => ({ value: String(c.value), priority: c.priority }))
const AGENT_ID = 'sonnet-ping@ping-team'

section('a stopped teammate: r spawns it again with its identity, prompt, model and type under a new row, and the main agent is told')
{
  const store = makeStore()
  resetCommandQueue()
  const spawned = await spawnInProcessTeammate({ name: 'sonnet-ping', teamName: 'ping-team', prompt: 'reply ping', planModeRequired: false, model: 'claude-sonnet-5', agentType: 'mercury-general' }, { setAppState: store.set as never })
  const id = spawned.taskId!
  const stopped = await stopAgentByOperator(id, { getAppState: store.get, setAppState: store.set as never }, quick)
  check('the teammate is stopped first', stopped.outcome === 'applied' && store.state.tasks[id]?.status === 'killed', JSON.stringify(stopped))
  resetCommandQueue()
  const configs: SpawnTeammateConfig[] = []
  const contexts: ToolUseContext[] = []
  const spawn = async (config: SpawnTeammateConfig, context: ToolUseContext): Promise<{ data: SpawnOutput }> => {
    configs.push(config)
    contexts.push(context)
    const again = await spawnInProcessTeammate(
      { name: config.name, teamName: config.team_name!, prompt: config.prompt, planModeRequired: config.plan_mode_required === true, ...(config.model !== undefined ? { model: config.model } : {}), ...(config.agent_type !== undefined ? { agentType: config.agent_type } : {}) },
      { setAppState: store.set as never },
    )
    return { data: { teammate_id: again.agentId, agent_id: again.agentId, model: config.model ?? '', name: config.name, color: 'blue', tmux_session_name: 'in-process', tmux_window_name: 'in-process', tmux_pane_id: 'in-process', team_name: config.team_name, is_splitpane: false, plan_mode_required: false } }
  }
  const receipt = await respawnTeammateByOperator(id, { getAppState: store.get, toolUseContext: contextOf(store) }, { spawn })
  check('the resume is applied as a respawn', receipt.outcome === 'applied', JSON.stringify(receipt))
  const running = teammateRows(store).filter(t => t.status === 'running')
  check('one new teammate row runs under a new id with the same agent id; the stopped row stays killed', receipt.outcome === 'applied' && running.length === 1 && running[0]!.id === receipt.taskId && receipt.taskId !== id && running[0]!.identity?.agentId === AGENT_ID && receipt.agentId === AGENT_ID && store.state.tasks[id]?.status === 'killed', JSON.stringify({ receipt, running }))
  check('the respawn carries the row\'s name, team, prompt, model, type and plan mode', configs.length === 1 && configs[0]!.name === 'sonnet-ping' && configs[0]!.team_name === 'ping-team' && configs[0]!.prompt === 'reply ping' && configs[0]!.model === 'claude-sonnet-5' && configs[0]!.agent_type === 'mercury-general' && configs[0]!.plan_mode_required === false, JSON.stringify(configs))
  check('the respawn rides the last turn\'s context with a fresh controller and no stale tool-use id', contexts.length === 1 && (contexts[0] as { toolUseId?: string }).toolUseId === undefined && contexts[0]!.abortController !== undefined && !contexts[0]!.abortController.signal.aborted)
  const told = notices()
  check('the main agent is told once, at the next priority, naming the new row and the door', told.length === 1 && told[0]!.priority === 'next' && receipt.outcome === 'applied' && told[0]!.value.includes(`<task-id>${receipt.taskId}</task-id>`) && told[0]!.value.includes(`<summary>${teammateRespawnWords('sonnet-ping')}</summary>`), JSON.stringify(told))
  const bare = { identity: { agentId: 'a@t', agentName: 'a', teamName: 't', planModeRequired: true }, prompt: 'p' }
  check('the config builder reads the identity\'s type before the definition\'s and carries no model when the row has none', teammateRespawnConfig({ ...bare, agentDefinition: { agentType: 'from-definition' } } as never).agent_type === 'from-definition' && teammateRespawnConfig(bare as never).model === undefined && teammateRespawnConfig(bare as never).agent_type === undefined && teammateRespawnConfig(bare as never).plan_mode_required === true)
}

section('the refusals: a running teammate, a row that is not a teammate, and a spawn the road refuses')
{
  const store = makeStore()
  resetCommandQueue()
  const never = async (): Promise<{ data: SpawnOutput }> => {
    throw new Error('never called')
  }
  const spawned = await spawnInProcessTeammate({ name: 'busy', teamName: 'ping-team', prompt: 'work', planModeRequired: false }, { setAppState: store.set as never })
  const live = await respawnTeammateByOperator(spawned.taskId!, { getAppState: store.get, toolUseContext: contextOf(store) }, { spawn: never })
  check('a running teammate is refused with its state, and nothing spawns', live.outcome === 'refused' && /running/.test(live.reason) && teammateRows(store).length === 1, JSON.stringify(live))
  const miss = await respawnTeammateByOperator('anope1234', { getAppState: store.get, toolUseContext: contextOf(store) }, { spawn: never })
  check('an id that is not a teammate row is refused', miss.outcome === 'refused' && miss.reason.includes('anope1234'), JSON.stringify(miss))
  await stopAgentByOperator(spawned.taskId!, { getAppState: store.get, setAppState: store.set as never }, quick)
  resetCommandQueue()
  const refused = await respawnTeammateByOperator(spawned.taskId!, { getAppState: store.get, toolUseContext: contextOf(store) }, {
    spawn: async () => {
      throw new Error('Team "ping-team" does not exist — create the team first')
    },
  })
  check('a spawn the road refuses answers refused with its words, and the main agent hears nothing', refused.outcome === 'refused' && refused.reason.includes('does not exist') && notices().length === 0, JSON.stringify(refused))
}

section('the spawn road: a teammate row registered against a team that does not exist is unwound at the refusal, never left running')
{
  const store = makeStore()
  drainSdkEvents()
  let thrown: unknown = null
  try {
    await spawnTeammate({ name: 'ghost', prompt: 'haunt', team_name: 'no-such-team' }, contextOf(store))
  } catch (error) {
    thrown = error
  }
  check('the spawn is refused because the team does not exist', thrown instanceof Error && /does not exist/.test(thrown.message), String(thrown))
  const rows = teammateRows(store)
  check('no teammate row stands after the refusal', rows.length === 0, JSON.stringify(rows.map(r => ({ id: r.id, status: r.status }))))
  const events = drainSdkEvents() as Array<{ subtype?: string; task_id?: string; status?: string; summary?: string }>
  const started = events.find(e => e.subtype === 'task_started')
  const ended = events.find(e => e.subtype === 'task_notification' && e.task_id === started?.task_id)
  check('the row that was registered is bookended failed with the refusal, so a reader of the frames sees no running teammate', started !== undefined && ended !== undefined && ended.status === 'failed' && String(ended.summary).includes('does not exist'), JSON.stringify(events))
}

section('the unwind itself: a running teammate row is removed and bookended failed; a settled or missing row is left alone')
{
  const store = makeStore()
  drainSdkEvents()
  const spawned = await spawnInProcessTeammate({ name: 'undone', teamName: 'ping-team', prompt: 'p', planModeRequired: false }, { setAppState: store.set as never, toolUseId: 'toolu_spawn' })
  drainSdkEvents()
  const unwound = unwindTeammateSpawn(spawned.taskId!, store.set as never, 'the team is gone')
  check('the running row is unwound: removed from the store, its controller aborted', unwound && store.state.tasks[spawned.taskId!] === undefined && spawned.abortController?.signal.aborted === true)
  const events = drainSdkEvents() as Array<{ subtype?: string; task_id?: string; status?: string; summary?: string; tool_use_id?: string }>
  check('the bookend names the row, its tool use and the cause', events.length === 1 && events[0]!.subtype === 'task_notification' && events[0]!.task_id === spawned.taskId && events[0]!.status === 'failed' && events[0]!.summary === 'the team is gone' && events[0]!.tool_use_id === 'toolu_spawn', JSON.stringify(events))
  check('a second unwind of the same id answers false and emits nothing', unwindTeammateSpawn(spawned.taskId!, store.set as never, 'again') === false && drainSdkEvents().length === 0)
  const settled = await spawnInProcessTeammate({ name: 'done', teamName: 'ping-team', prompt: 'p', planModeRequired: false }, { setAppState: store.set as never })
  await stopAgentByOperator(settled.taskId!, { getAppState: store.get, setAppState: store.set as never }, quick)
  drainSdkEvents()
  check('a settled row is left alone', unwindTeammateSpawn(settled.taskId!, store.set as never, 'late') === false && store.state.tasks[settled.taskId!]?.status === 'killed')
}

section('the doors in source: the runner\'s resume routes a teammate row to the respawn before the transcript resume and tells the main agent of an agent resume; the spawn road unwinds in the membership\'s catch')
{
  const runner = readFileSync(join(import.meta.dir, '../../src/cli/print.ts'), 'utf8')
  const arm = runner.slice(runner.indexOf("case 'resume_task': {"), runner.indexOf("case 'generate_session_title': {"))
  check('the resume arm respawns a teammate row through the operator resume owner and answers its receipt', arm.includes('isInProcessTeammateTask(target)') && arm.includes('respawnTeammateByOperator(request.task_id, { getAppState, toolUseContext: params.toolUseContext })') && arm.includes('respawnTeammateByOperator(') && arm.indexOf('respawnTeammateByOperator(') < arm.indexOf('resumeAgentBackground({'))
  check('the resume arm tells the main agent of an agent resumed from the board with its continuation note', arm.includes("enqueueAgentReceiptRow({ taskId: resumed.agentId, description: resumed.description, summary: operatorResumeWords(resumed.description) + (resumed.note ?? '') })"))
  const view = readFileSync(join(import.meta.dir, '../../src/components/mercury-ui/screens/CrewView.tsx'), 'utf8')
  check('the crew view paints the respawn line for a teammate row and the shipped resume line for an agent', view.includes("target.kind === 'named' ? `${target.name} spawned again from its prompt — it starts over under a new row` : `${target.name} resumed from its transcript — it runs on under the same id`"))
  check('the resume words name the door and the id', operatorResumeWords('scout') === 'Agent "scout" resumed from the crew view · it runs on under the same id')
  const spawnRoad = readFileSync(join(import.meta.dir, '../../src/tools/shared/spawnMultiAgent.ts'), 'utf8')
  const inProcess = spawnRoad.slice(spawnRoad.indexOf('async function spawnInProcessStrategy('))
  const appendAt = inProcess.indexOf('await appendTeamMember(teamName, {')
  const catchAt = inProcess.indexOf('unwindTeammateSpawn(spawnResult.taskId', appendAt)
  check('the in-process strategy unwinds the registered row when the membership append refuses, then rethrows', appendAt !== -1 && catchAt !== -1 && catchAt < inProcess.indexOf('startInProcessTeammate({') && /catch \(error\) \{\s*if \(spawnResult\.taskId !== undefined\) unwindTeammateSpawn\(spawnResult\.taskId, context\.setAppStateForTasks \?\? context\.setAppState, errorMessage\(error\)\)\s*throw error/.test(inProcess))
}

rmSync(process.env.MERCURY_CONFIG_DIR!, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} OPERATOR-RESUME PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL OPERATOR-RESUME PROOFS PASS')
