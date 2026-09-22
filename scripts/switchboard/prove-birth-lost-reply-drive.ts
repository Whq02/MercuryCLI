#!/usr/bin/env bun
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { driveWallSeconds, driverClosed, unfiredDetail } from '../lib/ptydriveReport.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const DIST = argAfter('--dist') ?? join(REPO, 'dist', 'mercury.mjs')
const VENDORED_NODE = join(dirname(DIST), 'vendor', 'node', 'bin', 'node')
const NODE = existsSync(VENDORED_NODE) ? VENDORED_NODE : spawnSync('which', ['node'], { encoding: 'utf8' }).stdout.trim()
const SCENE = argAfter('--scene') ?? 'lose-after-write'
const COLS = Number(argAfter('--cols') ?? 120)
const ROWS = Number(argAfter('--rows') ?? 40)
const FRAMES = argAfter('--frames')
const KEEP = process.argv.includes('--keep')
const KEYLESS = process.argv.includes('--keyless')
const STANDIN = join(HERE, 'lost-reply-standin.ts')
const BUN = process.env.BUN ?? process.execPath
const WORLD_ROOT = '/private/tmp/mw'
const SCENES = ['relay', 'lose-after-write', 'lose-before-write', 'hold-reply'] as const
type Scene = (typeof SCENES)[number]
if (!SCENES.includes(SCENE as Scene)) {
  console.error(`✗ unknown --scene ${SCENE} (one of ${SCENES.join(' | ')})`)
  process.exit(2)
}
const scene = SCENE as Scene

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log(`\n── ${t} ──`)
const text = (v: unknown): string => JSON.stringify(v)
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

if (!existsSync(DIST)) {
  console.error(`✗ ${DIST} missing — run \`bun run build.ts\` first`)
  process.exit(1)
}
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`✗ the PTY drive needs the POSIX capture engine — ${driver.kind === 'unavailable' ? driver.reason : `driver ${driver.kind}`}`)
  process.exit(1)
}
if (!existsSync(WORLD_ROOT)) mkdirSync(WORLD_ROOT, { recursive: true })

console.log('============================================================')
console.log(' a birth whose admit reply is lost on the wire births ONE session')
console.log(`   scene ${scene} · ${COLS}×${ROWS} · bundle ${DIST}`)
console.log('============================================================')

const world = realpathSync(mkdtempSync(join(WORLD_ROOT, 'birth-lost-reply-')))
const home = join(world, 'home')
const configDir = join(home, '.mercury')
const daemonDir = join(world, 'daemon')
const cwd = join(world, 'workspace')
for (const d of [configDir, daemonDir, cwd]) mkdirSync(d, { recursive: true })
writeFileSync(join(cwd, 'README.md'), '# fixture\n')
const PROBE_KEY = 'proof-key-ci-gate-not-a-real-key'
writeFileSync(
  join(configDir, '.config.json'),
  JSON.stringify({
    theme: 'dark',
    hasCompletedOnboarding: true,
    lastOnboardingVersion: '99.0.0',
    numStartups: 10,
    projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
    customApiKeyResponses: { approved: [PROBE_KEY.slice(-20)], rejected: [] },
    switchboardCapacity: { askedAt: 0, allowed: true, recommendedSeats: 3 },
  }),
)
writeFileSync(join(configDir, 'settings.json'), '{}')

const DEAD = 'http://127.0.0.1:1'
const deadBases: Record<string, string> = {}
for (const k of Object.keys(process.env)) {
  if (/^MERCURY_.*_(BASE|BASE_URL|URL)$/.test(k) && process.env[k] === DEAD) deadBases[k] = DEAD
}
const worldEnv: NodeJS.ProcessEnv = {
  HOME: home,
  PATH: `/usr/bin:/bin:${dirname(NODE)}`,
  TERM: 'xterm-256color',
  ...deadBases,
  ANTHROPIC_BASE_URL: DEAD,
  MERCURY_CUSTOM_OAUTH_URL: DEAD,
  MERCURY_UPDATE_API_BASE_URL: DEAD,
  ...(KEYLESS ? {} : { ANTHROPIC_API_KEY: PROBE_KEY }),
  MERCURY_CONFIG_DIR: configDir,
  MERCURY_DAEMON_DIR: daemonDir,
  MERCURY_TEAMS_DIR: join(world, 'teams'),
  MERCURY_TABULA_DIR: join(world, 'tabula'),
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_BOOT_PREFLIGHT: '0',
  MERCURY_SPLASH: 'off',
  MERCURY_TERMINAL_TITLE: '0',
  MERCURY_CRITTER_IDLE: '0',
  MERCURY_CRITTER_GAZE: '0',
  MERCURY_CRITTER_SLEEP: '0',
  MERCURY_LIVE_CLOCK: '0',
  MERCURY_LIVE_GLYPHS: '0',
  MERCURY_TURN_RECEIPT: '0',
  MERCURY_OASIS_BG: '0',
  BROWSER: '/usr/bin/true',
  ...(process.env.MERCURY_VSHOT_BUDGET_SCALE ? { MERCURY_VSHOT_BUDGET_SCALE: process.env.MERCURY_VSHOT_BUDGET_SCALE } : {}),
}

