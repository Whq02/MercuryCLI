#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { hostRunner, type HostedRunner } from '../lib/runnerHost.ts'
import { startScriptedFixture, type ScriptedRequest, type WireBlock } from '../lib/scriptedTurn.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.log('  [SKIP] dist/mercury.mjs absent — build first (the gate prebuilds)')
  process.exit(0)
}
const nodeBin = Bun.which('node')
if (!nodeBin) {
  console.log('❌ no node binary on PATH')
  process.exit(1)
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v)
const MODEL = 'claude-opus-5'
const PROBE = 'posture-probe'
const ASK = 'seat posture: run the shell probe'
const POSTURE_LINE = /Permission mode for this run: ([a-zA-Z]+)\./
const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — the seat posture proof exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

const script = (req: ScriptedRequest): WireBlock[] => {
  if (!req.toolNames.includes('Bash')) return [{ type: 'text', text: 'side call answered' }]
  if (req.step === 0) return [{ type: 'tool_use', name: 'Bash', input: { command: `printf ${PROBE}` } }]
  return [{ type: 'text', text: 'the probe ran' }]
}

type World = { home: string; cwd: string }
function seedWorld(): World {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'seat-posture-home-')))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'seat-posture-cwd-')))
  seedFirstRun(home, [cwd])
  writeFileSync(join(home, 'settings.json'), '{}\n')
  return { home, cwd }
}
function worldEnv(world: World, fixtureBase: string): Record<string, string> {
  return {
    HOME: world.home,
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    TERM: 'dumb',
    MERCURY_CONFIG_DIR: world.home,
    MERCURY_DAEMON_DIR: join(world.home, 'daemon'),
    MERCURY_TMPDIR: join(world.home, 'tmp'),
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_CONCOURSE_WORKER: '1',
    ANTHROPIC_BASE_URL: fixtureBase,
    ANTHROPIC_API_KEY: 'fixture-key-000',
    OPENAI_API_KEY: '',
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_OPERATOR: 'sam',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_OASIS_BG: '0',
    MERCURY_THINKING_BINDING: 'drop_block',
  }
}

type Seat = { host: HostedRunner; world: World; sessionId: string }

async function bootSeat(fixtureBase: string): Promise<Seat> {
  const world = seedWorld()
  const host = hostRunner({ dist: DIST, node: nodeBin!, cwd: world.cwd, home: world.home, env: worldEnv(world, fixtureBase), argv: ['--allow-sovereign', '--model', MODEL] })
  host.onAsk(params => (params.kind === 'tool' ? { outcome: 'allow', input: params.input } : { outcome: 'deny' }))
  const init = await host.initialize({ holds_asks: true })
  check('the runner boots warm (no session identity until the claim), the way the daemon spawns a seat', init.session_id === null, j(init))
  return { host, world, sessionId: randomUUID() }
}

async function claim(seat: Seat, mode: string): Promise<unknown> {
  return seat.host
    .request('session/claim', { session_id: seat.sessionId, model: MODEL, mode, effort: 'high' } as never, 60_000)
    .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
}

async function turn(seat: Seat): Promise<{ outcome: Record<string, unknown>; toolResult: string }> {
  await seat.host.prompt(ASK)
  const outcome = (await seat.host.waitFor('outcome', row => row.type === 'outcome', 90_000)) as Record<string, unknown>
  const toolResult = seat.host.rows
    .filter(row => row.type === 'tool_result')
    .map(row => j(row))
    .join(' | ')
  return { outcome, toolResult }
}

async function settle(seat: Seat): Promise<void> {
  await seat.host.stop(5_000)
  rmSync(seat.world.home, { recursive: true, force: true })
  rmSync(seat.world.cwd, { recursive: true, force: true })
}

const postureOf = (system: string): string | null => {
  const hit = POSTURE_LINE.exec(system)
  return hit === null ? null : hit[1]!
}

section("§1 a cockpit's Sovereign birth claims a warm seat: the seat holds Sovereign, and its posture line says so")
{
  const fixture = await startScriptedFixture(script)
  const seat = await bootSeat(fixture.base)
  const claimed = await claim(seat, 'sovereign')
  check('the claim with the Sovereign posture lands (the runner booted with --allow-sovereign)', typeof claimed === 'object' && claimed !== null && (claimed as { session_id?: unknown }).session_id === seat.sessionId, j(claimed))
  const { outcome, toolResult } = await turn(seat)
  check('the turn settles', outcome.status === 'completed', j({ status: outcome.status, stderr: seat.host.stderr().slice(-300) }))
  check('the seat IS in Sovereign: the shell probe ran with no permission ask reaching the host', seat.host.asks.length === 0 && toolResult.includes(PROBE), `asks=${j(seat.host.asks.map(a => a.params))} tool_result=${toolResult.slice(0, 300)}`)
  const systems = fixture.requests.filter(req => req.toolNames.includes('Bash')).map(req => req.system)
  const postures = systems.map(postureOf)
  check('every request of the turn carried the posture line', postures.length > 0 && postures.every(p => p !== null), j(postures))
  check('the posture line names the mode the seat holds — sovereign, the claimed posture, never the warm boot\'s default', postures.every(p => p === 'sovereign'), `postures=${j(postures)}`)
  await settle(seat)
  await fixture.close()
}

section("§2 the carousel before the first turn: a seat claimed in Default and switched to Flow by session/set_mode says Flow")
{
  const fixture = await startScriptedFixture(script)
  const seat = await bootSeat(fixture.base)
  const claimed = await claim(seat, 'default')
  check('the claim with the Default posture lands', typeof claimed === 'object' && claimed !== null && (claimed as { session_id?: unknown }).session_id === seat.sessionId, j(claimed))
  const switched = await seat.host.request('session/set_mode', { mode: 'flow' } as never, 30_000).catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
  check('the mode door applies Flow', typeof switched === 'object' && switched !== null && (switched as { mode?: unknown }).mode === 'flow', j(switched))
  const { outcome, toolResult } = await turn(seat)
  check('the turn settles', outcome.status === 'completed', j({ status: outcome.status, stderr: seat.host.stderr().slice(-300) }))
  check('the seat IS in Flow: the shell probe asked the host, and the ask carried mode flow on the wire', seat.host.asks.length === 1 && seat.host.asks[0]!.params.kind === 'tool' && (seat.host.asks[0]!.params as { mode?: unknown }).mode === 'flow' && toolResult.includes(PROBE), `asks=${j(seat.host.asks.map(a => a.params))} tool_result=${toolResult.slice(0, 300)}`)
  const postures = fixture.requests.filter(req => req.toolNames.includes('Bash')).map(req => postureOf(req.system))
  check('the posture line names the mode the seat holds — flow, the carousel\'s word, never the warm boot\'s default', postures.length > 0 && postures.every(p => p === 'flow'), `postures=${j(postures)}`)
  await settle(seat)
  await fixture.close()
}

clearTimeout(guard)
console.log(failures ? `\n❌ seat posture follows the claim: ${failures} FAILED` : '\n✅ seat posture follows the claim: ALL PASS')
process.exit(failures ? 1 : 0)
