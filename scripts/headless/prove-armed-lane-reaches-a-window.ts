#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { handoffTurn, isHandoffRequest, startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const proofHome = mkdtempSync(join(tmpdir(), 'armed-lane-home-'))
process.env.MERCURY_CONFIG_DIR = proofHome
delete process.env.MERCURY_HOME
process.on('exit', () => rmSync(proofHome, { recursive: true, force: true }))
const { hostRunner } = await import('../lib/runnerHost.ts')
process.env.MERCURY_CREDENTIAL_STORE ??= 'file'
const DIST = join(ROOT, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('dist/mercury.mjs missing — build the product first')
  process.exit(1)
}
const vendoredNode = join(ROOT, 'dist', 'vendor', 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node')
const NODE = existsSync(vendoredNode) ? vendoredNode : Bun.which('node') ?? 'node'
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const menu = await import('../../src/substrate/startupMenu.ts')
const API_KEY = 'fixture-key-000'
const MODEL = 'claude-opus-4-8'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ' — ' + detail.slice(0, 900) : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const j = (v: unknown): string => JSON.stringify(v) ?? ''
const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — the armed-lane proof exceeded 420s')
  process.exit(1)
}, 420_000)
guard.unref?.()

const ARMED = 'Mercury harness update — the following surfaces just became AVAILABLE in this session:'
const GONE = 'Mercury harness update — the following surfaces are no longer available'
const UNITY = '- Unity lanes are armed:'
const MAP = '# Mercury harness map'