const spawned: ChildProcess[] = []
const daemonLog = join(daemonDir, 'daemon.log')
const logFd = openSync(daemonLog, 'a')
const daemon = spawn(NODE, [DIST, 'daemon', 'run', cwd], {
  cwd,
  env: { ...worldEnv, MERCURY_DAEMON_OWNER_PID: String(process.pid), MERCURY_DAEMON_OWNER_FD: '3' },
  stdio: ['ignore', logFd, logFd, 'pipe'],
})
spawned.push(daemon)
const sockPath = join(daemonDir, 'control.sock')
const upstreamPath = join(daemonDir, 'control.upstream.sock')
const supervisorPath = join(daemonDir, 'supervisor.json')
const workersPath = join(daemonDir, 'concourse-workers.json')
{
  const until = Date.now() + vshotBudgetMs(20_000)
  while (Date.now() < until && !(existsSync(sockPath) && existsSync(supervisorPath) && existsSync(join(daemonDir, 'control.key')))) await sleep(100)
}
section('§1 the world — a real daemon of the bundle, then the forwarding stand-in takes its socket path')
check('the daemon of the bundle came up in the world (socket, record and key present)', existsSync(sockPath) && existsSync(supervisorPath), `daemon pid ${daemon.pid}`)
const supervisorPid = ((): number | null => {
  try {
    return (JSON.parse(readFileSync(supervisorPath, 'utf8')) as { pid?: number }).pid ?? null
  } catch {
    return null
  }
})()
check('the record names the daemon this proof spawned', supervisorPid === daemon.pid, `record pid ${supervisorPid} · spawned ${daemon.pid}`)

const ledger = join(world, 'standin-ledger.jsonl')
writeFileSync(ledger, '')
const standin = spawn(BUN, ['run', STANDIN, '--listen', sockPath, '--upstream', upstreamPath, '--ledger', ledger, '--scene', scene, '--deaf-ms', '4000'], { stdio: ['ignore', 'pipe', 'pipe'] })
spawned.push(standin)
let standinOut = ''
standin.stdout!.on('data', d => (standinOut += d))
standin.stderr!.on('data', d => (standinOut += d))
{
  const until = Date.now() + vshotBudgetMs(15_000)
  while (Date.now() < until && !standinOut.includes('LISTENING')) await sleep(50)
}
check('the stand-in listens where the door connects and forwards to the daemon', standinOut.includes('LISTENING') && existsSync(upstreamPath), standinOut.trim().slice(0, 200))

type LedgerRow = { at: number; sinceMs: number; n?: number; op?: string; action?: string; ok?: boolean; sessionId?: string; ms?: number }
const ledgerRows = (): LedgerRow[] =>
  readFileSync(ledger, 'utf8')
    .split('\n')
    .filter(l => l.trim() !== '')
    .map(l => JSON.parse(l) as LedgerRow)
type Worker = { runnerId?: string; pid?: number; endedAt?: number; parkedAt?: number; sessionId?: string; bornBlankAt?: number; lastDeliveryAt?: number; keyless?: boolean; modelKey?: string }
const readWorkers = (): Record<string, Worker> => {
  try {
    return (JSON.parse(readFileSync(workersPath, 'utf8')) as { workers?: Record<string, Worker> }).workers ?? {}
  } catch {
    return {}
  }
}
const bornOf = (workers: Record<string, Worker>): Worker[] => Object.values(workers).filter(w => w.bornBlankAt !== undefined)

