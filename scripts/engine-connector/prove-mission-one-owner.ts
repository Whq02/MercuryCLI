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

section("§1 the runner's ledger: the session's own list")
{
  const own = String(getSessionId())
  check('the list id is the session id', tasks.getTaskListId() === own, tasks.getTaskListId())
  const before = await tasks.createTask(own, { subject: 'review next session planning doc', description: '', activeForm: 'Reviewing the planning doc', status: 'in_progress', blocks: [], blockedBy: [] })
  const mission = await tasks.listSessionMission()
  check("the session's mission lists its own row", mission.some(t => t.id === before), j(mission.map(t => t.id)))
  check('no row twice', new Set(mission.map(t => t.id)).size === mission.length)
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
