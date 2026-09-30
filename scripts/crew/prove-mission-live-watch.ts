#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'mission-live-watch-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_EVOLUTION_LEDGER = '0'
for (const key of ['MERCURY_CREW', 'MERCURY_CREW_AGENT', 'MERCURY_CREW_DIR', 'MERCURY_CREWS_DIR', 'MERCURY_TASK_LIST_ID']) delete process.env[key]

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)

let failures = 0
function check(label: string, good: boolean, detail = ''): void {
  if (!good) failures++
  console.log(`  [${good ? 'PASS' : 'FAIL'}] ${label}${!good && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}
const sleep = (ms: number): Promise<void> => new Promise<void>(resolve => setTimeout(resolve, ms))
const j = (v: unknown): string => JSON.stringify(v)

const { getSessionId } = await import('../../src/bootstrap/state.js')
const tasks = (await import('../../src/utils/tasks.js')) as typeof import('../../src/utils/tasks.js')
const live = (await import('../../src/services/crew/liveComms.js')) as typeof import('../../src/services/crew/liveComms.js')
const { crewStoreRoot } = await import('../../src/services/crew/identity.js')

const own = String(getSessionId())
const liveFileOf = (crew: string): string => join(crewStoreRoot(), 'livecomms', `${live.liveCommsKey(crew)}.json`)
const writeLive = (crew: string, subjects: string[]): void => {
  mkdirSync(join(crewStoreRoot(), 'livecomms'), { recursive: true })
  const now = Date.now()
  const rows = Object.fromEntries(
    subjects.map((subject, i) => [String(i + 1), { id: String(i + 1), subject, status: 'pending', blockedBy: [], createdBy: 'alpha', createdAt: now + i, updatedAt: now + i }]),
  )
  writeFileSync(liveFileOf(crew), JSON.stringify({ schema: 1, crew, seq: subjects.length, messages: [], tasks: rows, busy: {} }, null, 2))
}
async function firedWithin(ms: number, write: () => void): Promise<number> {
  let fired = 0
  const stop = tasks.onTasksUpdated(() => {
    fired++
  })
  write()
  const deadline = Date.now() + ms
  while (fired === 0 && Date.now() < deadline) await sleep(100)
  stop()
  return fired
}

console.log('============================================================')
console.log(" The session's mission watches a crew's live ledger only while a crew stands")
console.log(' The live ledger (crew/livecomms/<crew>.json) is a crew\'s; the watch on it stats')
console.log(' the file once a second for as long as it is held, and a session with no crew')
console.log(' used to hold one on a file keyed by its own id — a crew that did not exist.')
console.log(` home ${HOME}`)
console.log('============================================================')

section('§1 no crew: the mission is the session\'s own list alone, and nothing watches the session-keyed live file')
{
  check('with no crew the list id is the session id', tasks.getTaskListId() === own, tasks.getTaskListId())
  writeLive(own, ['a row nobody should read'])
  const mine = await tasks.createTask(own, { subject: "the session's own row", description: '', status: 'pending', blocks: [], blockedBy: [] })
  const rows = await tasks.listSessionMission()
  check("the mission lists the session's own row", rows.some(r => r.id === mine), j(rows.map(r => r.id)))
  check('…and no live row (the file keyed by the session id is no crew\'s ledger while no crew stands)', !rows.some(r => r.id.startsWith('livecomms:')), j(rows.map(r => r.id)))
  const stats = live._statsForProofs(own)
  check('the mission read armed no listener, no watcher, no poll and no floor on that file', stats.listeners === 0 && !stats.watcher && !stats.pollTimer && !stats.pollFloorTimer, j(stats))
  const fired = await firedWithin(1500, () => writeLive(own, ['a row nobody should read', 'a second one']))
  check('a write to that file wakes nothing (no signal in 1.5 s)', fired === 0, `fired ${fired}`)
}

section('§2 the born crew stands (the leader registers it, as the spawn does on the first crewmate\'s row): the first mission read after that holds the watch')
{
  tasks.setLeaderCrewName(own)
  check('the registered born crew keeps the session id as the list id (the born crew\'s name is the session id)', tasks.getTaskListId() === own, tasks.getTaskListId())
  const rows = await tasks.listSessionMission()
  check('the first mission read after the crew stands lists the live rows', rows.filter(r => r.id.startsWith('livecomms:')).length === 2, j(rows.map(r => [r.id, r.subject])))
  const stats = live._statsForProofs(own)
  check('…and holds one listener on the crew\'s live file (the watch is armed as before)', stats.listeners === 1, j(stats))
  const fired = await firedWithin(8000, () => writeLive(own, ['a row nobody should read', 'a second one', 'a late one']))
  check('a later write to the live file fires the tasks-updated signal', fired > 0, `fired ${fired}`)
  const again = await tasks.listSessionMission()
  check('the next read lists the late row', again.some(r => r.subject === 'a late one'), j(again.map(r => r.subject)))
  const stillOne = live._statsForProofs(own)
  check('a second mission read adds no second listener (one watch per crew)', stillOne.listeners === 1, j(stillOne))
  tasks.clearLeaderCrewName()
}

section('§3 an explicit MERCURY_TASK_LIST_ID names a shared board, and is watched like a crew\'s')
{
  process.env.MERCURY_TASK_LIST_ID = 'shared-board'
  writeLive('shared-board', ['the board\'s row'])
  const rows = await tasks.listSessionMission()
  check('the override\'s live rows list beside the session\'s own', rows.some(r => r.id === 'livecomms:1' && r.subject === "the board's row"), j(rows.map(r => [r.id, r.subject])))
  const stats = live._statsForProofs('shared-board')
  check('the override\'s live file holds the watch', stats.listeners === 1, j(stats))
  delete process.env.MERCURY_TASK_LIST_ID
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL MISSION LIVE-WATCH PROOFS PASS')
else console.log(`❌ ${failures} MISSION LIVE-WATCH PROOF(S) FAILED`)
console.log('═'.repeat(76))
rmSync(HOME, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
