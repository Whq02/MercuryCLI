#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { PermissionRequestParams } from '../../src/runner/wire/methods.ts'
import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import type { Frame } from '../lib/rows.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const proofHome = mkdtempSync(join(tmpdir(), 'two-kinds-home-'))
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
const API_KEY = 'fixture-key-000'
const MODEL = 'claude-opus-4-8'
const LIMIT_MINUTES = '0.05'
const LIMIT_MS = 3_000

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const j = (v: unknown): string => JSON.stringify(v)
const sleep = (ms: number): Promise<void> => new Promise(resolveSleep => setTimeout(resolveSleep, ms))
const guarded = async (body: () => Promise<void>): Promise<void> => {
  try {
    await body()
  } catch (error) {
    check('the section ran to its end', false, error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  }
}
const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — the two-kinds proof exceeded 480s')
  process.exit(1)
}, 480_000)
guard.unref?.()

const HEADLESS_HOSTED_LINE =
  '- Session: non-interactive (mercury runner) with a host that holds the asks: a tool call that needs approval is put to the connected host, which answers allow or deny; a question to the operator travels the same door. A denial is policy, not tool failure: prefer tools your rules allow. An ask the host leaves unanswered ends the run as blocked, with the question on its outcome row.'
const HEADLESS_BARE_LINE =
  '- Session: non-interactive (mercury run): no human is at a prompt and no host answers an ask, so a tool call that would need an interactive approval is denied automatically and no question can reach the operator — choose the most reasonable option, state the assumption, and continue. A denial is policy, not tool failure: prefer tools your rules allow. When nothing reasonable remains without the operator, still ask through AskUserQuestion and end your turn: that unanswered question ends the run as blocked with your question on its outcome row, which is how a scripted run tells stuck from done — a question written only in your answer reads as done.'
const HEADLESS_DOCTRINE_LINE =
  'Runtime posture: this process is headless: an unanswerable permission ask is denied automatically, and a denial is policy, not tool failure; a file-lease denial means another agent holds those paths (coordinate, do not force).'
const HEADLESS_SEAT_HOSTED = 'headless, a host holds the asks: a permission ask or a question travels to the connected client, which answers allow or deny'
const HEADLESS_SEAT_BARE = 'headless, non-interactive: no host answers an ask, so a call that would need an interactive approval is denied; a denial is policy, not tool failure'

