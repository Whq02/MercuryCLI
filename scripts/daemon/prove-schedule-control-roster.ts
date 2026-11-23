import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'schedule-control-roster-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = join(home, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const seat = await import('../../src/daemon/session-seat/sessionSeat.ts')
const { standInRunner } = await import('../lib/seatDoor.ts')
const { updateConcourseWorkers, concourseWorkersPath } = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
let failures = 0
function check(label: string, ok: boolean, detail = ''): void { if (!ok) failures++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${detail}`}`) }
const control = (seat as Record<string, unknown>).applySeatScheduleControl as ((sessionId: string, edit: unknown, by: string, roster: unknown, dir?: string, deps?: unknown) => { outcome: string; detail?: string; scheduleId?: string }) | undefined
check('the daemon seat owns the schedule control arm (applySeatScheduleControl)', typeof control === 'function', 'export applySeatScheduleControl from src/daemon/session-seat/sessionSeat.ts (defined in src/daemon/session-seat/facts.ts)')
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
      check("the board's add applies and mints the id the record holds", added.outcome === 'applied' && /^[0-9a-f]{8}$/.test(id) && rows()[0]?.id === id, JSON.stringify({ added, rows: rows() }) + ' | fix the add arm of applySeatScheduleControl in src/daemon/session-seat/facts.ts so it applies and stores the minted id in the concourse worker record')
      const afterAdd = rosterPushes(stand.requests)
      check('the add is followed by a schedule/roster push carrying the new id', afterAdd.length === 1 && afterAdd[0]!.ids.includes(id), JSON.stringify(afterAdd) + ' | applySeatScheduleControl in src/daemon/session-seat/facts.ts must call pushScheduleRoster once after an applied add')
      check('…and by a facts request for the seat', factsAsks(stand.requests) === 1, String(factsAsks(stand.requests)) + ' | applySeatScheduleControl in src/daemon/session-seat/facts.ts must call requestSessionFacts once after an applied add')

      const removed = control(SESSION, { op: 'remove', scheduleId: id }, 'operator', roster, dir, deps)
      await settle()
      check("the board's remove applies and the record no longer holds the id", removed.outcome === 'applied' && !rows().some(r => r.id === id), JSON.stringify({ removed, rows: rows() }) + ' | fix the remove arm of applySeatScheduleControl in src/daemon/session-seat/facts.ts so it applies and drops the id from the worker record')
      const afterRemove = rosterPushes(stand.requests)
      check('the remove is followed by a schedule/roster push WITHOUT the id (the session\'s CronList reads an empty roster)', afterRemove.length === 2 && afterRemove[1]!.ids.length === 0, JSON.stringify(afterRemove) + ' | applySeatScheduleControl / pushScheduleRoster in src/daemon/session-seat/facts.ts must push the roster again after an applied remove, read from the updated record')
      check('…and by a second facts request', factsAsks(stand.requests) === 2, String(factsAsks(stand.requests)) + ' | applySeatScheduleControl in src/daemon/session-seat/facts.ts must call requestSessionFacts after an applied remove too')

      const again = control(SESSION, { op: 'remove', scheduleId: id }, 'operator', roster, dir, deps)
      await settle()
      check('a remove of an id already gone is a noop or refusal and pushes nothing', again.outcome !== 'applied' && rosterPushes(stand.requests).length === 2, JSON.stringify({ again, pushes: rosterPushes(stand.requests) }) + ' | applySeatScheduleControl in src/daemon/session-seat/facts.ts must push the roster only when the outcome is applied')

      const refused = control(SESSION, { op: 'add', schedule: edit.schedule }, 'operator', roster, dir, { deriveAccount: () => ({ ok: false, reason: 'no-credential:fixture — connect an account' }) })
      await settle()
      check('a refused add pushes nothing', refused.outcome === 'refused' && rosterPushes(stand.requests).length === 2, JSON.stringify(refused) + ' | applySeatScheduleControl in src/daemon/session-seat/facts.ts must return refused and push nothing when the account check (deps.deriveAccount) fails')

      const noRoster = control(SESSION, edit, 'operator', null, dir, deps)
      await settle()
      check('with no roster the op still applies (the push is best-effort) and no door is touched', noRoster.outcome === 'applied' && rosterPushes(stand.requests).length === 2, JSON.stringify(noRoster) + ' | applySeatScheduleControl in src/daemon/session-seat/facts.ts must still apply the edit when roster is null and skip the push')

      const unknown = control('no-such-session', { op: 'remove', scheduleId: id }, 'operator', roster, dir, deps)
      check('an unknown session is refused with the writer\'s words', unknown.outcome === 'refused', JSON.stringify(unknown) + ' | applySeatScheduleControl in src/daemon/session-seat/facts.ts must refuse a session id that has no worker record')
    } finally { stand.close() }
  }
} finally {
  rmSync(home, { recursive: true, force: true })
}
console.log(`schedule control roster: ${failures} failures`)
process.exitCode = failures ? 1 : 0
