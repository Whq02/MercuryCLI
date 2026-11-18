import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'schedule-control-roster-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = join(home, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const ROOT = resolve(import.meta.dir, '..', '..')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const seat = await import('../../src/daemon/sessionSeat.ts')
const { standInRunner } = await import('../lib/seatDoor.ts')
const { updateConcourseWorkers, concourseWorkersPath } = await import('../../src/daemon/concourseWorkers.ts')
let failures = 0
function check(label: string, ok: boolean, detail = ''): void { if (!ok) failures++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${detail}`}`) }
const control = (seat as Record<string, unknown>).applySeatScheduleControl as ((sessionId: string, edit: unknown, by: string, roster: unknown, dir?: string, deps?: unknown) => { outcome: string; detail?: string; scheduleId?: string }) | undefined
check('the daemon seat owns the schedule control arm (applySeatScheduleControl)', typeof control === 'function')
const SHORT = 'concourse-board-proof'
const SESSION = 'schedule-board-fixture'
const dir = process.env.MERCURY_DAEMON_DIR
const seed = () => updateConcourseWorkers(workers => {
  for (const k of Object.keys(workers)) delete workers[k]
  workers[SHORT] = { schema: 1, runnerId: SHORT, sessionId: SESSION, workspaceId: home, isolation: 'shared', modelKey: 'fixture-model', spawnedAt: Date.now(), lastLiveAt: Date.now() } as never
}, dir)
const rows = (): Array<{ id: string }> => JSON.parse(readFileSync(concourseWorkersPath(dir), 'utf8')).workers[SHORT].schedules ?? []
const deps = { deriveAccount: () => ({ ok: true, account: { family: 'fixture', source: 'api-key' } }), preflight: () => ({ state: 'ok' }) }
const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
type Push = { method: string; params: unknown }
const rosterPushes = (requests: Push[]): Array<{ ids: string[] }> =>
  requests.filter(r => r.method === 'schedule/roster').map(r => ({ ids: ((r.params as { schedules?: Array<{ id?: string }> }).schedules ?? []).map(s => String(s.id)) }))
const factsAsks = (requests: Push[]): number => requests.filter(r => r.method === 'session/facts').length
try {
  if (control !== undefined) {
    seed()
    const stand = standInRunner({ autoAnswer: { 'session/facts': {} } })
    try {
      await stand.connection.initialized
      const roster = stand.roster()
      const edit = { op: 'add', schedule: { when: { kind: 'at', atMs: Date.now() + 3_600_000, spelling: 'board proof' }, action: { kind: 'fire', prompt: 'remind me', onParked: 'queue' }, title: 'board' } }
      const added = control(SESSION, edit, 'operator', roster, dir, deps)
      await settle()
      const id = added.scheduleId ?? ''
      check("the board's add applies and mints the id the record holds", added.outcome === 'applied' && /^[0-9a-f]{8}$/.test(id) && rows()[0]?.id === id, JSON.stringify({ added, rows: rows() }))
      const afterAdd = rosterPushes(stand.requests)
      check('the add is followed by a schedule/roster push carrying the new id', afterAdd.length === 1 && afterAdd[0]!.ids.includes(id), JSON.stringify(afterAdd))
      check('…and by a facts request for the seat', factsAsks(stand.requests) === 1, String(factsAsks(stand.requests)))

      const removed = control(SESSION, { op: 'remove', scheduleId: id }, 'operator', roster, dir, deps)
      await settle()
      check("the board's remove applies and the record no longer holds the id", removed.outcome === 'applied' && !rows().some(r => r.id === id), JSON.stringify({ removed, rows: rows() }))
      const afterRemove = rosterPushes(stand.requests)
      check('the remove is followed by a schedule/roster push WITHOUT the id (the session\'s CronList reads an empty roster)', afterRemove.length === 2 && afterRemove[1]!.ids.length === 0, JSON.stringify(afterRemove))
      check('…and by a second facts request', factsAsks(stand.requests) === 2, String(factsAsks(stand.requests)))

      const again = control(SESSION, { op: 'remove', scheduleId: id }, 'operator', roster, dir, deps)
      await settle()
      check('a remove of an id already gone is a noop or refusal and pushes nothing', again.outcome !== 'applied' && rosterPushes(stand.requests).length === 2, JSON.stringify({ again, pushes: rosterPushes(stand.requests) }))

      const refused = control(SESSION, { op: 'add', schedule: edit.schedule }, 'operator', roster, dir, { deriveAccount: () => ({ ok: false, reason: 'no-credential:fixture — connect an account' }) })
      await settle()
      check('a refused add pushes nothing', refused.outcome === 'refused' && rosterPushes(stand.requests).length === 2, JSON.stringify(refused))

      const noRoster = control(SESSION, edit, 'operator', null, dir, deps)
      await settle()
      check('with no roster the op still applies (the push is best-effort) and no door is touched', noRoster.outcome === 'applied' && rosterPushes(stand.requests).length === 2, JSON.stringify(noRoster))

      const unknown = control('no-such-session', { op: 'remove', scheduleId: id }, 'operator', roster, dir, deps)
      check('an unknown session is refused with the writer\'s words', unknown.outcome === 'refused', JSON.stringify(unknown))
    } finally { stand.close() }
  }
  const main = readFileSync(join(ROOT, 'src/daemon/main.ts'), 'utf8')
  check("the daemon's set-schedule control arm returns the seat function's result through settle", main.includes("return settle(applySeatScheduleControl(sessionId, scheduleEdit, by, roster))"))
  check('the control arm no longer applies the op on its own', !main.includes('applyConcourseScheduleOp(sessionId, scheduleEdit, by, {'))
  const seatSrc = readFileSync(join(ROOT, 'src/daemon/sessionSeat.ts'), 'utf8')
  check('the seat function pushes the roster and asks for facts by the record\'s runnerId after an applied op', /applySeatScheduleControl[\s\S]{0,900}pushScheduleRoster\(rec\.runnerId, roster, dir\)\s*\n\s*requestSessionFacts\(rec\.runnerId, roster, \{ immediate: true \}, dir\)/.test(seatSrc))
} finally {
  rmSync(home, { recursive: true, force: true })
}
console.log(`schedule control roster: ${failures} failures`)
process.exitCode = failures ? 1 : 0
