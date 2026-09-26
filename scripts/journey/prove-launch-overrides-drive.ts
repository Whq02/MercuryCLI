#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { EFFORT_HIGH } from '../../src/constants/figures.ts'
import { SEAT_VERB_SETTLE_MS } from '../../src/services/engine-connector/daemonConnector.ts'

const REPO = path.resolve(import.meta.dir, '../..')
const SILENCE_HOOK = path.join(import.meta.dir, 'silent-facts-watch.cjs')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const DIST = argAfter('--dist') ?? path.join(REPO, 'dist/mercury.mjs')
const VENDORED_NODE = path.join(path.dirname(DIST), 'vendor', 'node', 'bin', 'node')
const NODE = existsSync(VENDORED_NODE) ? VENDORED_NODE : 'node'
const VSHOT = path.join(REPO, 'scripts/ui/vshot.py')
const BUN = process.env.BUN ?? path.join(process.env.HOME ?? '', '.bun/bin/bun')
const FRAMES = argAfter('--frames')
const HOP_FRAMES = argAfter('--hop-frames')
const GEOMETRY = ((): { cols: number; rows: number } => {
  const m = /^(\d+)x(\d+)$/.exec(argAfter('--geometry') ?? '')
  return m ? { cols: Number(m[1]), rows: Number(m[2]) } : { cols: 110, rows: 44 }
})()
const FULL_LAYOUT = GEOMETRY.cols >= 100 && GEOMETRY.rows >= 26

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

if (!existsSync(DIST)) {
  console.log(`FAIL ${DIST} missing — run \`bun run build.ts\` first (the drive proves the BUILT bundle)`)
  process.exit(1)
}

const SEED_MODEL = 'claude-sonnet-5'
const LAUNCH_MODEL = 'claude-opus-5'
const LAUNCH_EFFORT = 'max'
const TURN_ONE = 'launch turn one alpha-goose'
const TURN_TWO = 'launch turn two beta-heron'
const TURN_THREE = 'launch turn three gamma-ibis'
const HOP_MODEL = 'claude-sonnet-5'
const HOP_EFFORT = 'high'
const HOP_HIGH_NEEDLE = FULL_LAYOUT ? `Sonnet 5 · ${HOP_EFFORT}` : `effort ${HOP_EFFORT}`

const SCRATCH = path.join(realpathSync(tmpdir()), `mercury-launchover-${process.pid}`)
rmSync(SCRATCH, { recursive: true, force: true })
mkdirSync(SCRATCH, { recursive: true })
const capture = path.join(SCRATCH, 'wire-capture.jsonl')
const fixture: ChildProcess = spawn(BUN, ['run', path.join(import.meta.dir, 'mission-fixture-server.ts'), capture], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, MISSION_FIXTURE_REPLY_DELAY_MS: '300' },
})
const port = await new Promise<number>((resolve, reject) => {
  const killer = setTimeout(() => reject(new Error('fixture server never printed PORT')), 15_000)
  let buffer = ''
  fixture.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    const m = /PORT (\d+)/.exec(buffer)
    if (m) {
      clearTimeout(killer)
      resolve(Number(m[1]))
    }
  })
  fixture.on('exit', code => reject(new Error(`fixture server exited early (${code})`)))
}).catch(err => {
  console.log(`FAIL ${String(err)}`)
  process.exit(1)
})
const base = `http://127.0.0.1:${port}`

const reap = (): void => {
  try {
    fixture.kill('SIGTERM')
  } catch {
  }
  if (failures === 0 && FRAMES === undefined) {
    try {
      rmSync(SCRATCH, { recursive: true, force: true })
    } catch {
    }
  } else {
    console.log(`[forensics] world kept: ${SCRATCH}`)
  }
}
process.on('exit', reap)

