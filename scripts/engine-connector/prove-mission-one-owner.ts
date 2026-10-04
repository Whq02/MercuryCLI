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

section("§1 the runner's ledger: the session's list beside the crew's board")
{
  const own = String(getSessionId())
  check('with no crew the list id is the session id', tasks.getTaskListId() === own, tasks.getTaskListId())
  const before = await tasks.createTask(own, { subject: 'review next session planning doc', description: '', activeForm: 'Reviewing the planning doc', status: 'in_progress', blocks: [], blockedBy: [] })
  tasks.setLeaderCrewName('crew')
  check("a leader registration moves the runner's WRITES to the crew's board (the fleet's shared-board law)", tasks.getTaskListId() === 'crew')
  const afterRaw = await tasks.createTask(tasks.getTaskListId(), { subject: 'the crew task', description: '', status: 'pending', blocks: [], blockedBy: [] })
  const after = `crew:${afterRaw}`
  const mission = await tasks.listSessionMission()
  check("the session's mission lists the task written BEFORE the crew and the one on the crew's board", mission.some(t => t.id === before) && mission.some(t => t.id === after), j(mission.map(t => [t.id, t.subject])))
  check("the session's own row leads; no row twice (the crew's row carries its list in its id)", mission.findIndex(t => t.id === before) < mission.findIndex(t => t.id === after) && new Set(mission.map(t => t.id)).size === mission.length, j(mission.map(t => t.id)))
  const blockerRaw = await tasks.createTask(tasks.getTaskListId(), { subject: 'the blocker', description: '', status: 'pending', blocks: [], blockedBy: [] })
  const blockedRaw = await tasks.createTask(tasks.getTaskListId(), { subject: 'the blocked one', description: '', status: 'pending', blocks: [], blockedBy: [] })
  await tasks.blockTask(tasks.getTaskListId(), blockerRaw, blockedRaw)
  const ownTwin = await tasks.createTask(own, { subject: "the session's own row with the blocker's number", description: '', status: 'pending', blocks: [], blockedBy: [] })
  const relayed = await tasks.listSessionMission()
  const blockedRow = relayed.find(t => t.id === `crew:${blockedRaw}`)
  const blockerRow = relayed.find(t => t.id === `crew:${blockerRaw}`)
  check("a blocked crew row reads blocked on the relay: its blockedBy names the blocker in the crew's key", blockedRow !== undefined && blockedRow.blockedBy.length === 1 && blockedRow.blockedBy[0] === `crew:${blockerRaw}`, j(blockedRow))
  check("…and the blocker's blocks edge is keyed the same way (one prefix for the id and its edges)", blockerRow !== undefined && blockerRow.blocks.length === 1 && blockerRow.blocks[0] === `crew:${blockedRaw}`, j(blockerRow))
  check("…so the crew's raw edge never matches the session's own row of the same number (both lists carry that number)", ownTwin === blockerRaw && relayed.some(t => t.id === ownTwin) && relayed.filter(t => t.id.includes(':')).every(t => [...t.blocks, ...t.blockedBy].every(edge => !relayed.some(s => !s.id.includes(':') && s.id === edge))), j(relayed.map(t => [t.id, t.blocks, t.blockedBy])))
  tasks.clearLeaderCrewName()
  const alone = await tasks.listSessionMission()
  check("the crew gone, the session's own list stands alone (the board is read beside, never instead)", alone.some(t => t.id === before) && !alone.some(t => t.id === after), j(alone.map(t => t.id)))
}

section('§2 the signal: one row from the writer, read by the daemon, admitted by the schema')
{
  const { missionUpdatedRow, createRowStamper } = await import('../../src/rows/project.ts')
  const { RowSchema } = await import('../../src/rows/vocabulary.ts')
  const { parseRow } = await import('../../src/rows/read.ts')
  const row = createRowStamper(() => '2026-10-02T00:00:00.000Z').stamp(missionUpdatedRow({ session_id: 'sess-1' }))
  check("the row is a mission_updated row carrying the session's id", row.type === 'mission_updated' && row.session_id === 'sess-1' && typeof row.seq === 'number', j(row))
  const line = JSON.stringify(row)
  check("the reader parses the writer's line as its row; a foreign line reads another type", parseRow(line)?.type === 'mission_updated' && parseRow('{"type":"heartbeat","seq":1,"timestamp":"t","session_id":"s"}')?.type === 'heartbeat')
  check('the row schema admits the row', RowSchema().safeParse(JSON.parse(line)).success)
  const seat = src('src/daemon/sessionSeat.ts')
  check("the daemon's task-row arm names the type (a task write re-asks the facts within the turn)", /case 'mission_updated':/.test(seat))
  const print = src('src/cli/run.ts')
  check('the runner relays listSessionMission and writes the row on every task write (debounced)', print.includes('mission: (await listSessionMission()') && print.includes('onTasksUpdated(() => {') && print.includes('enqueueRow(missionUpdatedRow(liveScope()))'))
}

section("§3 the screen: every task surface reads the focused seat's relay")
{
  const bus = src('src/state/telemetryBus.ts')
  check("the rail's bus reads the focused seat's mission rows and subscribes through the focused slot", bus.includes("getFocusedSessionConnector().workRoster().mission") && bus.includes('subscribeThroughFocused((connector, listener) => connector.subscribeWork(listener))') && !bus.includes('listTasks(getTaskListId())'))
  const board = src('src/components/tasks/BackgroundTasksDialog.tsx')
  check('the /tasks board reads the relay alone (the screen store is no source)', board.includes('= roster.mission') && !board.includes('useTelemetry(s => s.tasks)'))
  const strip = src('src/components/Spinner.tsx')
  check('the working strip reads the focused mission through the one hook', strip.includes('useFocusedMission()'))
  const hook = src('src/components/tasks/useFocusedWork.ts')
  check('useFocusedMission is the one reader — the focused roster\'s mission rows', hook.includes('export function useFocusedMission(): readonly MissionRowV1[]') && hook.includes('return useFocusedWorkRoster().mission'))
}

rmSync(process.env.MERCURY_CONFIG_DIR, { recursive: true, force: true })
console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
