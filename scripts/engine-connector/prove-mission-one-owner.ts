#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
process.chdir(ROOT)
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'mission-one-owner-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_TASK_LIST_ID

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const tasks = await import('../../src/utils/tasks.ts')
const { getSessionId } = await import('../../src/bootstrap/state.ts')
const supervisor = await import('../../src/daemon/longLivedSupervisor.ts')
const schemas = await import('../../src/entrypoints/sdk/coreSchemas.ts')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)
const src = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

section("§1 the runner's ledger: the session's list beside the team's board")
{
  const own = String(getSessionId())
  check('with no team the list id is the session id', tasks.getTaskListId() === own, tasks.getTaskListId())
  const before = await tasks.createTask(own, { subject: 'review next session planning doc', description: '', activeForm: 'Reviewing the planning doc', status: 'in_progress', blocks: [], blockedBy: [] })
  tasks.setLeaderTeamName('crew')
  check("a TeamCreate moves the runner's WRITES to the team's board (the fleet's shared-board law)", tasks.getTaskListId() === 'crew')
  const afterRaw = await tasks.createTask(tasks.getTaskListId(), { subject: 'the team task', description: '', status: 'pending', blocks: [], blockedBy: [] })
  const after = `crew:${afterRaw}`
  const mission = await tasks.listSessionMission()
  check("the session's mission lists the task written BEFORE the team and the one on the team's board", mission.some(t => t.id === before) && mission.some(t => t.id === after), j(mission.map(t => [t.id, t.subject])))
  check("the session's own row leads; no row twice (the team's row carries its list in its id)", mission.findIndex(t => t.id === before) < mission.findIndex(t => t.id === after) && new Set(mission.map(t => t.id)).size === mission.length, j(mission.map(t => t.id)))
  const blockerRaw = await tasks.createTask(tasks.getTaskListId(), { subject: 'the blocker', description: '', status: 'pending', blocks: [], blockedBy: [] })
  const blockedRaw = await tasks.createTask(tasks.getTaskListId(), { subject: 'the blocked one', description: '', status: 'pending', blocks: [], blockedBy: [] })
  await tasks.blockTask(tasks.getTaskListId(), blockerRaw, blockedRaw)
  const ownTwin = await tasks.createTask(own, { subject: "the session's own row with the blocker's number", description: '', status: 'pending', blocks: [], blockedBy: [] })
  const relayed = await tasks.listSessionMission()
  const blockedRow = relayed.find(t => t.id === `crew:${blockedRaw}`)
  const blockerRow = relayed.find(t => t.id === `crew:${blockerRaw}`)
  check("a blocked team row reads blocked on the relay: its blockedBy names the blocker in the team's key", blockedRow !== undefined && blockedRow.blockedBy.length === 1 && blockedRow.blockedBy[0] === `crew:${blockerRaw}`, j(blockedRow))
  check("…and the blocker's blocks edge is keyed the same way (one prefix for the id and its edges)", blockerRow !== undefined && blockerRow.blocks.length === 1 && blockerRow.blocks[0] === `crew:${blockedRaw}`, j(blockerRow))
  check("…so the team's raw edge never matches the session's own row of the same number (both lists carry that number)", ownTwin === blockerRaw && relayed.some(t => t.id === ownTwin) && relayed.filter(t => t.id.includes(':')).every(t => [...t.blocks, ...t.blockedBy].every(edge => !relayed.some(s => !s.id.includes(':') && s.id === edge))), j(relayed.map(t => [t.id, t.blocks, t.blockedBy])))
  tasks.clearLeaderTeamName()
  const alone = await tasks.listSessionMission()
  check("the team gone, the session's own list stands alone (the board is read beside, never instead)", alone.some(t => t.id === before) && !alone.some(t => t.id === after), j(alone.map(t => t.id)))
}

section('§2 the signal: one frame from the writer, read by the daemon, admitted by the schema')
{
  const frame = supervisor.missionUpdatedFrame('sess-1', 'uuid-1')
  check("the frame is a system frame with the mission subtype and the session's id", frame.type === 'system' && frame.subtype === supervisor.MISSION_UPDATED_SUBTYPE && frame.session_id === 'sess-1' && frame.uuid === 'uuid-1', j(frame))
  const line = JSON.stringify(frame)
  check("the reader's predicate recognises the writer's line; a foreign subtype reads false", supervisor.isMissionUpdatedParsedFrame(supervisor.parseStreamJsonFrame(line)) && !supervisor.isMissionUpdatedParsedFrame(supervisor.parseStreamJsonFrame('{"type":"system","subtype":"status"}')))
  check('the SDK schema admits the frame, and the message union carries it', schemas.SDKMissionUpdatedMessageSchema().safeParse(JSON.parse(line)).success && schemas.SDKMessageSchema().safeParse(JSON.parse(line)).success)
  const seat = src('src/daemon/sessionSeat.ts')
  check("the daemon's task-frame arm names the subtype (a task write re-asks the facts within the turn)", seat.includes(`line.includes('"mission_updated"')`))
  const print = src('src/cli/print.ts')
  check('the runner relays listSessionMission and writes the frame on every task write (debounced)', print.includes('mission: (await listSessionMission()') && print.includes('onTasksUpdated(() => {') && print.includes('io.outbound.enqueue(missionUpdatedFrame(getSessionId(), randomUUID()))') && print.includes('MISSION_UPDATED_SUBTYPE,'))
}

section("§3 the screen: every task surface reads the focused seat's relay")
{
  const bus = src('src/state/telemetryBus.ts')
  check("the rail's bus reads the focused seat's mission rows and subscribes through the focused slot", bus.includes("getFocusedSessionConnector().workRoster().mission") && bus.includes('subscribeThroughFocused((connector, listener) => connector.subscribeWork(listener))') && !bus.includes('listTasks(getTaskListId())'))
  const board = src('src/components/tasks/BackgroundTasksDialog.tsx')
  check('the /tasks board reads the relay alone (the screen store is no source)', board.includes('= roster.mission') && !board.includes('useTelemetry(s => s.tasks)'))
  const strip = src('src/components/Spinner.tsx')
  check('the working strip reads the focused mission and narrates only while the turn is in flight', strip.includes('useFocusedMission()') && strip.includes("turnOpen ? mission.find(task => task.status === 'in_progress') : undefined") && !strip.includes('useTasksV2()'))
  const hook = src('src/components/tasks/useFocusedWork.ts')
  check('useFocusedMission is the one reader — the focused roster\'s mission rows', hook.includes('export function useFocusedMission(): readonly MissionRowV1[]') && hook.includes('return useFocusedWorkRoster().mission'))
}

rmSync(process.env.MERCURY_CONFIG_DIR, { recursive: true, force: true })
console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