interface World { home: string; cwd: string; bootFile: string; env: Record<string, string> }
function makeWorld(tag: string): World {
  const home = realpathSync(mkdtempSync(join(tmpdir(), `armed-lane-${tag}-`)))
  const cwd = join(home, 'project')
  const configDir = join(home, '.mercury')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(cwd, 'README.md'), '# fixture\n')
  writeFileSync(join(configDir, '.config.json'), JSON.stringify({ theme: 'dark', hasCompletedOnboarding: true, customApiKeyResponses: { approved: [API_KEY.slice(-20)] }, projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } }))
  const bootFile = join(configDir, 'boot-env.json')
  menu.saveBootDefaultsProfile({}, bootFile)
  return {
    home,
    cwd,
    bootFile,
    env: {
      HOME: home,
      PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${dirname(NODE)}`,
      TERM: 'dumb',
      MERCURY_CONFIG_DIR: configDir,
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_BROWSER_NO_DISCOVERY: '1',
      MERCURY_TRUST_DIALOG_ACCEPTED: '1',
      BROWSER: '/usr/bin/true',
      ANTHROPIC_API_KEY: API_KEY,
    },
  }
}
const saveLanes = (world: World, lanes: Record<string, string>): void => {
  const saved = menu.saveBootDefaultsProfile(lanes, world.bootFile, { existingSessionsUnchanged: 1 })
  if (!saved.ok) throw new Error(`the boot menu's file could not be saved: ${saved.reason}`)
}

type Body = { system?: unknown; tools?: unknown; messages?: Array<{ role?: string; content?: unknown }> }
type Step = { ask: string; before?: (world: World) => void }
type Session = { world: World; requests: Body[]; outcomes: string[]; stderr: string }
const replies = (tag: string, count: number): ScriptedTurn[] => Array.from({ length: count }, (_, n) => ({ kind: 'text' as const, text: `${tag}-REPLY-${n + 1}.` }))

async function underAHost(kind: 'oculus' | 'headless', tag: string, steps: Step[], turns: ScriptedTurn[], extraEnv: Record<string, string> = {}): Promise<Session> {
  const fixture = await startFixtureApi([handoffTurn(), handoffTurn(), ...turns])
  const world = makeWorld(tag)
  const host = hostRunner({ dist: DIST, node: NODE, cwd: world.cwd, home: world.home, env: { ...world.env, ...extraEnv, ANTHROPIC_BASE_URL: fixture.url, MERCURY_SESSION_KIND: kind }, argv: ['--model', MODEL] })
  host.onAsk(() => ({ outcome: 'allow' }))
  const killer = setTimeout(() => host.child.kill('SIGKILL'), 150_000)
  const outcomes: string[] = []
  try {
    await host.initialize()
    for (const [n, step] of steps.entries()) {
      step.before?.(world)
      await host.prompt(step.ask)
      const outcome = await host.waitFor(`outcome ${n + 1}`, row => row.type === 'outcome' && row.turn === n + 1, 90_000)
      outcomes.push(String(outcome.status))
    }
  } catch (error) {
    console.log(`  [door] ${error instanceof Error ? error.message : String(error)}`)
  }
  host.end()
  await host.exited
  clearTimeout(killer)
  host.peer.close('the proof ended')
  const requests = fixture.messageRequests().filter(request => !isHandoffRequest(request)).map(request => request.body as Body)
  await fixture.close()
  return { world, requests, outcomes, stderr: host.stderr() }
}

async function throughTheRunDoor(tag: string, steps: Step[], turns: ScriptedTurn[]): Promise<Session> {
  const fixture = await startFixtureApi([handoffTurn(), handoffTurn(), ...turns])
  const world = makeWorld(tag)
  const child = spawn(NODE, [DIST, 'run', '--input', 'rows', '--format', 'rows', '--model', MODEL], { cwd: world.cwd, env: { ...world.env, ANTHROPIC_BASE_URL: fixture.url }, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout!.on('data', chunk => (stdout += String(chunk)))
  child.stderr!.on('data', chunk => (stderr += String(chunk)))
  const exited = new Promise<number | null>(resolveExit => child.on('close', code => resolveExit(code)))
  const outcomesSoFar = (): string[] => stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line) as { type?: string; status?: string }).filter(row => row.type === 'outcome').map(row => String(row.status))
  for (const [n, step] of steps.entries()) {
    step.before?.(world)
    child.stdin!.write(JSON.stringify({ type: 'prompt', content: step.ask }) + '\n')
    const until = Date.now() + 60_000
    while (Date.now() < until && outcomesSoFar().length < n + 1) await new Promise(tick => setTimeout(tick, 20))
  }
  child.stdin!.end()
  const killer = setTimeout(() => child.kill('SIGKILL'), 30_000)
  await exited
  clearTimeout(killer)
  const requests = fixture.messageRequests().filter(request => !isHandoffRequest(request)).map(request => request.body as Body)
  await fixture.close()
  return { world, requests, outcomes: outcomesSoFar(), stderr }
}

const systemOf = (body: Body | undefined): string => {
  const system = body?.system
  if (typeof system === 'string') return system
  return Array.isArray(system) ? system.map(part => String((part as { text?: string }).text ?? '')).join('\n') : ''
}
const count = (value: unknown, words: string): number => j(value).split(j(words).slice(1, -1)).length - 1
const askOf = (body: Body | undefined): string => j(body?.messages?.at(-1) ?? null)
const requestOf = (session: Session, ask: string): Body | undefined => session.requests.find(body => askOf(body).includes(ask))
const updates = (body: Body | undefined): { armed: number; gone: number; own: number } => ({ armed: count(body?.messages ?? [], ARMED), gone: count(body?.messages ?? [], GONE), own: count(body?.messages?.at(-1) ?? null, ARMED) + count(body?.messages?.at(-1) ?? null, GONE) })
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
const ISO = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g
const canon = (value: unknown, world: World): string => j(value).split(basename(world.home)).join('<world>').replace(UUID, '<uuid>').replace(ISO, '<time>')
const withoutMarks = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutMarks)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => key !== 'cache_control').map(([key, inner]) => [key, withoutMarks(inner)]))
  return value
}
const STEPS = (lane: Record<string, string>): Step[] => [
  { ask: 'LANE turn one.' },
  { ask: 'LANE turn two.', before: world => saveLanes(world, lane) },
  { ask: 'LANE turn three.' },
  { ask: 'LANE turn four.', before: world => saveLanes(world, {}) },
  { ask: 'LANE turn five.' },
]