section('§0 THE ONE FACT — born where the daemon decides who asked, stamped on the spec and the record, consumed once by the runner')
await guarded(async () => {
  const kinds = await import('../../src/utils/sessionKind.ts')
  check('RED ON THE BASE: the vocabulary has exactly two words, oculus and headless', j(kinds.SESSION_KINDS) === j(['oculus', 'headless']))
  check("the operator's own doors are a screen: by 'operator' is oculus", kinds.sessionKindOfAsker('operator') === 'oculus')
  check("a terminal-pid attribution ('operator:<pid>') is the same screen", kinds.sessionKindOfAsker('operator:4242') === 'oculus')
  check('a schedule fire asks for a headless session', kinds.sessionKindOfAsker('saturn:nightly') === 'headless')
  check('a coordinator seat asks for a headless session', kinds.sessionKindOfAsker('concourse-w3') === 'headless')
  check('nobody named asks for a headless session', kinds.sessionKindOfAsker(undefined) === 'headless')
  check('a retired or foreign spelling is no kind at all (no alias, no migration)', kinds.parseSessionKind('interactive') === undefined && kinds.parseSessionKind('OCULUS') === undefined && kinds.parseSessionKind('') === undefined)
  const { FLAG_REGISTRY } = await import('../../src/substrate/flagRegistry.ts')
  const row = FLAG_REGISTRY.find(f => f.env === 'MERCURY_SESSION_KIND')
  check('the stamp is a registered value flag whose consumer is the vocabulary module', row?.kind === 'value' && (row?.consumer ?? '').includes('src/utils/sessionKind.ts'), j(row))

  const concourse = await import('../../src/daemon/concourseWorkers.ts')
  const spec = concourse.buildConcourseWorkerSpec({ runnerId: 'concourse-w1', sessionId: 's-1', workspaceId: ROOT, modelKey: MODEL, kind: 'oculus' })
  check("buildConcourseWorkerSpec stamps the kind on the spec's extraEnv (respawn-carried)", spec.extraEnv?.MERCURY_SESSION_KIND === 'oculus', j(spec.extraEnv))
  const bare = concourse.buildConcourseWorkerSpec({ runnerId: 'concourse-w1', sessionId: 's-1', workspaceId: ROOT, modelKey: MODEL })
  check('a spec built with no kind carries no stamp (absent, never the string undefined)', !('MERCURY_SESSION_KIND' in (bare.extraEnv ?? {})), j(bare.extraEnv))
  check('the record reads its kind off the spec it registered (record ≡ process)', concourse.spawnPostureOf(spec).kind === 'oculus' && concourse.spawnPostureOf(bare).kind === undefined)
  const rec = { runnerId: 'concourse-w1', sessionId: 's-1', workspaceId: ROOT, isolation: 'shared', modelKey: MODEL, spawnedAt: 0, lastLiveAt: 0, schema: 1 } as never as { kind?: string }
  concourse.stampSpawnPosture(rec as never, { permissionMode: 'default', kind: 'headless' })
  check('the one posture writer stamps the kind on the record', rec.kind === 'headless')
  concourse.stampSpawnPosture(rec as never, { permissionMode: 'default' })
  check('…and drops it when a respawn carries none (a record never keeps a kind its runner lost)', rec.kind === undefined)
  check('the worker env strip sweeps a stray MERCURY_SESSION_KIND before the spec stamps its own', concourse.concourseWorkerStripEnv().includes('MERCURY_SESSION_KIND'))
  const concourseSrc = readFileSync(join(ROOT, 'src', 'daemon', 'concourseWorkers.ts'), 'utf8')
  const admit = concourseSrc.slice(concourseSrc.indexOf('export function makeConcourseAdmitHandler('))
  check('the admission mints the kind from who asked (sessionKindOfAsker(req.by)) before any road', /const kind = sessionKindOfAsker\(req\.by\)/.test(admit))
  check('the warm claim is the screen\'s own road: a headless admission never claims a warm runner', /deps\.claimWarm !== undefined &&\n\s*kind === 'oculus' &&/.test(admit))
  const warmSrc = readFileSync(join(ROOT, 'src', 'daemon', 'warmRunner.ts'), 'utf8')
  check('the warm pool spawns its runner oculus (the pool exists for the screen\'s next birth)', /kind: 'oculus',\n\s*\}\)\n\s*const reg = roster\.registerLongLived\(short, spec\)/.test(warmSrc))
  const runSrc = readFileSync(join(ROOT, 'src', 'cli', 'run.ts'), 'utf8')
  check('the runner consumes the pin at its preflight, between the ask channel and the interactivity mark', /setAskChannel\(options\.door === 'wire' \? 'sdk' : 'none'\)\n\s*const kindPin = consumeSessionKindPin\(\)/.test(runSrc) && /setSessionKind\(kindPin\.kind === 'oculus' && options\.door === 'wire' \? 'oculus' : 'headless'\)\n\s*markSessionNonInteractive\(getAppState\(\)\.toolPermissionContext\?\.mode\)/.test(runSrc))
  const healthSrc = readFileSync(join(ROOT, 'src', 'utils', 'healthReport.ts'), 'utf8')
  const healthRow = healthSrc.slice(healthSrc.indexOf("id: 'session-kind'"), healthSrc.indexOf("id: 'session-kind'") + 2000)
  check("/health carries the Session kind row, read from the focused session's record and spoken in the vocabulary's words", healthSrc.includes("id: 'session-kind'") && /readSessionWorkers\(\)\)\.find\(rec => rec\.sessionId === sessionId/.test(healthRow) && /sessionKindWords\(record\.kind\)/.test(healthRow))
  check('the two kinds have two sentences, each leading with its word', kinds.sessionKindWords('oculus').startsWith('oculus — a screen belongs to this session') && kinds.sessionKindWords('headless').startsWith('headless — unattended'))
  const saved = process.env.MERCURY_SESSION_KIND
  process.env.MERCURY_SESSION_KIND = 'oculus'
  const pin = kinds.consumeSessionKindPin()
  check('the pin is read once and scrubbed from the env (a grandchild never inherits it)', pin.kind === 'oculus' && process.env.MERCURY_SESSION_KIND === undefined, j(pin))
  kinds.resetSessionKindPinForTest()
  process.env.MERCURY_SESSION_KIND = 'bogus'
  const bogus = kinds.consumeSessionKindPin()
  check('an unknown spelling is no kind, and the raw word is kept for the refusal line', bogus.kind === undefined && bogus.raw === 'bogus')
  kinds.resetSessionKindPinForTest()
  if (saved === undefined) delete process.env.MERCURY_SESSION_KIND
  else process.env.MERCURY_SESSION_KIND = saved
})

