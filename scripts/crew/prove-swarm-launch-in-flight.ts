#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
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
const reserved: Array<() => void> = []
const seatType = { agentType: 'in-flight', source: 'userSettings', whenToUse: 'a seat of the launch scenes', getSystemPrompt: () => { reserved.shift()?.(); return 'Answer in one line.' } }
let launches = 0
type Launched = { agentId?: string; status?: string; refused?: string }
function launch(input: { name: string; run_in_background?: boolean; team?: string; captain?: boolean }, turn = new AbortController()): Promise<Launched> {
  const serial = ++launches
  const context = {
    abortController: turn,
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
const notices = (agent: string | undefined): string[] => agent === undefined ? [] : getCommandQueue().filter(command => command.mode === 'task-notification').map(command => String(command.value)).filter(text => text.includes(`<task-id>${agent}</task-id>`))
const told = (agent: string | undefined): boolean => notices(agent).length > 0

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

console.log('── a launch stopped before it enrolled meets a board that cannot be written ──')
{
  const holder = new (createRequire(import.meta.url)('bun:sqlite').Database)(board.view().record!.path) as { exec(sql: string): void; close(): void }
  const enroll = board.enroll
  let thrown: Error | undefined
  named.push(agent => {
    killAsyncAgent(agent, set)
    holder.exec('BEGIN IMMEDIATE')
    board.enroll = seat => {
      board.enroll = enroll
      try { enroll(seat) } catch (error) { thrown = error as Error; throw error } finally { holder.exec('ROLLBACK'); holder.close() }
    }
  })
  const first = await launch({ name: 'ferry', run_in_background: true })
  await until(() => told(first.agentId))
  const notice = notices(first.agentId)[0] ?? ''
  check('another writer holds the board\'s file for as long as the stopped launch\'s enrollment waits, and the store says so', statusOf(first.agentId) === 'killed' && thrown !== undefined && thrown.message !== RUNNING('ferry'), { status: statusOf(first.agentId), thrown: thrown?.message })
  check('the store\'s failure is not read as the name\'s refusal: no record takes the seat off the board', seam.swarmRoad(first.agentId) === true && (await readAgentMetadata(first.agentId as never))?.swarm !== false, { road: seam.swarmRoad(first.agentId), sidecar: await readAgentMetadata(first.agentId as never) })
  check('the lead is told the launch failed, in the store\'s words', thrown !== undefined && notice.includes('<status>failed</status>') && notice.includes(thrown.message), notice.slice(0, 400))
}

console.log('── a foreground launch an interrupt hands to the background keeps what it reserved until it has enrolled ──')
{
  const old = await launch({ name: 'watch', team: 'deck', run_in_background: true })
  await until(() => told(old.agentId))
  const before = seats().filter(seat => seat.startsWith('watch='))
  const turn = new AbortController()
  named.push(() => turn.abort())
  const first = await launch({ name: 'watch', team: 'deck', captain: true }, turn)
  const enrolledAtReturn = board.member(first.agentId ?? '')
  await until(() => board.member(first.agentId ?? ''))
  const atEnrollment = seats().filter(seat => seat.startsWith('watch='))
  const captain = board.captain('deck')?.agent
  await until(() => told(first.agentId))
  check('the turn is interrupted before the launch has enrolled, and the launch is handed to the background', before.join() === `watch=${old.agentId}:parked` && first.status === 'async_launched' && enrolledAtReturn === false, { before, first, enrolledAtReturn })
  check('when it enrolls, the parked seat whose name it took stays retired: one seat carries the name', atEnrollment.join() === `watch=${first.agentId}:running`, atEnrollment)
  check('and it is the captain its launch asked for', captain !== undefined && captain === first.agentId, { captain })
  check('it runs to its end in the background', statusOf(first.agentId) === 'completed' && seats().filter(seat => seat.startsWith('watch=')).join() === `watch=${first.agentId}:parked`, { status: statusOf(first.agentId), seats: seats() })
}

console.log('── a foreground launch whose task is stopped before it enrolled gives its name up at once ──')
{
  let stopped = ''
  let enrolledWhenStopped: boolean | undefined
  let rival: Promise<Launched> | undefined
  named.push(agent => {
    stopped = agent
    enrolledWhenStopped = board.member(agent)
    killAsyncAgent(agent, set)
    rival = launch({ name: 'scout', run_in_background: true })
  })
  const first = await launch({ name: 'scout' })
  const second = await rival
  await until(() => second?.agentId === undefined || told(second.agentId))
  check('the launch is stopped between its reservation and its enrollment, and its call ends as a stopped call', first.refused !== undefined && first.refused !== RUNNING('scout') && enrolledWhenStopped === false && statusOf(stopped) === 'killed', { first, enrolledWhenStopped, status: statusOf(stopped) })
  check('a second launch under the name is not refused: the stopped launch holds no name', second?.status === 'async_launched', second)
  check('the second launch holds the name and runs to its end', statusOf(second?.agentId) === 'completed' && seats().filter(seat => seat.startsWith('scout=')).join() === `scout=${second?.agentId}:parked`, { status: statusOf(second?.agentId), seats: seats() })
  check('the stopped launch stays off the board', board.member(stopped) === false && seam.swarmRoad(stopped) === false, { member: board.member(stopped), road: seam.swarmRoad(stopped) })
}

for (const [name, moment, hooks] of [['relay', 'before its task is registered', reserved], ['tender', 'after its task is registered', named]] as const) {
  console.log(`── a foreground launch whose turn is interrupted ${moment} holds its name ──`)
  const turn = new AbortController()
  let enrolledWhenInterrupted: boolean | undefined
  let rival: Promise<Launched> | undefined
  hooks.push(() => {
    enrolledWhenInterrupted = seats().some(seat => seat.startsWith(`${name}=`))
    turn.abort()
    rival = launch({ name, run_in_background: true })
  })
  const first = await launch({ name }, turn)
  const second = await rival
  await until(() => told(first.agentId) && (second?.agentId === undefined || told(second.agentId)))
  check('the interrupt comes between the launch\'s reservation and its enrollment, and the launch goes on in the background', first.status === 'async_launched' && enrolledWhenInterrupted === false, { first, enrolledWhenInterrupted })
  check('a second launch under the name is refused in the board\'s words: the first is on its way', second?.refused === RUNNING(name), second)
  check('the first launch takes its seat and runs to its end', statusOf(first.agentId) === 'completed' && seats().filter(seat => seat.startsWith(`${name}=`)).join() === `${name}=${first.agentId}:parked`, { status: statusOf(first.agentId), notice: notices(first.agentId)[0]?.slice(0, 300), seats: seats() })
}

runSwarmCommand('off')
await fixture.close()
console.log(`\n${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
