#!/usr/bin/env bun
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { distBuildInputs } from '../lib/distProvenance.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { untilAsync } from '../lib/untilAsync.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
for (const key of ['MERCURY_HOME', 'MERCURY_DAEMON_DIR', 'MERCURY_DAEMON_OWNER_PID', 'MERCURY_DAEMON_OWNER_FD', 'MERCURY_DAEMON_PERMISSION_MODE', 'MERCURY_SKIP_PERMISSIONS', 'MERCURY_CONCOURSE_WORKER', 'MERCURY_CONCOURSE', 'MERCURY_WARM_RUNNER', 'CI', 'NODE_ENV']) {
  delete process.env[key]
}
const ROOT = join(import.meta.dir, '..', '..')
const BIN = join(ROOT, 'dist', 'mercury.mjs')
const KEEP = process.argv.includes('--keep')
const built = existsSync(BIN) ? distBuildInputs(ROOT) : { stale: true, line: `${BIN} is absent` }
if (built.stale) {
  console.log(`prove-hop-carries-boot-mode: ${built.line}: run \`bun run build.ts\` in ${ROOT}, then run this proof again`)
  process.exit(1)
}
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.log(`prove-hop-carries-boot-mode: no terminal to drive the screen in (${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind})`)
  process.exit(1)
}
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'hop-boot-mode-')))
const KEY = 'proof-key-ci-gate-not-a-real-key'
const PROOF_ENV = { MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', MERCURY_DAP: '0', MERCURY_WARM_RUNNER: '0' }
process.env.ANTHROPIC_API_KEY = KEY

const { daemonControlRpc } = await import('../../src/daemon/control/controlSocket.ts')
const { MERCURY_DAEMON_PROTO } = await import('../../src/daemon/control/protocol.ts')
const workers = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
const { readSessionFacts } = await import('../../src/engine/connector/seatProjections.ts')
const { encodeTranscriptLine } = await import('../../src/sessions/transcripts/vnext.ts')
const { permissionModeTitle } = await import('../../src/permissions/rules/permissionMode.ts')
const { getNextPermissionMode } = await import('../../src/permissions/rules/getNextPermissionMode.ts')

const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT: prove-hop-carries-boot-mode exceeded 420s; a daemon, a runner or the screen never answered: read the last run header above and the frames under it')
  process.exit(1)
}, 420_000)
watchdog.unref?.()