section('§0b THE WORDS IN-PROCESS — the oculus posture, doctrine and seat words; the headless half byte-identical to the base')
await guarded(async () => {
  const state = await import('../../src/bootstrap/state.ts')
  const posture = await import('../../src/utils/cockpit/runtimePosture.ts')
  const seat = await import('../../src/services/resources/adapters/seat.ts')
  const { askLimitMs } = await import('../../src/utils/permissions/askClock.ts')
  const savedExpiry = process.env.MERCURY_PERMISSION_ASK_EXPIRY_MINUTES
  delete process.env.MERCURY_PERMISSION_ASK_EXPIRY_MINUTES
  delete process.env.MERCURY_RUNTIME_POSTURE
  const compose = (kind: 'oculus' | 'headless', channel: 'sdk' | 'none'): string => {
    posture.resetRuntimePostureForTest()
    state.setAskChannel(channel)
    state.setSessionKind(kind)
    posture.markSessionNonInteractive('default')
    return posture.getRuntimePostureSection() ?? ''
  }
  const sessionLine = (text: string): string => text.split('\n').find(line => line.startsWith('- Session:')) ?? ''
  const oculus = compose('oculus', 'sdk')
  check('RED ON THE BASE: an oculus seat says a screen belongs to it and asks travel there and wait', sessionLine(oculus).startsWith('- Session: oculus (a screen belongs to this session)') && /ask them as you normally would/.test(oculus) && /nothing expires it/.test(oculus), sessionLine(oculus))
  check('…and never says nobody is here', !/no human is at a prompt/.test(oculus) && !/non-interactive/.test(oculus) && !/denied automatically/.test(oculus) && !/ends the run as blocked/.test(oculus))
  check('…the seat\'s rule facts (the needs-a-present-operator line) ride beside it as on any hosted seat', /present operator/.test(oculus) === /present operator/.test(compose('headless', 'sdk')))
  check('the oculus line is the one exported sentence, whole (replaced, never patched)', sessionLine(oculus).startsWith(posture.OCULUS_POSTURE_LINE))
  check('the hosted headless line is byte-identical to the base', sessionLine(compose('headless', 'sdk')) === `${HEADLESS_HOSTED_LINE} Permission mode for this run: default.`, sessionLine(compose('headless', 'sdk')))
  check('the bare headless line is byte-identical to the base', sessionLine(compose('headless', 'none')) === HEADLESS_BARE_LINE, sessionLine(compose('headless', 'none')))
  check('an oculus stamp with no host is still headless in words (a screen needs a door)', sessionLine(compose('oculus', 'none')) === HEADLESS_BARE_LINE)
  compose('oculus', 'sdk')
  check('RED ON THE BASE: a crewmate of an oculus session is told the screen holds it', posture.getRuntimePostureDoctrineLine() === posture.OCULUS_DOCTRINE_LINE && /oculus session/.test(posture.OCULUS_DOCTRINE_LINE) && !/this process is headless/.test(posture.OCULUS_DOCTRINE_LINE))
  compose('headless', 'sdk')
  check('the headless doctrine line is byte-identical to the base', posture.getRuntimePostureDoctrineLine() === HEADLESS_DOCTRINE_LINE)
  compose('oculus', 'sdk')
  check('RED ON THE BASE: mercury://seat names oculus', seat.seatPostureWords('default') === `${seat.OCULUS_SEAT_WORDS}; permission mode default` && seat.OCULUS_SEAT_WORDS.startsWith('oculus:'))
  compose('headless', 'sdk')
  check('mercury://seat names headless with the base\'s host words', seat.seatPostureWords(null) === HEADLESS_SEAT_HOSTED)
  compose('headless', 'none')
  check('mercury://seat names headless with the base\'s no-host words', seat.seatPostureWords(null) === HEADLESS_SEAT_BARE)

  state.setSessionKind('headless')
  check('the headless clock is the base\'s: flow 10 minutes, sovereign 3, a crewmate 10, a session\'s own ask in default none', askLimitMs({ mode: 'flow', crewmate: false }) === 600_000 && askLimitMs({ mode: 'sovereign', crewmate: false }) === 180_000 && askLimitMs({ mode: 'default', crewmate: true }) === 600_000 && askLimitMs({ mode: 'default', crewmate: false }) === 0)
  state.setSessionKind('oculus')
  check('RED ON THE BASE: an oculus session has no clock in any mode, a crewmate\'s ask included', askLimitMs({ mode: 'flow', crewmate: false }) === 0 && askLimitMs({ mode: 'sovereign', crewmate: false }) === 0 && askLimitMs({ mode: 'default', crewmate: true }) === 0)
  process.env.MERCURY_PERMISSION_ASK_EXPIRY_MINUTES = LIMIT_MINUTES
  check('the expiry knob keeps its meaning for headless only', askLimitMs({ mode: 'sovereign', crewmate: false }) === 0 && askLimitMs({ mode: 'sovereign', crewmate: false, kind: 'headless' }) === LIMIT_MS)
  if (savedExpiry === undefined) delete process.env.MERCURY_PERMISSION_ASK_EXPIRY_MINUTES
  else process.env.MERCURY_PERMISSION_ASK_EXPIRY_MINUTES = savedExpiry
  posture.resetRuntimePostureForTest()
  state.setAskChannel('operator')
  state.setSessionKind('headless')
})

