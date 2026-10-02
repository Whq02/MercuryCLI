#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'respawn-asks-')))
const daemonDir = join(SCRATCH, 'daemon')
mkdirSync(daemonDir, { recursive: true })
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
process.env.ANTHROPIC_API_KEY = 'fixture-key-000'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const until = async (pred: () => Promise<boolean> | boolean, ms: number): Promise<boolean> => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      if (await pred()) return true
    } catch {
    }
    await sleep(50)
  }
  return false
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT: the respawn-retires-asks proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()
process.on('exit', () => {
  try {
    rmSync(SCRATCH, { recursive: true, force: true })
  } catch {
  }
})

console.log('============================================================')
console.log(" a parked permission ask dies with the runner that raised it: a respawn or an exit retires it typed, and a late answer is refused, never written into a child that never asked")
console.log('============================================================')

const asks = await import('../../src/daemon/permissionAsks.ts')
const seat = await import('../../src/daemon/sessionSeat.ts')
const { concourseWorkersPath } = await import('../../src/daemon/concourseSupervisor.ts')
const obligations = await import('../../src/services/crew/obligations.ts')

type Presence = 'attached' | 'absent' | 'unknown'
const onAsk = asks.onWorkerControlRequest as unknown as (
  short: string,
  frame: Record<string, unknown>,
  dir?: string,
  channel?: { control(short: string, frame: string): boolean },
  expiryMs?: number,
  presence?: (dir?: string) => Presence,
) => void

const record = (short: string): Record<string, unknown> => ({
  runnerId: short,
  sessionId: `sess-${short}`,
  workspaceId: join(SCRATCH, 'ws'),
  title: `t-${short}`,
  createdAt: Date.now(),
  startedAt: Date.now(),
})
writeFileSync(concourseWorkersPath(daemonDir), JSON.stringify({ version: 1, workers: { 'concourse-w1': record('concourse-w1'), 'concourse-w2': record('concourse-w2') } }))

const written: Array<{ short: string; frame: Record<string, unknown> }> = []
const roster = {
  control: (short: string, frame: string) => (written.push({ short, frame: JSON.parse(frame) as Record<string, unknown> }), true),
  list: () => [],
  patchSeatModel: () => true,
  patchSeatEffort: () => true,
}
const askFrame = (id: string, tool: string): Record<string, unknown> => ({
  type: 'control_request',
  request_id: id,
  request: { subtype: 'can_use_tool', tool_name: tool, input: { command: 'git push' }, tool_use_id: `tu-${id}` },
})
const answersFor = (id: string): Array<Record<string, unknown>> =>
  written.filter(w => (w.frame as { type?: string }).type === 'control_response' && (w.frame as { response?: { request_id?: string } }).response?.request_id === id).map(w => w.frame)
const parked = (id: string): boolean => asks.listPendingPermissionAsks().some(a => a.requestId === id)
type Row = { ref?: string; status?: string; settlement?: { by?: string } }
const rowFor = async (id: string): Promise<Row | undefined> => {
  const rows = (await obligations.listObligations({ scope: 'switchboard' } as never)) as Row[]
  return rows.find(o => o.ref === `permission:${id}`)
}

section('§1 the ask parks and its needs-you row opens')
onAsk('concourse-w1', askFrame('req-respawn', 'Bash'), daemonDir, roster, 0, () => 'attached')
check('the ask is parked for its worker', parked('req-respawn'))
check('nothing was written into the child', answersFor('req-respawn').length === 0)
check('its needs-you row is open', await until(async () => (await rowFor('req-respawn'))?.status === 'open', 5_000))

section("§2 the worker respawns — the ask dies with the runner that raised it")
seat.onSeatSpawned('concourse-w1', roster as never, daemonDir)
check('red on the base: the parked ask is gone after the respawn', !parked('req-respawn'), j(asks.listPendingPermissionAsks()))
const row = await (async () => {
  await until(async () => (await rowFor('req-respawn'))?.status === 'withdrawn', 5_000)
  return rowFor('req-respawn')
})()
check('red on the base: its needs-you row reads withdrawn by the daemon, naming the restart', row?.status === 'withdrawn' && /runner restarted before this ask was answered/.test(row.settlement?.by ?? ''), j(row))

section("§3 the operator's late answer is refused typed — never written into the new child")
const before = written.length
const late = asks.answerPermissionAsk('req-respawn', true, roster, 'operator')
check("red on the base: the answer is refused (the base reports 'applied' while nothing runs)", late.outcome === 'refused', j(late))
check('red on the base: the refusal names the restart', /runner restarted before this ask was answered/.test(late.detail ?? ''), j(late))
check('red on the base: no control_response was written into the respawned child', written.length === before && answersFor('req-respawn').length === 0, j(answersFor('req-respawn')))

section("§4 a worker that ends retires its asks the same way")
onAsk('concourse-w2', askFrame('req-ended', 'Bash'), daemonDir, roster, 0, () => 'attached')
check('the ask is parked for the second worker', parked('req-ended'))
seat.onSeatSettled('concourse-w2')
check('red on the base: the parked ask is gone after the exit', !parked('req-ended'))
const ended = asks.answerPermissionAsk('req-ended', false, roster, 'operator')
check('red on the base: the late answer is refused naming the exit', ended.outcome === 'refused' && /runner ended before this ask was answered/.test(ended.detail ?? ''), j(ended))
check('red on the base: its needs-you row reads withdrawn naming the exit', await until(async () => {
  const r = await rowFor('req-ended')
  return r?.status === 'withdrawn' && /runner ended before this ask was answered/.test(r.settlement?.by ?? '')
}, 5_000))

section("§5 another worker's ask is untouched by the respawn")
onAsk('concourse-w1', askFrame('req-stays', 'Bash'), daemonDir, roster, 0, () => 'attached')
onAsk('concourse-w2', askFrame('req-other', 'Bash'), daemonDir, roster, 0, () => 'attached')
seat.onSeatSpawned('concourse-w1', roster as never, daemonDir)
check("the respawned worker's ask is retired", !parked('req-stays'))
check("the other worker's ask still parks", parked('req-other'))
const other = asks.answerPermissionAsk('req-other', false, roster, 'operator')
check("...and the operator's answer still lands there", other.outcome === 'applied' && answersFor('req-other').length === 1, j(other))

console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ respawn retires asks: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('✅ respawn retires asks: a parked ask dies with its runner; a late answer is refused typed')
process.exit(0)