type Mode = 'default' | 'flow'
type Send = Record<string, unknown>
type Mark = { label: string; text: string }
const COMPOSER = 'Type a prompt'
const ROW = 'Default permission mode'
const SESSION_WORDS = 'this session:'
const ESC = '\x1b'
const FRAMES = 24
const BAND_RE = /\b(sovereign mode|implement mode|apollo mode|flow|don't ask) on\b/
const bandOf = (text: string): string => BAND_RE.exec(text)?.[1]?.replace(' mode', '') ?? 'blank'
const bandWordOf = (mode: string): string => (mode === 'default' ? 'blank' : mode === 'dontAsk' ? "don't ask" : mode)
const ringFrom = (mode: Mode) => getNextPermissionMode({ mode, isBypassPermissionsModeAvailable: true } as never)

const HINTS = {
  hop: 'a hop into a live runner must push no mode: hopIntoBoardSessionLanding and applyLaunchWordOnHop in src/daemon/switchboard/hopIntoSession.ts carry the model and the effort only, and the live arm of reactivateConcourseSession (src/daemon/concourse-workers/reactivate.ts) answers liveHop without a respawn',
  band: "the mode band must read the focused session's own mode: permissionModeOf in src/engine/connector/daemonConnector.ts (the runner's word outranks the launch's) and modeBand in src/screen/frame-chips/MercuryFrame.tsx",
  copy: "the chat's own copy of the mode must take the live session's mode when the chat mounts onto it: the mount arm beside adoptRunnerMode in useChatAsks (src/screen/chat/useChatAsks.tsx); shift+tab (cyclePermission) and /config's row (getEffectivePermissionMode in src/platform/config/derived.ts) read that copy",
  drive: 'the drive did not reach this point: read the frames above (rebuild dist with bun run build.ts if it is stale)',
}
let failures = 0
const check = (label: string, cond: boolean, detail: string, hint: string): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${cond ? '' : ` (${[detail, hint].filter(Boolean).join('; ')})`}`)
}
const rpc = (request: object, timeoutMs = 15_000): Promise<Record<string, unknown>> => daemonControlRpc(request as never, { timeoutMs }) as Promise<Record<string, unknown>>
function printFrame(title: string, text: string): void {
  console.log(`\n┌── ${title} ──`)
  for (const line of text.split('\n')) console.log(`│${line}`)
  console.log('└──')
}

function seedTranscript(work: string, sid: string): void {
  const path = workers.concourseTranscriptPath({ sessionId: sid, workspaceId: workers.canonicalWorkspaceId(work) })
  mkdirSync(join(path, '..'), { recursive: true })
  const asked = randomUUID()
  const stamp = { cwd: work, sessionId: sid, timestamp: new Date().toISOString(), isSidechain: false, entrypoint: 'cli', version: '1.0.0' }
  const rows = [
    { type: 'user', uuid: asked, parentUuid: null, ...stamp, message: { role: 'user', content: 'Seed turn.' } },
    { type: 'assistant', uuid: randomUUID(), parentUuid: asked, ...stamp, message: { id: randomUUID(), type: 'message', role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'Seed reply.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
  ]
  writeFileSync(path, rows.map(row => (encodeTranscriptLine as (p: string, r: Record<string, unknown>) => { line: string })(path, row).line).join(''))
}

async function screenOf(id: string, home: string, daemonDir: string, work: string, argv: string[], sends: Send[]): Promise<{ marks: Mark[]; final: string; status: number; tail: string }> {
  const cfgPath = join(SCRATCH, `cfg-${id}.json`)
  const outPath = join(SCRATCH, `grid-${id}.json`)
  writeFileSync(cfgPath, JSON.stringify({ argv: ['node', BIN, ...argv], cwd: work, cols: 120, rows: 40, sends, readyText: COMPOSER, readySettleTicks: 3, total: 400, out: outPath }))
  const child = spawn(driver.python, [join(ROOT, 'scripts', 'ui', 'vshot.py'), cfgPath], {
    env: { ...process.env, ...PROOF_ENV, MERCURY_CONFIG_DIR: home, MERCURY_DAEMON_DIR: daemonDir, MERCURY_OPERATOR: 'sam', MERCURY_SPLASH: 'off', MERCURY_CRITTER_IDLE: '0', MERCURY_CRITTER_GAZE: '0', MERCURY_CRITTER_SLEEP: '0', MERCURY_LIVE_CLOCK: '0', MERCURY_LIVE_GLYPHS: '0', MERCURY_CACHE_CLOCK: '0', MERCURY_PARTY: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return new Promise(resolvePromise => {
    let tail = ''
    child.stdout.on('data', d => (tail = (tail + String(d)).slice(-800)))
    child.stderr.on('data', d => (tail = (tail + String(d)).slice(-800)))
    child.on('close', status => {
      const textOf = (grid: Array<Array<{ c: string }>>): string => grid.map(row => row.map(cell => cell.c).join('').replace(/\s+$/, '')).join('\n')
      try {
        const payload = JSON.parse(readFileSync(outPath, 'utf8')) as { grid: Array<Array<{ c: string }>>; marks?: Array<{ label: string; grid: Array<Array<{ c: string }>> }> }
        resolvePromise({ marks: (payload.marks ?? []).map(m => ({ label: m.label, text: textOf(m.grid) })), final: textOf(payload.grid), status: status ?? 1, tail })
      } catch {
        resolvePromise({ marks: [], final: '', status: status ?? 1, tail })
      }
    })
  })
}

type Run = { id: string; live: Mode; launch: Mode; saved?: string }
const RUNS: Run[] = [
  { id: 'r1', live: 'default', launch: 'flow' },
  { id: 'r2', live: 'flow', launch: 'default', saved: 'flow' },
]

console.log('============================================================')
console.log(' a launch that hops into a live session: the session keeps its mode, and the screen follows the session')
console.log('============================================================')

for (const run of RUNS) {
  console.log(`\n${run.id.toUpperCase()}: a live session in ${permissionModeTitle(run.live)}${run.saved !== undefined ? `, a saved ${run.saved}` : ''}; the launch is --mode ${run.launch} --resume <its id>`)
  const home = join(SCRATCH, `home-${run.id}`)
  const work = join(SCRATCH, `work-${run.id}`)
  const daemonDir = join(home, 'daemon')
  mkdirSync(work, { recursive: true })
  writeFileSync(join(work, 'README.md'), '# work\n')
  const git = (args: string[]): boolean => spawnSync('git', ['-c', 'user.email=proof@example.invalid', '-c', 'user.name=proof', ...args], { cwd: work, stdio: 'ignore' }).status === 0
  git(['init', '-q']) && git(['add', '.']) && git(['commit', '-q', '-m', 'seed'])
  seedFirstRun(home, [work])
  if (run.saved !== undefined) writeFileSync(join(home, 'settings.json'), JSON.stringify({ guardrails: { mode: run.saved } }))
  process.env.MERCURY_CONFIG_DIR = home
  process.env.MERCURY_DAEMON_DIR = daemonDir
  let log = ''
  const daemon: ChildProcess = spawn('node', [BIN, 'daemon', 'run', work], { cwd: work, env: { ...process.env, ...PROOF_ENV, NO_COLOR: '1', MERCURY_CONFIG_DIR: home, MERCURY_DAEMON_DIR: daemonDir, MERCURY_DAEMON_PERSIST: '1', MERCURY_DAEMON_NO_SELF_WARM: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const stream of [daemon.stdout, daemon.stderr]) stream?.on('data', d => (log += String(d)))
  try {
    const ready = await untilAsync(async () => {
      const hello = (await rpc({ op: 'hello', proto: MERCURY_DAEMON_PROTO, clientVersion: '1.0.0', clientBuildTree: null }).catch(() => ({ ok: false }))) as { ok?: boolean; ready?: boolean }
      return hello.ok === true && hello.ready === true
    }, vshotBudgetMs(60_000), 150)
    const born = ready ? await rpc({ op: 'sessionAdmit', workspaceDir: work, birthKey: randomUUID(), isolation: 'shared', bornBlank: true, by: 'operator', title: 'the live one', permissionMode: run.live, bypassConsent: true }, 60_000) : { ok: false }
    const sid = typeof born.sessionId === 'string' ? born.sessionId : ''
    const factsNow = (): { permissionMode?: string; queueReady?: boolean; runnerGeneration?: number } | null => readSessionFacts(sid, daemonDir)
    const spoke = sid !== '' && (await untilAsync(async () => {
      await rpc({ op: 'sessionControl', action: 'session-facts', sessionId: sid, by: 'operator' }).catch(() => undefined)
      return factsNow()?.queueReady === true
    }, vshotBudgetMs(60_000), 250))
    check(`${run.id} a live runner holds the session in ${permissionModeTitle(run.live)}`, spoke && factsNow()?.permissionMode === run.live, `ready=${ready} admitted=${JSON.stringify(born).slice(0, 200)} facts=${JSON.stringify(factsNow()?.permissionMode)} daemon=${log.slice(-300)}`, HINTS.drive)
    if (!spoke) continue
    seedTranscript(work, sid)
    const words: string[] = [String(factsNow()?.permissionMode)]
    const generations = new Set<number>([factsNow()?.runnerGeneration ?? 0])
    const watching = setInterval(() => {
      const facts = factsNow()
      if (facts?.permissionMode !== undefined && facts.permissionMode !== words.at(-1)) words.push(facts.permissionMode)
      if (facts?.runnerGeneration !== undefined) generations.add(facts.runnerGeneration)
    }, 100)
    const next = ringFrom(run.live)
    const composer = { requireAwait: true, awaitText: COMPOSER }
    const filtered = { requireAwait: true, awaitText: `/ ${ROW}` }
    const chat = { requireAwait: true, awaitText: 'Seed reply.' }
    const sends: Send[] = [
      { ...composer, minTick: 3, data: '', mark: 'f00' },
      ...Array.from({ length: FRAMES }, (_, k) => ({ ...composer, awaitSettleTicks: 1, data: '', mark: `f${String(k + 1).padStart(2, '0')}` })),
      { ...composer, data: '/config' },
      { requireAwait: true, awaitText: '❯ /config', data: '\r' },
      { requireAwait: true, awaitText: 'Auto-compact', awaitSettleTicks: 4, data: ROW },
      { ...filtered, awaitSettleTicks: 4, data: '', mark: 'config' },
      { ...filtered, data: ESC },
      { requireAwait: true, awaitText: 'Auto-compact', data: ESC },
      { ...chat, data: '', mark: 'closed' },
      { ...chat, data: `${ESC}[Z` },
      { requireAwait: true, awaitText: `${permissionModeTitle(next).toLowerCase()} on`, data: '', mark: 'stepped' },
    ]
    const screen = await screenOf(run.id, home, daemonDir, work, ['--mode', run.launch, '--resume', sid], sends)
    clearInterval(watching)
    const markOf = (label: string): string | null => screen.marks.find(m => m.label === label)?.text ?? null
    const first = markOf('f00')
    const config = markOf('config')
    const closed = markOf('closed')
    const stepped = markOf('stepped')
    if (first !== null) printFrame(`${run.id} the first composer frame`, first)
    if (config !== null) printFrame(`${run.id} /config, the row filtered`, config)
    printFrame(`${run.id} after one shift+tab`, stepped ?? screen.final)
    check(`${run.id} the chat is on screen`, first !== null && first.includes(COMPOSER), screen.tail.slice(-240), HINTS.drive)

    const bands = screen.marks.filter(m => /^f\d\d$/.test(m.label)).map(m => bandOf(m.text))
    const governing = bandWordOf(run.live)
    console.log(`  [FRAMES] ${run.id}: ${bands.join(' ')}`)
    check(`${run.id} every frame after the hop names the session's mode (${governing}), never the launch's (${bandWordOf(run.launch)})`, bands.length === FRAMES + 1 && bands.every(band => band === governing), `bands=${[...new Set(bands)].join(',')} of ${bands.length}`, HINTS.band)

    const row = (config ?? '').split('\n').find(line => line.includes(ROW))
    check(`${run.id} /config opens on the ${ROW} row`, row !== undefined, 'the row never painted', HINTS.drive)
    const untrue = `${SESSION_WORDS} ${permissionModeTitle(run.launch)}`
    check(`${run.id} /config never says "${untrue}" of a session that runs in ${permissionModeTitle(run.live)}`, config !== null && !config.includes(untrue), (row ?? '').trim(), HINTS.copy)

    check(`${run.id} the settings pane is closed before the key`, closed !== null && !closed.includes(ROW) && closed.includes(COMPOSER), 'the pane still covers the chat', HINTS.drive)
    check(`${run.id} one shift+tab steps from the mode the row shows (${run.live} → ${next}), not from the launch's (${run.launch} → ${ringFrom(run.launch)})`, stepped !== null && bandOf(stepped) === bandWordOf(next), `the band reads ${stepped === null ? '(no frame)' : bandOf(stepped)}`, HINTS.copy)
    console.log(`  [TRUTH] ${run.id}: the runner's own words over the drive: ${words.join(' → ')} · runner generations seen: ${[...generations].join(',')}`)
    check(`${run.id} the hop pushed no mode into the live runner: its words are ${run.live} until the key, then ${next}`, words.join(',') === `${run.live},${next}`, words.join(' → '), words[1] === run.launch ? HINTS.hop : HINTS.copy)
    check(`${run.id} the hop kept the one runner (no respawn)`, generations.size === 1, [...generations].join(','), HINTS.hop)
  } finally {
    await rpc({ op: 'shutdown', reapWorkers: true }, 5_000).catch(() => undefined)
    const gone = await untilAsync(() => daemon.exitCode !== null || daemon.signalCode !== null, vshotBudgetMs(15_000), 150)
    if (!gone) daemon.kill('SIGKILL')
    delete process.env.MERCURY_DAEMON_DIR
  }
}

clearTimeout(watchdog)
if (KEEP) console.log(`\n[keep] ${SCRATCH}`)
else rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-hop-carries-boot-mode: ALL LAWS HOLD' : `\nprove-hop-carries-boot-mode: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