section("§0c THE DAEMON'S CLOCK — a crewmate's parked ask on an oculus seat has no deadline; on a headless seat the base's")
await guarded(async () => {
  const home = mkdtempSync(join(tmpdir(), 'two-kinds-daemon-'))
  const daemonDir = join(home, 'daemon')
  mkdirSync(daemonDir, { recursive: true })
  const savedDaemonDir = process.env.MERCURY_DAEMON_DIR
  process.env.MERCURY_DAEMON_DIR = daemonDir
  const asks = await import('../../src/daemon/permissionAsks.ts')
  const { concourseWorkersPath } = await import('../../src/daemon/concourseWorkers.ts')
  const record = (short: string, kind?: string) => ({
    runnerId: short,
    sessionId: `sess-${short}`,
    workspaceId: join(home, 'ws'),
    title: `t-${short}`,
    permissionMode: 'sovereign',
    spawnedAt: Date.now(),
    lastLiveAt: Date.now(),
    ...(kind !== undefined ? { kind } : {}),
  })
  writeFileSync(concourseWorkersPath(daemonDir), JSON.stringify({ version: 1, workers: { 'concourse-w1': record('concourse-w1', 'oculus'), 'concourse-w2': record('concourse-w2', 'headless'), 'concourse-w3': record('concourse-w3') } }))
  const hold = (short: string, tag: string) => {
    const h = asks.holdWorkerAsk(short, { kind: 'tool', tool_use_id: `tu-${tag}`, tool_name: 'Bash', input: { command: 'git push' }, agent_id: `agent-${tag}`, mode: 'sovereign' } as never, daemonDir, undefined, () => 'attached')
    const row = asks.listPendingPermissionAsks().filter(a => a.workerId === short).at(-1)
    return { h, row }
  }
  const oculus = hold('concourse-w1', 'oculus')
  const headless = hold('concourse-w2', 'headless')
  const unstamped = hold('concourse-w3', 'unstamped')
  check("RED ON THE BASE: a crewmate's sovereign ask on an oculus seat carries no clock (limitMs 0)", oculus.row?.limitMs === 0, j(oculus.row))
  check("a crewmate's sovereign ask on a headless seat carries the base's 3-minute clock", headless.row?.limitMs === 180_000, j(headless.row))
  check("a record written before the stamp reads headless (the base's clock)", unstamped.row?.limitMs === 180_000, j(unstamped.row))
  for (const held of [oculus, headless, unstamped]) if (held.row) asks.onWorkerAskWithdrawn(held.row.requestId, daemonDir)
  if (savedDaemonDir === undefined) delete process.env.MERCURY_DAEMON_DIR
  else process.env.MERCURY_DAEMON_DIR = savedDaemonDir
  rmSync(home, { recursive: true, force: true })
})