interface World {
  home: string
  cwd: string
}
function makeWorld(name: string): World {
  const home = path.join(SCRATCH, name)
  const cwd = path.join(home, 'repo')
  mkdirSync(cwd, { recursive: true })
  const probeKey = 'sk-ant-launchover-probe'
  writeFileSync(
    path.join(home, '.mercury.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '99.0.0',
      numStartups: 10,
      theme: 'dark',
      projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
      customApiKeyResponses: { approved: [probeKey.slice(-20)], rejected: [] },
    }),
  )
  writeFileSync(path.join(home, 'settings.json'), JSON.stringify({}))
  writeFileSync(path.join(cwd, 'README.md'), '# launch overrides fixture\n')
  return { home, cwd }
}

function worldEnv(world: World): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DEBUG: '1',
    MERCURY_CONFIG_DIR: world.home,
    MERCURY_CREDENTIAL_STORE: 'file',
    BROWSER: '/usr/bin/true',
    ANTHROPIC_API_KEY: 'sk-ant-launchover-probe',
    ANTHROPIC_BASE_URL: base,
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_VERIFY_EVIDENCE: '0',
    MERCURY_DOCTOR_STATE_DIR: path.join(world.home, 'doctor-state'),
    MERCURY_DAEMON_DIR: path.join(world.home, 'daemon'),
    MERCURY_TEAMS_DIR: path.join(world.home, 'teams'),
    MERCURY_TABULA_DIR: path.join(world.home, 'tabula'),
    MERCURY_HOME: path.join(world.home, 'proof-home'),
  }
  delete env.NODE_ENV
  delete env.ANTHROPIC_AUTH_TOKEN
  delete env.MERCURY_MODEL
  delete env.MERCURY_EFFORT
  return env
}

type Grid = Array<Array<{ c: string }>>
const textOf = (grid: Grid): string => grid.map(r => r.map(c => c.c || ' ').join('')).join('\n')

function drive(
  world: World,
  name: string,
  argvTail: string[],
  sends: unknown[],
  readyText: string[],
  total: number,
  geometry: { cols: number; rows: number },
  envExtra?: NodeJS.ProcessEnv,
): { grid: string; marks: Record<string, string> } {
  const out = path.join(world.home, `grid-${name}.json`)
  const cfg = {
    argv: [NODE, DIST, ...argvTail],
    cwd: world.cwd,
    sends,
    readyText,
    readySettleTicks: 4,
    total,
    cols: geometry.cols,
    rows: geometry.rows,
    out,
  }
  const cfgPath = path.join(world.home, `cfg-${name}.json`)
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
    encoding: 'utf-8',
    timeout: vshotBudgetMs(180_000),
    cwd: world.cwd,
    env: { ...worldEnv(world), ...(envExtra ?? {}) },
  })
  if (!existsSync(out)) {
    check(`${name}: capture produced a grid`, false, `vshot: ${String(res.stderr).slice(0, 300)}`)
    return { grid: '', marks: {} }
  }
  const payload = JSON.parse(readFileSync(out, 'utf8')) as { grid: Grid; marks?: Array<{ label: string; grid: Grid }> }
  const grid = textOf(payload.grid)
  const marks: Record<string, string> = {}
  for (const m of payload.marks ?? []) {
    marks[m.label] = textOf(m.grid)
    writeFileSync(path.join(world.home, `mark-${name}-${m.label}.txt`), marks[m.label]!)
  }
  writeFileSync(path.join(world.home, `final-${name}.txt`), grid)
  if (readyText.length > 0 && !readyText.some(t => grid.includes(t))) {
    console.log(`  [vshot ${name}] ${String(res.stderr ?? '').trim().replace(/\s+/g, ' ').slice(-700)}`)
  }
  return { grid, marks }
}