console.log('============================================================')
console.log(' a lane armed in the boot menu reaches a window\'s model: its own line, once')
console.log('============================================================')

section('A — a hosted window: the Unity lane saved on before the second turn and off before the fourth')
const window_ = await underAHost('oculus', 'window', STEPS({ MERCURY_UNITY: '1' }), replies('WINDOW', 5))
const still = await underAHost('oculus', 'still', STEPS({}).slice(0, 2).map(step => ({ ask: step.ask })), replies('WINDOW', 2))
{
  const [one, two, three, four, five] = ['one', 'two', 'three', 'four', 'five'].map(n => requestOf(window_, `LANE turn ${n}.`))
  check('the scene: five turns completed under a host, kind oculus, and the first request holds the map with no Unity line', j(window_.outcomes) === j(['completed', 'completed', 'completed', 'completed', 'completed']) && systemOf(one).includes(MAP) && !systemOf(one).includes(UNITY) && updates(one).armed + updates(one).gone === 0, j({ outcomes: window_.outcomes, map: systemOf(one).includes(MAP), stderr: window_.stderr.slice(-300) }))
  check('A1 the turn after the save carries one update: it names the Unity lane as available, and it rides in that turn\'s own message', j(updates(two)) === j({ armed: 1, gone: 0, own: 1 }) && count(two?.messages?.at(-1) ?? null, UNITY) === 1, j({ updates: updates(two), tail: askOf(two).slice(0, 400) }))
  check('A2 the turn after that carries no new one: the conversation still holds the one', j(updates(three)) === j({ armed: 1, gone: 0, own: 0 }), j(updates(three)))
  check('A3 the lane saved off: the next turn carries one update that says the line no longer applies', j(updates(four)) === j({ armed: 1, gone: 1, own: 1 }) && count(four?.messages?.at(-1) ?? null, UNITY) === 1, j({ updates: updates(four), tail: askOf(four).slice(0, 400) }))
  check('A4 …and the turn after it none: two updates in five turns, each once', j(updates(five)) === j({ armed: 1, gone: 1, own: 0 }), j(updates(five)))
  check('A5 the system prompt never moves: every request of the session carries the first request\'s, byte for byte', window_.requests.length >= 5 && window_.requests.every(body => j(withoutMarks(body.system)) === j(withoutMarks(one?.system))), j(window_.requests.map(body => systemOf(body).length)))
  const control = requestOf(still, 'LANE turn two.')
  const before = (body: Body | undefined): unknown => withoutMarks({ system: body?.system, tools: body?.tools, messages: body?.messages?.slice(0, -1) })
  const tail = (body: Body | undefined): Array<{ text?: string }> => ((body?.messages?.at(-1)?.content ?? []) as Array<{ text?: string }>)
  check('A6 the prefix a provider caches is the same with the update and without it: the system prompt, the tools and every message ahead of the turn\'s own are equal, byte for byte, to those of a window where no lane changed', control !== undefined && canon(before(two), window_.world) === canon(before(control), still.world), `${canon(before(two), window_.world).length} against ${canon(before(control), still.world).length} characters`)
  check('A7 …and the turn\'s own message is that window\'s with the update put ahead of the prompt', control !== undefined && canon(withoutMarks(tail(two).filter(block => !String(block.text ?? '').includes(ARMED))), window_.world) === canon(withoutMarks(tail(control)), still.world) && tail(two).length === tail(control).length + 1 && String(tail(two)[0]?.text ?? '').includes(ARMED), j(tail(two).map(block => String(block.text ?? '').slice(0, 80))))
  check('A8 a window where no lane changes is sent no update at any turn (nothing repeats behind the first turn)', still.requests.every(body => updates(body).armed + updates(body).gone === 0), j(still.requests.map(updates)))
  const update = tail(two).find(block => String(block.text ?? '').includes(ARMED))
  console.log(`       the map in the first request: ${systemOf(one).slice(systemOf(one).indexOf(MAP)).length} characters; the update: ${String(update?.text ?? '').length} characters`)
}