interface World { home: string; cwd: string; env: Record<string, string> }
function makeWorld(tag: string, baseUrl: string): World {
  const home = realpathSync(mkdtempSync(join(tmpdir(), `two-kinds-${tag}-`)))
  const cwd = join(home, 'project')
  const configDir = join(home, '.mercury')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(cwd, 'README.md'), '# fixture\n')
  writeFileSync(join(configDir, '.config.json'), JSON.stringify({
    theme: 'dark',
    hasCompletedOnboarding: true,
    customApiKeyResponses: { approved: [API_KEY.slice(-20)] },
    projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
  }))
  return {
    home,
    cwd,
    env: {
      HOME: home,
      PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${dirname(NODE)}`,
      TERM: 'dumb',
      MERCURY_CONFIG_DIR: configDir,
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_BROWSER_NO_DISCOVERY: '1',
      BROWSER: '/usr/bin/true',
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_API_KEY: API_KEY,
    },
  }
}

type Kind = 'oculus' | 'headless'
interface Captured {
  kind: Kind
  sessionId: string
  world: string
  requests: Array<{ path: string; headers: Record<string, string>; body: unknown }>
  rows: Frame[]
  asks: PermissionRequestParams[]
  code: number | null
  stderr: string
}

async function runConversation(kind: Kind, world: World, turns: ScriptedTurn[]): Promise<Captured> {
  const fixture = await startFixtureApi(turns)
  const asks: PermissionRequestParams[] = []
  const host = hostRunner({
    dist: DIST,
    node: NODE,
    cwd: world.cwd,
    home: world.home,
    env: { ...world.env, ANTHROPIC_BASE_URL: fixture.url, MERCURY_SESSION_KIND: kind },
    argv: ['--model', MODEL],
  })
  host.onAsk(params => {
    asks.push(params)
    return { outcome: 'allow' }
  })
  const killer = setTimeout(() => host.child.kill('SIGKILL'), 120_000)
  let sessionId = ''
  try {
    const init = await host.initialize()
    sessionId = String(init.session_id ?? '')
    await host.prompt('say hello')
    await host.waitFor('outcome 1', row => row.type === 'outcome' && row.turn === 1, 90_000)
    await host.prompt('write a note')
    await host.waitFor('outcome 2', row => row.type === 'outcome' && row.turn === 2, 90_000)
  } catch (error) {
    console.log(`  [door] ${error instanceof Error ? error.message : String(error)}`)
  }
  host.end()
  const code = await host.exited
  clearTimeout(killer)
  host.peer.close('the probe ended')
  const requests = fixture.messageRequests().map(r => ({ path: r.path, headers: r.headers, body: r.body }))
  await fixture.close()
  return { kind, sessionId, world: basename(world.home), requests, rows: [...host.rows], asks, code, stderr: host.stderr() }
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
const ISO = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g
const VOLATILE = new Set(['timestamp', 'wall_ms', 'api_ms', 'since_ms', 'budget_ms', 'prompt_tokens_estimate'])
function canon(value: unknown, world: string): string {
  const text = JSON.stringify(value, (key, v) => (VOLATILE.has(key) ? '<n>' : v))
  return text.split(world).join('<world>').replace(UUID, '<uuid>').replace(ISO, '<time>')
}
function systemTextOf(body: unknown): string {
  const system = (body as { system?: unknown }).system
  if (typeof system === 'string') return system
  if (Array.isArray(system)) return system.map(part => String((part as { text?: string }).text ?? '')).join('\n')
  return ''
}
function bodyWithoutSystem(body: unknown): unknown {
  const { system: _system, ...rest } = body as Record<string, unknown>
  void _system
  return rest
}
const isPostureLine = (line: string): boolean => line.startsWith('- Session:')

let oculusRun: Captured | null = null
let headlessRun: Captured | null = null

section('§1 THE DIFFERENTIAL — one scripted conversation under a host, once headless and once oculus, each in a fresh world: only the posture line differs')
await guarded(async () => {
  const conversation = (): ScriptedTurn[] => [
    { kind: 'text', text: 'Hello from the fixture.' },
    { kind: 'tool_use', name: 'Write', input: { file_path: 'notes.txt', content: 'one line\n' }, preText: 'Writing a note.' },
    { kind: 'text', text: 'Written.' },
  ]
  const worldA = makeWorld('diff', 'http://127.0.0.1:9/')
  const worldB = makeWorld('diff', 'http://127.0.0.1:9/')
  try {
    headlessRun = await runConversation('headless', worldA, conversation())
    oculusRun = await runConversation('oculus', worldB, conversation())
    const a = headlessRun
    const b = oculusRun
    check('both runs exit 0 and carry the same number of requests, rows and asks', a.code === 0 && b.code === 0 && a.requests.length === b.requests.length && a.rows.length === b.rows.length && a.asks.length === b.asks.length, j({ headless: [a.code, a.requests.length, a.rows.length, a.asks.length, a.stderr.slice(0, 200)], oculus: [b.code, b.requests.length, b.rows.length, b.asks.length, b.stderr.slice(0, 200)] }))
    check('the host answered one ask in each run (the Write), and the ask params are equal byte for byte', a.asks.length === 1 && b.asks.length === 1 && canon(a.asks, a.world) === canon(b.asks, b.world), j({ headless: a.asks[0], oculus: b.asks[0] }))
    check('the conversation reached the model the same number of times (two prompts, a tool round, the closing ask)', a.requests.length >= 3 && a.requests.length === b.requests.length, String(a.requests.length))
    let bodiesEqual = true
    let firstBodyDiff = ''
    for (let i = 0; i < Math.min(a.requests.length, b.requests.length); i++) {
      const left = canon({ path: a.requests[i]!.path, headers: a.requests[i]!.headers, body: bodyWithoutSystem(a.requests[i]!.body) }, a.world)
      const right = canon({ path: b.requests[i]!.path, headers: b.requests[i]!.headers, body: bodyWithoutSystem(b.requests[i]!.body) }, b.world)
      if (left !== right) {
        bodiesEqual = false
        let at = 0
        while (at < left.length && left[at] === right[at]) at++
        firstBodyDiff = `request ${i + 1} differs at char ${at}: headless …${left.slice(Math.max(0, at - 80), at + 160)}… vs oculus …${right.slice(Math.max(0, at - 80), at + 160)}…`
        break
      }
    }
    check('every request body — the model, the tools, the messages, the tool results, the metadata — is equal byte for byte outside the system prompt', bodiesEqual, firstBodyDiff)
    let promptsEqual = true
    let postureDiffers = false
    let firstLineDiff = ''
    for (let i = 0; i < Math.min(a.requests.length, b.requests.length); i++) {
      const left = systemTextOf(a.requests[i]!.body).split('\n')
      const right = systemTextOf(b.requests[i]!.body).split('\n')
      if (left.length !== right.length) {
        promptsEqual = false
        firstLineDiff = `request ${i + 1}: ${left.length} vs ${right.length} system prompt lines`
        break
      }
      for (let n = 0; n < left.length; n++) {
        const l = left[n]!.split(a.world).join('<world>').replace(UUID, '<uuid>')
        const r = right[n]!.split(b.world).join('<world>').replace(UUID, '<uuid>')
        if (l === r) continue
        if (isPostureLine(l) && isPostureLine(r)) {
          postureDiffers = true
          continue
        }
        promptsEqual = false
        firstLineDiff = `request ${i + 1} line ${n + 1}: headless ${j(l.slice(0, 200))} vs oculus ${j(r.slice(0, 200))}`
        break
      }
      if (!promptsEqual) break
    }
    check('every other line of every system prompt is equal byte for byte (the constitution, the environment, the memory page, the harness map, the rule facts)', promptsEqual, firstLineDiff)
    check('RED ON THE BASE: the posture line is what differs', postureDiffers)
    let rowsEqual = true
    let firstRowDiff = ''
    for (let i = 0; i < Math.min(a.rows.length, b.rows.length); i++) {
      const left = canon(a.rows[i], a.world)
      const right = canon(b.rows[i], b.world)
      if (left !== right) {
        rowsEqual = false
        firstRowDiff = `row ${i + 1}: headless ${left.slice(0, 300)} vs oculus ${right.slice(0, 300)}`
        break
      }
    }
    check('every row the runner emitted — the session, the turns, the tool call and result, the steps, both outcomes, the close — is equal byte for byte (ids, clocks and byte-size estimates normalised)', rowsEqual, firstRowDiff)
    const outcomes = (run: Captured): Frame[] => run.rows.filter(row => row.type === 'outcome')
    check('both outcomes completed with no denials in each run', outcomes(a).length === 2 && outcomes(b).length === 2 && [...outcomes(a), ...outcomes(b)].every(row => row.status === 'completed' && Array.isArray(row.denials) && (row.denials as unknown[]).length === 0), j({ headless: outcomes(a).map(o => o.status), oculus: outcomes(b).map(o => o.status) }))
    const result = (run: Captured): Frame | undefined => run.rows.find(row => row.type === 'tool_result')
    check('the Write ran in both runs with the same result', result(a)?.status === 'ok' && result(b)?.status === 'ok' && canon(result(a), a.world) === canon(result(b), b.world), j({ headless: result(a), oculus: result(b) }))
  } finally {
    rmSync(worldA.home, { recursive: true, force: true })
    rmSync(worldB.home, { recursive: true, force: true })
  }
})

section('§2 DIFFERENCE ONE — what the model is told')
await guarded(async () => {
  if (oculusRun === null || headlessRun === null) {
    check('the differential captured both runs', false)
    return
  }
  const oculusPrompt = systemTextOf(oculusRun.requests[0]?.body)
  const headlessPrompt = systemTextOf(headlessRun.requests[0]?.body)
  const sessionLine = (text: string): string => text.split('\n').find(line => isPostureLine(line)) ?? ''
  check('RED ON THE BASE: the oculus posture names the screen', sessionLine(oculusPrompt).startsWith('- Session: oculus (a screen belongs to this session): the operator is on the screen'), sessionLine(oculusPrompt))
  check('…tells the model to ask as it normally would, that the ask waits without expiry, and that a slow answer is not nobody', /ask them as you normally would/.test(oculusPrompt) && /nothing expires it/.test(oculusPrompt) && /a slow answer is not "nobody is here"/.test(oculusPrompt))
  check('…and never says "no human is at a prompt" or "non-interactive"', !/no human is at a prompt/.test(oculusPrompt) && !/non-interactive/.test(oculusPrompt))
  check('…a denial is still policy, not tool failure', /A denial is policy, not tool failure/.test(sessionLine(oculusPrompt)))
  check('the headless twin keeps the base\'s hosted words, byte for byte', sessionLine(headlessPrompt) === `${HEADLESS_HOSTED_LINE} Permission mode for this run: default.`, sessionLine(headlessPrompt))
  check('the oculus run printed no refusal line on stderr (the stamp was honoured)', !/MERCURY_SESSION_KIND/.test(oculusRun.stderr), oculusRun.stderr.slice(0, 300))
})

const QUESTION = 'Which one?'
const askQuestion: ScriptedTurn = { kind: 'tool_use', name: 'AskUserQuestion', input: { questions: [{ question: QUESTION, header: 'Pick', options: [{ label: 'a', description: 'first' }, { label: 'b', description: 'second' }], multiSelect: false }] }, preText: 'One question first.' }

section("§3 DIFFERENCE TWO AND THREE — a sovereign ask under the headless clock (3 minutes, scaled to 3 s): headless expires and ends blocked with the question quoted; oculus waits, is answered later, and completes")
await guarded(async () => {
  const headlessFixture = await startFixtureApi([askQuestion, { kind: 'text', text: 'I could not get an answer.' }])
  const headlessWorld = makeWorld('clock-headless', headlessFixture.url)
  const headless = hostRunner({ dist: DIST, node: NODE, cwd: headlessWorld.cwd, home: headlessWorld.home, env: { ...headlessWorld.env, MERCURY_SESSION_KIND: 'headless', MERCURY_PERMISSION_ASK_EXPIRY_MINUTES: LIMIT_MINUTES }, argv: ['--model', MODEL, '--sovereign'] })
  const headlessKiller = setTimeout(() => headless.child.kill('SIGKILL'), 120_000)
  try {
    await headless.initialize({ holds_asks: true }, 90_000)
    await headless.prompt('pick one')
    const ask = await headless.waitForAsk('the headless question', 60_000)
    const askedAt = Date.now()
    check('the question travels the door under sovereign as an AskUserQuestion ask', ask.params.kind === 'tool' && ask.params.tool_name === 'AskUserQuestion' && ask.params.mode === 'sovereign', j(ask.params))
    const result = await headless.waitFor('the headless tool result', row => row.type === 'tool_result', LIMIT_MS * 10)
    const waited = Date.now() - askedAt
    check(`headless: the ask expires on the clock (${waited} ms after the ask; limit ${LIMIT_MS} ms) and the question is refused`, result.status === 'error' && waited >= LIMIT_MS - 500 && waited < LIMIT_MS * 5 && /nobody answered the permission ask within 3s/.test(String(result.output)), j(result))
    check('headless: the host\'s card is withdrawn ($/cancel_request) — the base\'s road', headless.withdrawn.has(ask.id), j([...headless.withdrawn]))
    const outcome = await headless.waitFor('the headless outcome', row => row.type === 'outcome', 60_000)
    check('headless: the turn ends blocked with the question quoted on the outcome row — the base\'s road', outcome.status === 'blocked' && (outcome.error as { class?: string; message?: string } | undefined)?.class === 'blocked' && String((outcome.error as { message?: string } | undefined)?.message).includes(`«${QUESTION}»`), j(outcome))
  } finally {
    headless.end()
    await headless.exited
    clearTimeout(headlessKiller)
    headless.peer.close('the probe ended')
    await headlessFixture.close()
    rmSync(headlessWorld.home, { recursive: true, force: true })
  }

  const oculusFixture = await startFixtureApi([askQuestion, { kind: 'text', text: 'Thanks, a it is.' }])
  const oculusWorld = makeWorld('clock-oculus', oculusFixture.url)
  const oculus = hostRunner({ dist: DIST, node: NODE, cwd: oculusWorld.cwd, home: oculusWorld.home, env: { ...oculusWorld.env, MERCURY_SESSION_KIND: 'oculus', MERCURY_PERMISSION_ASK_EXPIRY_MINUTES: LIMIT_MINUTES }, argv: ['--model', MODEL, '--sovereign'] })
  const oculusKiller = setTimeout(() => oculus.child.kill('SIGKILL'), 120_000)
  try {
    await oculus.initialize({ holds_asks: true }, 90_000)
    await oculus.prompt('pick one')
    const ask = await oculus.waitForAsk('the oculus question', 60_000)
    const askedAt = Date.now()
    check('the same question travels the same door under sovereign', ask.params.kind === 'tool' && ask.params.tool_name === 'AskUserQuestion' && ask.params.mode === 'sovereign', j(ask.params))
    await sleep(LIMIT_MS * 3)
    check(`RED ON THE BASE: oculus: ${Math.round((Date.now() - askedAt) / 1000)} s past the headless clock the ask is still pending — not withdrawn, no result, no outcome, the runner alive`, !oculus.withdrawn.has(ask.id) && !oculus.rows.some(row => row.type === 'tool_result') && !oculus.rows.some(row => row.type === 'outcome') && oculus.child.exitCode === null, j({ withdrawn: [...oculus.withdrawn], rows: oculus.rows.map(row => row.type) }))
    const input = ask.params.kind === 'tool' ? (ask.params.input as Record<string, unknown>) : {}
    oculus.answerAsk(ask.id, { outcome: 'allow', input: { ...input, answers: { [QUESTION]: 'a' } } })
    const result = await oculus.waitFor('the oculus tool result', row => row.type === 'tool_result', 60_000)
    check('oculus: the late answer lands — the question tool returns the operator\'s answer', result.status === 'ok' && /User has answered your questions/.test(String(result.output)) && /a\b/.test(String(result.output)), j(result))
    const outcome = await oculus.waitFor('the oculus outcome', row => row.type === 'outcome', 60_000)
    check('RED ON THE BASE: oculus: the turn completes — never blocked, no denial, the answer on the row', outcome.status === 'completed' && Array.isArray(outcome.denials) && (outcome.denials as unknown[]).length === 0 && outcome.answer === 'Thanks, a it is.', j(outcome))
  } finally {
    oculus.end()
    await oculus.exited
    clearTimeout(oculusKiller)
    oculus.peer.close('the probe ended')
    await oculusFixture.close()
    rmSync(oculusWorld.home, { recursive: true, force: true })
  }
})

console.log(`\n${'═'.repeat(76)}`)
if (failures > 0) {
  console.log(`❌ prove-two-kinds-of-headless: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ prove-two-kinds-of-headless: one fact, three differences, everything else byte-identical')
