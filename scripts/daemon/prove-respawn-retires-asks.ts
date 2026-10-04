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
const { concourseWorkersPath } = await import('../../src/daemon/concourseWorkers.ts')
const obligations = await import('../../src/services/crew/obligations.ts')

type Presence = 'attached' | 'absent' | 'unknown'
type Answer = import('../../src/runner/wire/methods.ts').PermissionAnswer
const record = (short: string): Record<string, unknown> => ({
  runnerId: short,
  sessionId: `sess-${short}`,
  workspaceId: join(SCRATCH, 'ws'),
  title: `t-${short}`,
  createdAt: Date.now(),
  startedAt: Date.now(),
})
writeFileSync(concourseWorkersPath(daemonDir), JSON.stringify({ version: 1, workers: { 'concourse-w1': record('concourse-w1'), 'concourse-w2': record('concourse-w2') } }))

const roster = { door: () => undefined, list: () => [], patchSeatModel: () => true, patchSeatEffort: () => true }
const held = new Map<string, { answer: Answer | null }>()
const ask = (short: string, tag: string, tool: string, presence: Presence = 'attached'): string | undefined => {
  const entry: { answer: Answer | null } = { answer: null }
  const h = asks.holdWorkerAsk(short, { kind: 'tool', tool_use_id: `tu-${tag}`, tool_name: tool, input: { command: 'git push' } }, daemonDir, 0, () => presence)
  void h.answer.then(a => {
    entry.answer = a
  })
  held.set(tag, entry)
  const id = asks.listPendingPermissionAsks().filter(a => a.workerId === short).at(-1)?.requestId
  if (id !== undefined) ids.set(tag, id)
  return id
}
const ids = new Map<string, string>()
const idOf = (tag: string): string => ids.get(tag) ?? `(no ask ${tag})`
const answered = (tag: string): Answer | null => held.get(tag)?.answer ?? null
const tick = (): Promise<void> => new Promise(r => setTimeout(r, 20))
const parked = (id: string): boolean => asks.listPendingPermissionAsks().some(a => a.requestId === id)
type Row = { ref?: string; status?: string; settlement?: { by?: string } }
const rowFor = async (id: string): Promise<Row | undefined> => {
  const rows = (await obligations.listObligations({ scope: 'switchboard' } as never)) as Row[]
  return rows.find(o => o.ref === `permission:${id}`)
}

section('§1 the ask parks and its needs-you row opens')
ask('concourse-w1', 'respawn', 'Bash')
await tick()
check('the ask is parked for its worker', parked(idOf('respawn')))
check("the runner's request is still unanswered", answered('respawn') === null)
check('its needs-you row is open', await until(async () => (await rowFor(idOf('respawn')))?.status === 'open', 5_000))

section("§2 the worker respawns — the ask dies with the runner that raised it")
seat.onSeatSpawned('concourse-w1', roster as never, daemonDir)
check('red on the base: the parked ask is gone after the respawn', !parked(idOf('respawn')), j(asks.listPendingPermissionAsks()))
const row = await (async () => {
  await until(async () => (await rowFor(idOf('respawn')))?.status === 'withdrawn', 5_000)
  return rowFor(idOf('respawn'))
})()
check('red on the base: its needs-you row reads withdrawn by the daemon, naming the restart', row?.status === 'withdrawn' && /runner restarted before this ask was answered/.test(row.settlement?.by ?? ''), j(row))

section("§3 the operator's late answer is refused typed — never written into the new child")
const late = asks.answerPermissionAsk(idOf('respawn'), true, 'operator')
check("red on the base: the answer is refused (the base reports 'applied' while nothing runs)", late.outcome === 'refused', j(late))
check('red on the base: the refusal names the restart', /runner restarted before this ask was answered/.test(late.detail ?? ''), j(late))
await tick()
check('red on the base: no allow reached the dead runner\'s request — the respawned child hears nothing of it', answered('respawn')?.outcome !== 'allow', j(answered('respawn')))

section("§4 a worker that ends retires its asks the same way")
ask('concourse-w2', 'ended', 'Bash')
check('the ask is parked for the second worker', parked(idOf('ended')))
seat.onSeatSettled('concourse-w2')
check('red on the base: the parked ask is gone after the exit', !parked(idOf('ended')))
const ended = asks.answerPermissionAsk(idOf('ended'), false, 'operator')
check('red on the base: the late answer is refused naming the exit', ended.outcome === 'refused' && /runner ended before this ask was answered/.test(ended.detail ?? ''), j(ended))
check('red on the base: its needs-you row reads withdrawn naming the exit', await until(async () => {
  const r = await rowFor(idOf('ended'))
  return r?.status === 'withdrawn' && /runner ended before this ask was answered/.test(r.settlement?.by ?? '')
}, 5_000))

section("§5 another worker's ask is untouched by the respawn")
ask('concourse-w1', 'stays', 'Bash')
ask('concourse-w2', 'other', 'Bash')
seat.onSeatSpawned('concourse-w1', roster as never, daemonDir)
check("the respawned worker's ask is retired", !parked(idOf('stays')))
check("the other worker's ask still parks", parked(idOf('other')))
const other = asks.answerPermissionAsk(idOf('other'), false, 'operator')
await tick()
check("...and the operator's answer still lands there — the runner's request resolves deny", other.outcome === 'applied' && answered('other')?.outcome === 'deny', j({ other, answer: answered('other') }))

console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ respawn retires asks: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('✅ respawn retires asks: a parked ask dies with its runner; a late answer is refused typed')
process.exit(0)