type WorkerRecord = { sessionId?: string; modelKey?: string; effort?: string; endedAt?: number; spawnedAt?: number }
function sessionRecords(world: World): WorkerRecord[] {
  try {
    const raw = JSON.parse(readFileSync(path.join(world.home, 'daemon', 'concourse-workers.json'), 'utf8')) as unknown
    const table = (raw && typeof raw === 'object' && 'workers' in (raw as Record<string, unknown>) ? (raw as { workers: unknown }).workers : raw) as Record<string, WorkerRecord>
    return Object.values(table ?? {}).filter(r => r && typeof r === 'object')
  } catch {
    return []
  }
}
function newestRecord(world: World): WorkerRecord | undefined {
  return sessionRecords(world)
    .filter(r => r.endedAt === undefined)
    .sort((a, b) => (b.spawnedAt ?? 0) - (a.spawnedAt ?? 0))[0]
}

function wireRequests(): Array<{ path: string; body: Record<string, unknown> | null }> {
  try {
    return readFileSync(capture, 'utf8')
      .trim()
      .split('\n')
      .filter(l => l.trim() !== '')
      .map(l => JSON.parse(l) as { path: string; body: Record<string, unknown> | null })
      .filter(r => r.path.endsWith('/v1/messages'))
  } catch {
    return []
  }
}

const stripLine = (grid: string, model: string): string =>
  grid.split('\n').find(l => l.includes(model) && /\b(high|max|medium|low|xhigh)\b/.test(l)) ?? ''

type LatencyMark = { label: string; atMs: number; grid: Grid }
function convergenceLatencyMs(world: World, name: string, model: string, effortWord: string): { ms: number | undefined; label: string; hoppedAtMs: number | undefined; sampleGrids: Array<{ label: string; atMs: number; text: string; high: boolean }> } {
  try {
    const payload = JSON.parse(readFileSync(path.join(world.home, `grid-${name}.json`), 'utf8')) as { marks?: LatencyMark[] }
    const marks = payload.marks ?? []
    const hopped = marks.find(m => m.label === 'hopped')
    const samples = marks.filter(m => /^s\d+$/.test(m.label)).sort((a, b) => a.atMs - b.atMs)
    const isHigh = (text: string): boolean =>
      text.split('\n').some(l => l.includes(model) && new RegExp(`(${EFFORT_HIGH}|effort|${model} ·)\\s*${effortWord}\\b`).test(l))
    const sampleGrids = samples.map(s => ({ label: s.label, atMs: s.atMs, text: textOf(s.grid), high: false }))
    for (const g of sampleGrids) g.high = isHigh(g.text)
    if (hopped === undefined) return { ms: undefined, label: 'hopped-missing', hoppedAtMs: undefined, sampleGrids }
    const firstHigh = sampleGrids.find(g => g.high)
    return { ms: firstHigh === undefined ? undefined : firstHigh.atMs - hopped.atMs, label: firstHigh?.label ?? 'never-in-samples', hoppedAtMs: hopped.atMs, sampleGrids }
  } catch (e) {
    return { ms: undefined, label: `read-error ${String(e).slice(0, 60)}`, hoppedAtMs: undefined, sampleGrids: [] }
  }
}

console.log('============================================================')
console.log(' launch overrides on a resume — --model/--effort win over the saved values')
console.log(`   bundle: ${DIST}`)
console.log('============================================================')

const world = makeWorld('world')

