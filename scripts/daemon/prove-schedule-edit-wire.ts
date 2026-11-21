import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'schedule-edit-wire-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = join(home, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { METHODS, RUNNER_PROTOCOL } = await import('../../src/runner/wire/methods.ts')
const wire = await import('../../src/services/engine-connector/seatWire.ts')
const seat = await import('../../src/daemon/sessionSeat.ts')
const { standInRunner } = await import('../lib/seatDoor.ts')
const { updateConcourseWorkers, concourseWorkersPath } = await import('../../src/daemon/concourseWorkers.ts')
let failures = 0
function check(label: string, ok: boolean, detail = ''): void { if (!ok) failures++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`) }
const method = (METHODS as Record<string, any>)['schedule/edit']
check('schedule/edit is a runner request with a ten-second deadline and no chained scope', method?.from === 'runner' && method.kind === 'request' && method.scope === 'none' && method.deadlineMs === 10000, `the schedule/edit entry in src/runner/wire/sessionVerbs.ts must be from runner, kind request, scope none, deadlineMs 10_000; got ${JSON.stringify(method ? { from: method.from, kind: method.kind, scope: method.scope, deadlineMs: method.deadlineMs } : null)}`)
check('protocol and roster contract are unchanged', RUNNER_PROTOCOL === 1 && METHODS['schedule/roster'].scope === 'session' && METHODS['schedule/roster'].params().safeParse({ schedules: [] }).success, 'RUNNER_PROTOCOL in src/runner/wire/methods.ts and the schedule/roster entry in src/runner/wire/sessionVerbs.ts (scope session, params { schedules }) must stay as they were')
const answerEdit = (seat as Record<string, any>).answerSeatScheduleEdit
check('daemon handler exists', typeof answerEdit === 'function', 'export answerSeatScheduleEdit from src/daemon/sessionSeat.ts (defined in src/daemon/sessionSeat/facts.ts)')
const SHORT = 'concourse-wire-proof'
const SESSION = 'schedule-wire-fixture'
const dir = process.env.MERCURY_DAEMON_DIR
const seed = () => updateConcourseWorkers(workers => {
  for (const k of Object.keys(workers)) delete workers[k]
  workers[SHORT] = { schema: 1, runnerId: SHORT, sessionId: SESSION, workspaceId: home, isolation: 'shared', modelKey: 'fixture-model', spawnedAt: Date.now(), lastLiveAt: Date.now() } as never
}, dir)
const rows = (): any[] => JSON.parse(readFileSync(concourseWorkersPath(dir), 'utf8')).workers[SHORT].schedules ?? []
try {
  if (method && answerEdit) {
    seed()
    let deps: any = { deriveAccount: () => ({ ok: true, account: { family: 'fixture', source: 'api-key' } }), preflight: () => ({ state: 'rate-limited', retryAt: 1791385380000 }) }
    const stand = standInRunner({ hooks: { onScheduleEdit: (params: unknown) => answerEdit(SHORT, params, stand.roster(), dir, deps) } as never, autoAnswer: { 'session/facts': {} } })
    try {
      await stand.connection.initialized
      const atMs = Date.now() + 3600000
      const edit = { op: 'add', schedule: { when: { kind: 'at', atMs, spelling: 'wire proof' }, action: { kind: 'fire', prompt: 'wire prompt', onParked: 'queue' }, title: 'wire' } }
      const encoded = (wire as Record<string, any>).scheduleEditToWire(edit)
      check('single edit codec shares the facts road spelling', JSON.stringify(encoded) === JSON.stringify((wire.sessionFactsToWire({ pendingScheduleEdits: [edit] } as never).pending_schedule_edits as unknown[])[0]) && JSON.stringify((wire as Record<string, any>).scheduleEditFromWire(encoded)) === JSON.stringify(edit), 'scheduleEditToWire and scheduleEditFromWire in src/services/engine-connector/seatWire.ts must encode an edit exactly as the pending_schedule_edits rows of sessionFactsToWire do, and round-trip it')
      const answer: any = await stand.runner.request('schedule/edit' as never, { edit: encoded } as never)
      check('real wire returns minted id, authoritative instant, zone and preflight', answer.outcome === 'applied' && /^[0-9a-f]{8}$/.test(answer.schedule_id) && answer.schedule_id === rows()[0]?.id && answer.next_fire_ms === atMs && answer.time_zone === Intl.DateTimeFormat().resolvedOptions().timeZone && answer.preflight?.retry_at === 1791385380000, `answerSeatScheduleEdit in src/daemon/sessionSeat/facts.ts must answer outcome applied with the minted schedule_id (also written to the worker record), next_fire_ms, time_zone and preflight.retry_at; got ${JSON.stringify(answer)}`)
      await new Promise(resolve => setImmediate(resolve))
      check('writer result pushes roster with minted id', stand.requests.some(r => r.method === 'schedule/roster' && JSON.stringify(r.params).includes(answer.schedule_id)), 'answerSeatScheduleEdit in src/daemon/sessionSeat/facts.ts must call pushScheduleRoster after a writer result so the schedule/roster request carries the minted id')
      const before = JSON.stringify(rows())
      deps = { deriveAccount: () => ({ ok: false, reason: 'no-credential:openai — connect an account' }) }
      const refusal: any = await stand.runner.request('schedule/edit' as never, { edit: encoded } as never)
      check('wire returns writer refusal without a record write', refusal.outcome === 'refused' && refusal.detail === 'schedule refused — no-credential:openai — connect an account' && JSON.stringify(rows()) === before, `answerSeatScheduleEdit in src/daemon/sessionSeat/facts.ts must return the writer's refusal detail unchanged and write no schedule row; got ${JSON.stringify(refusal)}`)
      const bad: any = await stand.runner.request('schedule/edit' as never, { edit: { op: 'frobnicate' } } as never)
      check('unknown operation refuses with writer-shaped words', bad.outcome === 'refused' && bad.detail === 'schedule refused — op must be add|remove|pause|resume', `answerSeatScheduleEdit in src/daemon/sessionSeat/facts.ts must refuse an unknown op with this exact detail; got ${JSON.stringify(bad)}`)
      const ended = answerEdit('absent', { edit: encoded }, stand.roster(), dir, deps)
      check('no live record refuses visibly', ended.outcome === 'refused' && ended.detail === 'unknown-session: no live worker record owns this session', `answerSeatScheduleEdit in src/daemon/sessionSeat/facts.ts must refuse with this exact detail when no worker record exists for the runner; got ${JSON.stringify(ended)}`)
    } finally { stand.close() }
    const old = standInRunner()
    try {
      await old.connection.initialized
      let code: unknown
      try { await old.runner.request('schedule/edit' as never, { edit: { op: 'add' } } as never) } catch (error) { code = (error as { code?: unknown }).code }
      check('host without hook answers unknown method for lawful fallback', code === -32601, `a host with no onScheduleEdit hook must answer the schedule/edit request with code -32601 (the runner wire in src/runner/wire); got ${String(code)}`)
    } finally { old.close() }
  }
} finally {
  rmSync(home, { recursive: true, force: true })
}
console.log(`schedule edit wire: ${failures} failures`)
process.exitCode = failures ? 1 : 0
