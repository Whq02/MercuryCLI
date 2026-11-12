#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { startFixtureApi } from '../lib/fixtureApi.ts'
import { FIXTURE_API_KEY } from '../lib/firstRunSeed.ts'

assert(process.env.MERCURY_CONFIG_DIR, 'run with a scratch MERCURY_CONFIG_DIR')
const home = mkdtempSync(join(process.env.MERCURY_CONFIG_DIR, 'launch-in-flight-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const fixture = await startFixtureApi(Array.from({ length: 16 }, () => ({ kind: 'text' as const, text: 'SEAT-DONE' })))
process.env.ANTHROPIC_BASE_URL = fixture.url
process.env.ANTHROPIC_API_KEY = FIXTURE_API_KEY

const root = join(home, 'work')
mkdirSync(root, { recursive: true })
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setOriginalCwd(root)
bootstrap.setCwdState(root)
bootstrap.setProjectRoot(root)
bootstrap.switchSession('00000000-0000-4000-8000-000000001011' as never, root)
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { updateSettingsForSource } = await import('../../src/utils/settings/settings.ts')
updateSettingsForSource('userSettings', { swarm: { enabled: true } })
await import('../../src/tasks.ts')
const seam = await import('../../src/services/crewBoard/seam.ts')
const { runSwarmCommand } = await import('../../src/commands/swarm/swarm.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { AgentTool } = await import('../../src/tools/AgentTool/AgentTool.tsx')
const { killAsyncAgent } = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.tsx')
const { getCommandQueue } = await import('../../src/input-core/command-queue.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { readAgentMetadata } = await import('../../src/utils/sessionStorage/paths.ts')
type AppState = ReturnType<typeof getDefaultAppState>

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail: unknown = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}
const settle = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
async function until(holds: () => boolean, ms = 30_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (holds()) return true
    await settle(10)
  }
  return holds()
}

assert(runSwarmCommand('on').startsWith('Swarm on'))
const board = seam.swarmStore()!
const seats = (): string[] => board.seats().filter(seat => seat.agent !== 'main').map(seat => `${seat.name}=${seat.agent}:${seat.state}`)
const RUNNING = (name: string): string => `A seat named ${name} is running on this board; stop it, or launch this one under another name.`

let state = getDefaultAppState() as AppState
const named: Array<(agent: string) => void> = []
const set = (update: (before: AppState) => AppState): void => {
  const before = state
  state = update(state)
  for (const [name, agent] of state.agentNameRegistry) if (before.agentNameRegistry.get(name) !== agent) named.shift()?.(String(agent))
}
const seatType = { agentType: 'in-flight', source: 'userSettings', whenToUse: 'a seat of the launch scenes', getSystemPrompt: () => 'Answer in one line.' }
let launches = 0
type Launched = { agentId?: string; status?: string; refused?: string }
function launch(input: { name: string; run_in_background?: boolean; team?: string; captain?: boolean }): Promise<Launched> {
  const serial = ++launches
  const context = {
    abortController: new AbortController(),
    getAppState: () => state,
    setAppState: set,
    setAppStateForTasks: set,
    options: { commands: [], tools: [], engineModel: 'claude-opus-4-8', thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, debug: false, verbose: false, agentDefinitions: { activeAgents: [seatType], allAgents: [seatType] } },
    messages: [],
    readFileState: createFileStateCacheWithSizeLimit(100),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    toolUseId: `toolu_launch_${serial}`,
  }
  return AgentTool.call({ description: `launch ${serial}`, prompt: `work as launch ${serial}`, crewmate_type: seatType.agentType, ...input } as never, context as never, (async () => ({ behavior: 'allow' })) as never, { requestId: `req-${serial}`, message: { id: `msg_${serial}` } } as never).then(
    result => { const data = result.data as { agentId?: string; status?: string }; return { agentId: data.agentId, status: data.status } },
    error => ({ refused: error instanceof Error ? error.message : String(error) }),
  )
}
const statusOf = (agent: string | undefined): string | undefined => agent === undefined ? undefined : (state.tasks[agent] as { status?: string } | undefined)?.status
const told = (agent: string | undefined): boolean => agent !== undefined && getCommandQueue().some(command => command.mode === 'task-notification' && String(command.value).includes(`<task-id>${agent}</task-id>`))

console.log('── a background launch in flight holds its name ──')
{
  let enrolledWhenTold: boolean | undefined
  let rival: Promise<Launched> | undefined
  named.push(agent => {
    enrolledWhenTold = board.member(agent)
    rival = launch({ name: 'porter', run_in_background: true })
  })
  const first = await launch({ name: 'porter', run_in_background: true })
  const second = await rival
  check('the scene stands between the launch\'s reservation and its enrollment', first.status === 'async_launched' && enrolledWhenTold === false, { first, enrolledWhenTold })
  check('a second launch under the name is refused in the board\'s words while the first is on its way', second?.refused === RUNNING('porter'), second)
  await until(() => told(first.agentId))
  check('the first launch takes its seat and runs to its end', statusOf(first.agentId) === 'completed' && seats().includes(`porter=${first.agentId}:parked`), { status: statusOf(first.agentId), seats: seats() })
}

console.log('── a background launch stopped before it enrolled gives its name up at once ──')
{
  let enrolledWhenStopped: boolean | undefined
  let rival: Promise<Launched> | undefined
  named.push(agent => {
    enrolledWhenStopped = board.member(agent)
    killAsyncAgent(agent, set)
    rival = launch({ name: 'carrier', run_in_background: true })
  })
  const first = await launch({ name: 'carrier', run_in_background: true })
  const second = await rival
  check('the launch is stopped between its reservation and its enrollment', first.status === 'async_launched' && enrolledWhenStopped === false && statusOf(first.agentId) === 'killed', { first, enrolledWhenStopped, status: statusOf(first.agentId) })
  check('a second launch under the name is not refused: the stopped launch holds no name, before it has unwound', second?.status === 'async_launched', second)
  await until(() => told(first.agentId) && told(second?.agentId))
  check('the second launch holds the name and runs to its end', statusOf(second?.agentId) === 'completed' && seats().includes(`carrier=${second?.agentId}:parked`), { status: statusOf(second?.agentId), seats: seats() })
  check('the stopped launch, unwinding late, stays off the board', board.member(first.agentId ?? '') === false && seam.swarmRoad(first.agentId) === false && (await readAgentMetadata(first.agentId as never))?.swarm === false, { member: board.member(first.agentId ?? ''), road: seam.swarmRoad(first.agentId) })
}

runSwarmCommand('off')
await fixture.close()
console.log(`\n${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