section(`stage A — a session born on --model ${SEED_MODEL}; one turn settles; /exit parks it`)
const a = drive(
  world,
  'seed',
  ['--model', SEED_MODEL],
  [
    { atTick: 40, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
    { atTick: 100, minTick: 20, awaitText: '? for shortcuts', data: `${TURN_ONE}\r` },
    { atTick: 220, minTick: 30, awaitText: 'reply to [[launch turn one', awaitSettleTicks: 3, data: '', mark: 'seeded' },
    { afterPrevTicks: 2, data: '/exit\r' },
  ],
  [],
  300,
  { cols: 110, rows: 44 },
)
check('the seed turn settled (its reply painted)', a.grid.includes('reply to [[launch turn one') || (a.marks.seeded ?? '').includes('reply to [[launch turn one'), a.grid.slice(-400))
check(`the strip read Sonnet 5 · high while the session ran`, /Sonnet 5/.test(stripLine(a.marks.seeded ?? '', 'Sonnet 5')) && /\bhigh\b/.test(stripLine(a.marks.seeded ?? '', 'Sonnet 5')), stripLine(a.marks.seeded ?? '', 'Sonnet').trim() || '(no strip line)')
const seeded = newestRecord(world)
check(`the session record saved the model ${SEED_MODEL}`, seeded?.modelKey === SEED_MODEL, JSON.stringify(seeded))
check("the session record saved the effort 'high'", seeded?.effort === 'high', JSON.stringify(seeded))
const seedRequests = wireRequests().length

section(`stage B — --continue --model ${LAUNCH_MODEL} --effort ${LAUNCH_EFFORT} (${GEOMETRY.cols}x${GEOMETRY.rows})`)
const b = drive(
  world,
  'resume',
  ['--continue', '--model', LAUNCH_MODEL, '--effort', LAUNCH_EFFORT],
  [
    { atTick: 260, minTick: 24, awaitText: 'resumed', awaitSettleTicks: 12, data: '', mark: 'card' },
    { afterPrevTicks: 2, data: `${TURN_TWO}\r` },
  ],
  ['reply to [[launch turn two'],
  460,
  GEOMETRY,
)
const card = b.marks.card ?? ''
if (FRAMES !== undefined) {
  mkdirSync(FRAMES, { recursive: true })
  writeFileSync(path.join(FRAMES, `resume-card-${GEOMETRY.cols}x${GEOMETRY.rows}.txt`), card)
  writeFileSync(path.join(FRAMES, `resume-final-${GEOMETRY.cols}x${GEOMETRY.rows}.txt`), b.grid)
}
check('the prior turn painted after --continue', card.includes('alpha-goose') || b.grid.includes('alpha-goose'), b.grid.slice(-400))
check('the resume card painted', /resumed/.test(card), card.split('\n').filter(l => l.trim()).slice(-12).join('\n'))
const stripB = stripLine(card, 'Opus 5')
check(`the strip reads Opus 5 · ${LAUNCH_EFFORT} on the resumed chat (the launch's model and effort, not the saved ones)`, /Opus 5/.test(stripB) && new RegExp(`\\b${LAUNCH_EFFORT}\\b`).test(stripB), (stripLine(card, 'Sonnet 5') || stripLine(card, 'Opus 5') || '(no strip line)').trim())
check('the resume card names which won: the --model flag over the saved Sonnet 5', /--model Opus 5 wins over the session's Sonnet 5/.test(card.replace(/\s+/g, ' ')), card.split('\n').filter(l => /wins|resumed/.test(l)).join(' | ').trim() || '(no winner row)')
check("the resume card names which won: the --effort flag over the saved high", /--effort max wins over the session's high/.test(card.replace(/\s+/g, ' ')), card.split('\n').filter(l => /wins|resumed/.test(l)).join(' | ').trim() || '(no winner row)')
const resumed = newestRecord(world)
check(`the session record is re-stamped with ${LAUNCH_MODEL}`, resumed?.modelKey === LAUNCH_MODEL, JSON.stringify(resumed))
check(`the session record is re-stamped with effort ${LAUNCH_EFFORT}`, resumed?.effort === LAUNCH_EFFORT, JSON.stringify(resumed))
check('the resumed turn answered (its reply painted)', b.grid.includes('reply to [[launch turn two'), b.grid.slice(-400))
const resumedRequests = wireRequests().slice(seedRequests)
const carrying = resumedRequests.filter(r => JSON.stringify(r.body ?? null).includes(TURN_TWO))
check('the resumed request reached the wire', carrying.length > 0, `${resumedRequests.length} request(s) after the seed`)
const last = carrying[carrying.length - 1]?.body ?? null
check(`the resumed request carries model ${LAUNCH_MODEL}`, last?.model === LAUNCH_MODEL, `model=${String(last?.model)}`)
const wireEffort = (last?.output_config as { effort?: string } | undefined)?.effort
check(`the resumed request carries effort ${LAUNCH_EFFORT}`, wireEffort === LAUNCH_EFFORT, `output_config.effort=${String(wireEffort)}`)

if (FRAMES !== undefined) {
  console.log('\n' + '='.repeat(60))
  console.log(failures === 0 ? ' launch overrides (frames run, stages A and B): ALL LAWS HOLD' : ` launch overrides (frames run): ${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

section(`stage C — the session live under another screen: --continue --model ${HOP_MODEL} --effort ${HOP_EFFORT} hops in and switches it`)
const holdOut = path.join(world.home, 'grid-hold.json')
writeFileSync(path.join(world.home, 'cfg-hold.json'), JSON.stringify({ argv: [NODE, DIST, '--continue'], cwd: world.cwd, sends: [], readyText: [], total: 600, cols: 110, rows: 44, out: holdOut }))
const hold = spawn('/usr/bin/python3', [VSHOT, path.join(world.home, 'cfg-hold.json')], { cwd: world.cwd, env: worldEnv(world), stdio: ['ignore', 'pipe', 'pipe'] })
const focusedBefore = newestRecord(world) as { focusedAt?: number } | undefined
let live = false
for (let waited = 0; waited < 60_000 && !live; waited += 500) {
  await sleep(500)
  const rec = newestRecord(world) as { pid?: number; focusedAt?: number; parkedAt?: number } | undefined
  if (rec?.pid === undefined || rec.parkedAt !== undefined) continue
  if ((rec.focusedAt ?? 0) <= (focusedBefore?.focusedAt ?? 0)) continue
  try {
    process.kill(rec.pid, 0)
    live = true
  } catch {
  }
}
check('the first screen holds the session live (its runner alive, the record focused)', live, JSON.stringify(newestRecord(world)).slice(0, 300))
const requestsBeforeHop = wireRequests().length
const HOP_SAMPLES = Array.from({ length: 12 }, (_, i) => ({ afterPrevTicks: 3, data: '', mark: `s${i + 1}` }))
const c = drive(
  world,
  'hop',
  ['--continue', '--model', HOP_MODEL, '--effort', HOP_EFFORT],
  [
    { atTick: 260, minTick: 24, awaitText: 'wins over', awaitSettleTicks: 4, data: '', mark: 'hopped' },
    ...HOP_SAMPLES,
    { atTick: 340, minTick: 26, awaitText: HOP_HIGH_NEEDLE, requireAwait: true, awaitSettleTicks: 2, data: '', mark: 'strip' },
    { afterPrevTicks: 2, data: `${TURN_THREE}\r` },
  ],
  ['reply to [[launch turn three'],
  460,
  GEOMETRY,
  { NODE_OPTIONS: `--require ${SILENCE_HOOK}`, PROOF_SILENCE_FACTS_WATCH: 'session-facts', PROOF_SILENCE_FACTS_WATCH_LOG: path.join(world.home, 'silence-count.txt') },
)
const silencedWatchers = ((): string => {
  try {
    return readFileSync(path.join(world.home, 'silence-count.txt'), 'utf8').trim()
  } catch {
    return '0'
  }
})()
console.log(`  [note] the facts watch was forced silent by ${SILENCE_HOOK} — ${silencedWatchers} session-facts watcher(s) kept live but with the callback swallowed (the FSEvents reschedule drop)`)
try {
  hold.kill('SIGTERM')
} catch {
}
const hopped = c.marks.hopped ?? c.grid
check('the second screen entered the live session (the prior turns painted)', hopped.includes('alpha-goose') || c.grid.includes('alpha-goose'), c.grid.slice(-400))
check(`the receipt row names which won: --model Sonnet 5 over the session's Opus 5`, /--model Sonnet 5 wins over the session's Opus 5/.test(hopped.replace(/\s+/g, ' ')), hopped.split('\n').filter(l => /wins|refused/.test(l)).join(' | ').trim() || '(no receipt row)')
check(`the receipt row names which won: --effort high over the session's max`, /--effort high wins over the session's max/.test(hopped.replace(/\s+/g, ' ')), hopped.split('\n').filter(l => /wins|refused/.test(l)).join(' | ').trim() || '(no receipt row)')
const stripFrame = c.marks.strip ?? hopped
const stripC = stripLine(stripFrame, 'Sonnet 5')
check(`the strip reads Sonnet 5 · ${HOP_EFFORT} on the hopped chat`, /Sonnet 5/.test(stripC) && new RegExp(`\\b${HOP_EFFORT}\\b`).test(stripC), (stripLine(stripFrame, 'Opus 5') || stripLine(stripFrame, 'Sonnet 5') || '(no strip line)').trim())
const conv = convergenceLatencyMs(world, 'hop', 'Sonnet 5', HOP_EFFORT)
console.log(`  [note] with the facts watch silenced (the FSEvents reschedule drop, forced), the strip converged to ${HOP_EFFORT} ${conv.ms === undefined ? 'NOT within the sampled window — it waited the idle floor' : `${conv.ms} ms (${conv.label})`} after the receipt; the seat-verb settle nudge bounds this at ${SEAT_VERB_SETTLE_MS} ms, the old build without it waits IDLE_PROJECTION_FLOOR_MS`)
check(`the strip converges to the hop's effort within SEAT_VERB_SETTLE_MS (${SEAT_VERB_SETTLE_MS} ms) of the receipt, not the idle floor`, conv.ms !== undefined && conv.ms < SEAT_VERB_SETTLE_MS, `latency=${conv.ms === undefined ? 'never in samples (idle-floor lag)' : `${conv.ms} ms`} bound=${SEAT_VERB_SETTLE_MS} ms`)
if (HOP_FRAMES !== undefined) {
  mkdirSync(HOP_FRAMES, { recursive: true })
  const base = conv.hoppedAtMs ?? conv.sampleGrids[0]?.atMs ?? 0
  const boundSample = conv.sampleGrids
    .slice()
    .sort((a, b) => Math.abs(a.atMs - base - SEAT_VERB_SETTLE_MS) - Math.abs(b.atMs - base - SEAT_VERB_SETTLE_MS))[0]
  if (boundSample !== undefined) writeFileSync(path.join(HOP_FRAMES, `effort-chip-${GEOMETRY.cols}x${GEOMETRY.rows}.txt`), boundSample.text)
  writeFileSync(path.join(HOP_FRAMES, `effort-chip-strip-${GEOMETRY.cols}x${GEOMETRY.rows}.txt`), c.marks.strip ?? c.grid)
}
check('the turn after the hop answered', c.grid.includes('reply to [[launch turn three'), c.grid.slice(-400))
const hopBodies = wireRequests().slice(requestsBeforeHop).filter(r => JSON.stringify(r.body ?? null).includes(TURN_THREE))
const lastHop = hopBodies[hopBodies.length - 1]?.body ?? null
check(`the request after the hop carries model ${HOP_MODEL}`, lastHop?.model === HOP_MODEL, `model=${String(lastHop?.model)}`)
const hopEffort = (lastHop?.output_config as { effort?: string } | undefined)?.effort
check(`the request after the hop carries effort ${HOP_EFFORT}`, hopEffort === HOP_EFFORT, `output_config.effort=${String(hopEffort)}`)

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' launch overrides: ALL LAWS HOLD')
  process.exit(0)
}
console.log(` launch overrides: ${failures} FAILURE(S)`)
process.exit(1)