section(`§2 the drive — ↵ New Session on the Boot face; the scene: ${scene}`)
const ESC = String.fromCharCode(27)
const HINT = '↑↓ choose'
const after = (ms: number, payload: string): string => `after:${HINT}:${ms}:${payload}`
const ENTER_AT = 1500
const BOARD_AT = scene === 'hold-reply' ? 66_000 : 13_000
const sends = [after(ENTER_AT, '\r'), after(BOARD_AT, `${ESC}[1;2D`)]
const WALL_S = driveWallSeconds(sends, { tailMs: 4500, bootMs: 6000 })
const drive = join(world, 'drive.jsonl')
const child = spawn(
  driver.python,
  [join(REPO, 'scripts', 'streaming', 'ptydrive.py'), '--cols', String(COLS), '--rows', String(ROWS), '--seconds', String(WALL_S), '--out', drive, ...sends.flatMap(s => ['--send', s]), '--', NODE, DIST],
  { cwd, env: { ...worldEnv, DEBUG: '1' } },
)
spawned.push(child)
let driverOut = ''
child.stdout!.on('data', d => (driverOut += d))
child.stderr!.on('data', d => (driverOut += d))
const killer = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(WALL_S * 1000) + 22_000)

type DriveRec = { ts?: number; b64?: string; sent?: number; atMs?: number }
const driveRecs = (): DriveRec[] => (existsSync(drive) ? readFileSync(drive, 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l) as DriveRec] } catch { return [] } }) : [])
let midSnapshot: { at: number; workers: Record<string, Worker>; live: number[] } | null = null
const watcher = (async (): Promise<void> => {
  while (child.exitCode === null && child.signalCode === null) {
    const recs = driveRecs()
    const enterSent = recs.find(r => r.sent !== undefined)
    const settleMs = scene === 'hold-reply' ? 30_000 : 10_000
    if (midSnapshot === null && enterSent?.sent !== undefined && Date.now() - enterSent.sent >= vshotBudgetMs(settleMs)) {
      const workers = readWorkers()
      midSnapshot = { at: Date.now(), workers, live: Object.values(workers).filter(w => w.pid !== undefined && w.endedAt === undefined && alive(w.pid)).map(w => w.pid!) }
    }
    await sleep(50)
  }
})()
await driverClosed(child)
clearTimeout(killer)
await watcher

const recs = driveRecs()
const firstOut = recs.find(r => r.ts !== undefined)?.ts ?? 0
const sendRecs = recs.filter(r => r.sent !== undefined)
const at = (i: number): number => Math.round((sendRecs[i]?.sent ?? firstOut) - firstOut)
check('every send fired (the face painted and took the ↵ and the ⇧←)', sendRecs.length === sends.length, `${sendRecs.length}/${sends.length}${sendRecs.length < sends.length ? ` · ${unfiredDetail(driverOut)}` : ''}`)

const rows = ledgerRows()
const admits = rows.filter(r => r.op === 'sessionAdmit' && r.action !== undefined && /frame-forwarded/.test(r.action))
const admitReplies = rows.filter(r => r.op === 'sessionAdmit' && r.action !== undefined && /^reply-/.test(r.action))
const swallowed = rows.filter(r => r.action === 'reply-swallowed-client-closed')
const heldRows = rows.filter(r => r.action === 'reply-held-client-left-open')
const relayedAdmits = rows.filter(r => r.op === 'sessionAdmit' && r.action === 'reply-relayed')
const deaf = rows.find(r => r.action === 'deaf')
const back = rows.find(r => r.action === 'listening-again')
const finalWorkers = readWorkers()
const bornFinal = bornOf(finalWorkers)
const bornMid = midSnapshot === null ? [] : bornOf(midSnapshot.workers)
const bornIds = new Set(bornFinal.map(w => w.sessionId))
const daemonLogText = existsSync(daemonLog) ? readFileSync(daemonLog, 'utf8') : ''
const daemonAdmissions = daemonLogText.split('\n').filter(l => /takes session|admission replayed|spawned cold|admission refused|registerLongLived|\[daemon\] spawn/.test(l))
const debugDir = join(configDir, 'debug')
let cockpitDebug = ''
try {
  for (const f of readdirSync(debugDir).filter(f => f.endsWith('.txt'))) cockpitDebug += readFileSync(join(debugDir, f), 'utf8')
} catch {
  cockpitDebug = ''
}
const transportLines = cockpitDebug.split('\n').filter(l => /control RPC transport error|daemon closed without a reply|daemon unreachable|re-sent|ENOCONN|ETIMEOUT/.test(l))