section("B — the sessions the map is withheld from: a host's own session and a mercury run")
{
  const hosted = await underAHost('headless', 'host', STEPS({ MERCURY_UNITY: '1' }).slice(0, 3), replies('HOST', 3))
  const run = await throughTheRunDoor('run', STEPS({ MERCURY_UNITY: '1' }).slice(0, 3), replies('RUN', 3))
  check("B1 a host's own session (kind headless): three turns, no map and no update at any of them", j(hosted.outcomes) === j(['completed', 'completed', 'completed']) && hosted.requests.every(body => !systemOf(body).includes(MAP) && updates(body).armed + updates(body).gone === 0 && count(body.messages ?? [], UNITY) === 0), j({ outcomes: hosted.outcomes, updates: hosted.requests.map(updates) }))
  check('B2 a mercury run: three turns, no map and no update at any of them', j(run.outcomes) === j(['completed', 'completed', 'completed']) && run.requests.every(body => !systemOf(body).includes(MAP) && updates(body).armed + updates(body).gone === 0 && count(body.messages ?? [], UNITY) === 0), j({ outcomes: run.outcomes, updates: run.requests.map(updates), stderr: run.stderr.slice(-200) }))
}

section('C — across a typed /compact: the update is folded away with the rows before the fold, and nothing is said a second time')
{
  const long = (n: number): ScriptedTurn => ({ kind: 'text', text: `FOLD-REPLY-${n}.\n${Array.from({ length: 300 }, (_, index) => `Module ${n}-${index}: parser revision ${(index * 7919 + n * 104729).toString(36)} handles quoted commas.`).join('\n')}` })
  const folded = await underAHost(
    'oculus',
    'fold',
    [{ ask: 'FOLD turn one.' }, { ask: 'FOLD turn two.', before: world => saveLanes(world, { MERCURY_UNITY: '1' }) }, { ask: '/compact' }, { ask: 'FOLD turn four.' }, { ask: 'FOLD turn five.' }, { ask: 'FOLD turn six.', before: world => saveLanes(world, {}) }],
    [{ kind: 'text', text: '<analysis>walk</analysis>\n<summary>\n1. Operator Intent: plain turns for a fold.\n</summary>', whenBody: 'Produce the summary now' }, long(1), long(2), long(4), long(5), long(6)],
    { MERCURY_COMPACT_KEEP_TAIL: '1' },
  )
  const [two, four, five, six] = ['two', 'four', 'five', 'six'].map(n => requestOf(folded, `FOLD turn ${n}.`))
  check('the scene: the lane is armed at the second turn (one update), the third turn folds the conversation, three more turns follow', j(folded.outcomes) === j(['completed', 'completed', 'completed', 'completed', 'completed', 'completed']) && j(updates(two)) === j({ armed: 1, gone: 0, own: 1 }) && (four?.messages?.length ?? 99) < (two?.messages?.length ?? 0) + 2, j({ outcomes: folded.outcomes, two: updates(two), messages: [two?.messages?.length, four?.messages?.length], stderr: folded.stderr.slice(-300) }))
  check('C1 the first turn behind the fold carries no update, and the folded conversation no longer holds the first: the line is not said again', j(updates(four)) === j({ armed: 0, gone: 0, own: 0 }) && count(four?.messages ?? [], UNITY) === 0, j(updates(four)))
  check('C2 the turn after it carries none either: never once a turn', j(updates(five)) === j({ armed: 0, gone: 0, own: 0 }), j(updates(five)))
  check('C3 the lane saved off behind the fold is still told, once: the harness has not lost what it said', j(updates(six)) === j({ armed: 0, gone: 1, own: 1 }) && count(six?.messages?.at(-1) ?? null, UNITY) === 1, j(updates(six)))
}

console.log('\n============================================================')
console.log(failures === 0 ? ` ✅ AN ARMED LANE REACHES A WINDOW (${checks} checks)` : ` ❌ ${failures} of ${checks} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