section('§3 the records — what the daemon admitted, what the wire lost, what stands on the board')
console.log(`  stand-in ledger (${rows.length} rows):`)
for (const r of rows) console.log(`    +${String(r.sinceMs).padStart(6)}ms ${r.n !== undefined ? `#${r.n} ` : ''}${r.op ?? ''} ${r.action ?? ''}${r.sessionId !== undefined ? ` session=${r.sessionId}` : ''}${r.ok !== undefined ? ` ok=${r.ok}` : ''}${r.ms !== undefined ? ` (${r.ms}ms)` : ''}`)
console.log(`  daemon log admission lines (${daemonAdmissions.length}):`)
for (const l of daemonAdmissions.slice(0, 12)) console.log(`    ${l.trim().slice(0, 160)}`)
console.log(`  cockpit debug transport lines (${transportLines.length}):`)
for (const l of transportLines.slice(0, 12)) console.log(`    ${l.trim().slice(0, 200)}`)
console.log(`  records mid-drive (${midSnapshot === null ? 'no snapshot' : `${new Date(midSnapshot.at).toISOString()}`}): ${text(bornMid.map(w => ({ runnerId: w.runnerId, sessionId: w.sessionId, pid: w.pid, endedAt: w.endedAt, parkedAt: w.parkedAt, keyless: w.keyless, modelKey: w.modelKey })))} · live runner pids ${text(midSnapshot?.live ?? [])}`)
console.log(`  records at the end: ${text(bornFinal.map(w => ({ runnerId: w.runnerId, sessionId: w.sessionId, pid: w.pid, endedAt: w.endedAt, parkedAt: w.parkedAt })))}`)

if (scene === 'lose-after-write') {
  check('the stand-in forwarded the first admit frame to the daemon and closed the client without the reply (the loss AFTER the write)', swallowed.length === 1 && swallowed[0]!.ok === true && typeof swallowed[0]!.sessionId === 'string', text(swallowed))
  check('the daemon admitted the first birth — its reply named a session', swallowed[0]?.ok === true && swallowed[0]?.sessionId !== undefined, text(swallowed[0]))
}
if (scene === 'hold-reply') {
  check('the stand-in forwarded the first admit frame and held its reply (the deadline shape)', heldRows.length === 1 && heldRows[0]!.ok === true, text(heldRows))
  check('the daemon was sent exactly ONE admit (a deadline is never retried)', admits.length === 1, `admits forwarded ${admits.length}`)
}
if (scene === 'lose-before-write') {
  const bootHello = rows.find(r => r.op === 'hello' && r.action === 'reply-relayed')
  check('the stand-in went deaf right after the boot handshake landed and came back after its beat (a connection refused before any write)', deaf !== undefined && back !== undefined && bootHello !== undefined && deaf.at >= bootHello.at, text({ deaf, back }))
  const refusedConnects = transportLines.filter(l => /ECONNREFUSED|ENOENT/.test(l))
  check('the cockpit met the refused connection (its transport log names ECONNREFUSED before the stand-in came back)', refusedConnects.length >= 1, `${refusedConnects.length} refused connects`)
  check('one admit reached the daemon after the stand-in came back', admits.length === 1 && back !== undefined && admits[0]!.at >= back.at, text({ admits: admits.map(a => a.sinceMs), back: back?.sinceMs }))
}
if (scene === 'relay') {
  check('one admit forwarded, one reply relayed (the control world)', admits.length === 1 && relayedAdmits.length === 1, text({ admits: admits.length, relayed: relayedAdmits.length }))
}

const expectRetry = scene === 'lose-after-write'
check(
  expectRetry ? 'the door re-sent the admit once after the lost reply (the re-check road was taken)' : 'the door sent the admit the number of times this shape allows',
  expectRetry ? admits.length === 2 : admits.length === 1,
  `admits forwarded ${admits.length} · replies ${text(admitReplies.map(r => ({ action: r.action, ok: r.ok, sessionId: r.sessionId })))}`,
)
check('EXACTLY ONE SESSION was born by the one ↵ (the records carry one bornBlankAt session)', bornIds.size === 1, `born sessions ${bornIds.size}: ${text([...bornIds])}`)
if (midSnapshot !== null) check('ONE runner stood for the one ↵ mid-drive (no orphan runner beside the entered session)', midSnapshot.live.length === 1, `live runner pids ${text(midSnapshot.live)} · born records ${bornMid.length}`)
if (expectRetry && admitReplies.length === 2) {
  const [first, second] = admitReplies
  check('the re-sent admit answered THE SAME session as the lost reply (the birth replayed, not minted again)', first!.sessionId !== undefined && first!.sessionId === second!.sessionId, `first ${first!.sessionId} · second ${second!.sessionId}`)
}

const t = (g: { rows: string[] }): string => g.rows.join('\n')
if (sendRecs.length === sends.length) {
  const chatAt = at(0) + (scene === 'hold-reply' ? 63_500 : 9_500)
  const boardAt = at(1) + 3500
  const res = spawnSync(driver.python, [join(REPO, 'scripts', 'streaming', 'screengrab.py'), drive, String(COLS), String(ROWS), String(chatAt), String(boardAt), '-1'], { encoding: 'utf8', timeout: vshotBudgetMs(120_000), maxBuffer: 256 * 1024 * 1024 })
  if (res.status !== 0) {
    console.error(`screengrab failed: ${res.stderr}`)
    failures++
  } else {
    const screens = (JSON.parse(res.stdout) as { screens: { atMs: number; rows: string[] }[] }).screens
    const [afterEnter, board, final] = screens
    section('§4 the frames — what the operator saw')
    if (scene === 'hold-reply') {
      check('the deadline refusal is on the face (the birth was refused, not retried)', /the chat could not start/.test(t(afterEnter!)) && /ETIMEOUT|did not answer/.test(t(afterEnter!)), afterEnter!.rows.filter(r => r.trim().length > 0).slice(-4).map(r => r.trim().slice(0, 110)).join(' | '))
    } else {
      check('the cockpit painted after the ↵ (the birth entered a chat)', /\? for shortcuts/.test(t(afterEnter!)) || /Type a prompt/.test(t(afterEnter!)), afterEnter!.rows.filter(r => r.trim().length > 0).slice(-6).map(r => r.trim().slice(0, 100)).join(' | '))
    }
    const boardRows = board!.rows.filter(r => /\bw\d+\b|concourse-w\d+|ready|blank|starting|newborn/i.test(r))
    console.log(`  board rows (${boardRows.length}): ${boardRows.map(r => r.trim().slice(0, 110)).join(' | ')}`)
    if (FRAMES !== undefined) {
      mkdirSync(FRAMES, { recursive: true })
      const stem = `${scene}-${COLS}x${ROWS}`
      writeFileSync(join(FRAMES, `${stem}-after-enter.txt`), t(afterEnter!) + '\n')
      writeFileSync(join(FRAMES, `${stem}-board.txt`), t(board!) + '\n')
      writeFileSync(join(FRAMES, `${stem}-final.txt`), t(final!) + '\n')
      writeFileSync(join(FRAMES, `${stem}-records.json`), JSON.stringify({ bundle: DIST, scene, midSnapshot, final: bornFinal, ledger: rows, daemonAdmissions, transportLines }, null, 1) + '\n')
      console.log(`  frames written under ${FRAMES} (${stem}-*)`)
    }
  }
}

section('§5 the world ends — the daemon, its runners and the stand-in this proof spawned')
try {
  daemon.kill('SIGTERM')
} catch {}
{
  const until = Date.now() + vshotBudgetMs(8000)
  while (Date.now() < until && daemon.exitCode === null && daemon.signalCode === null) await sleep(100)
}
const leftovers = Object.values(readWorkers()).filter(w => w.pid !== undefined && alive(w.pid)).map(w => w.pid!)
for (const pid of leftovers) {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {}
}
try {
  standin.kill('SIGTERM')
} catch {}
await sleep(300)
for (const c of spawned) {
  try {
    if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL')
  } catch {}
}
console.log(`  daemon ${daemon.pid} ended (${daemon.exitCode ?? daemon.signalCode}) · runner pids signalled ${text(leftovers)} · stand-in ended`)
if (KEEP || failures > 0) console.log(`  world kept at ${world}`)
else rmSync(world, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-birth-lost-reply-drive: ONE ↵, ONE SESSION' : `\nprove-birth-lost-reply-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
