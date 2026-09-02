#!/usr/bin/env bun
// ============================================================================
//  scripts/render-migration/measure-numbers.ts — THE MEASURED NUMBERS the
//  migration can measure ("This measures, concretely"),
//  engine ON against today's painter OFF, on the real built artifact in a
//  real PTY against a loopback wire fixture (the Anthropic dialect through
//  the REAL provider layer; zero network).
//
//  ONE capture per leg, one timeline (ptyrec.py records every byte with a
//  monotonic stamp; the fixture logs request arrival on the wall clock;
//  ptyrec prints its wall-clock origin so the two align):
//    t≈6s   30 single keystrokes at 120ms — KEYSTROKE ECHO (input→echo
//           byte latency, p50/p90), ON must not regress vs OFF;
//    then   Enter — FIRST GLYPH (Enter→first streamed word visible) and
//           SEND START (Enter→the fixture's POST arrival);
//    t≈+9s  a WINCH storm mid-stream (three jolts 40ms apart) — RESIZE
//           SETTLE: one settled repaint ≤300ms after the last jolt;
//    then   a LONG answer (the canonical markdown ×REPEAT at 40 chunks/s)
//           — STREAMING PAINT GAPS p99 ≤ 70ms over the whole stream.
//
//  Verdicts are the ratified thresholds on the ON leg; the OFF leg is the
//  baseline row beside them. Every number lands in a JSON receipt.
//
//  Run: ~/.bun/bin/bun run scripts/render-migration/measure-numbers.ts
//       [--skip-build] [--repeat N] [--legs off,on] [--out DIR]
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
const RIG = join(import.meta.dir, 'rig')
const PY = '/usr/bin/python3'

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const OUT = arg('--out') ?? mkdtempSync(join(tmpdir(), 'engine-numbers-'))
const REPEAT = Number(arg('--repeat') ?? 6)
const LEGS = (arg('--legs') ?? 'off,on').split(',') as Array<'off' | 'on'>
const FIXTURE_PORT = Number(arg('--port') ?? 34611)
const COLS = 120
const ROWS = 40

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const note = (label: string, detail: string): void => console.log(`  [MEAS] ${label} — ${detail}`)
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))

console.log('============================================================')
console.log(' the measured numbers — engine ON vs today OFF, real PTY')
console.log(`  out → ${OUT}`)
console.log('============================================================')
mkdirSync(OUT, { recursive: true })

if (!process.argv.includes('--skip-build')) {
  const build = spawnSync(process.execPath, ['run', 'build.ts'], { cwd: REPO, encoding: 'utf8', timeout: 600_000 })
  check('dist rebuilt from this tree (stale-dist guard)', build.status === 0, (build.stderr ?? '').slice(-300))
}
if (!existsSync(BIN)) {
  check('dist/mercury.mjs exists', false)
  process.exit(1)
}
// The seed records the custom-key approval from ITS OWN env (the product's
// own customApiKeyResponses shape) — without it every capture boots the
// "use this API key?" dialog and the typed keystrokes land there, not in
// the composer (the first drive measured exactly that).
const FIXTURE_KEY = 'sk-ant-fixture-numbers-key'
process.env.ANTHROPIC_API_KEY = FIXTURE_KEY
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')

// ── the loopback wire fixture (its own process; the pty child reaches it) ──
const fixtureLog = join(OUT, 'fixture.log')
const fixture = spawn('node', [join(RIG, 'fixture-server.mjs')], {
  env: { ...process.env, FIXTURE_PORT: String(FIXTURE_PORT), FIXTURE_TPS: '40', FIXTURE_TTFB_MS: '350', FIXTURE_REPEAT: String(REPEAT) },
  stdio: ['ignore', 'ignore', 'pipe'],
})
let fixtureStderr = ''
fixture.stderr.on('data', d => {
  fixtureStderr += String(d)
})
await new Promise(r => setTimeout(r, 800))
check('the fixture is listening', fixtureStderr.includes('listening'), fixtureStderr.slice(0, 200))

// ── capture one leg ────────────────────────────────────────────────────────
const FIX = join(OUT, 'fixture-cwd')
mkdirSync(FIX, { recursive: true })
writeFileSync(join(FIX, 'README.md'), '# numbers capture fixture\n')

type LegResult = {
  leg: string
  cap: string
  t0WallMs: number | null
  analysis: string
  echo: { n: number; p50: number; p90: number; max: number } | null
  ttfgMs: number | null
  sendStartMs: number | null
  gapP99: number | null
  gapP90: number | null
  paints: number
  resizeSettleMs: number | null
  resizePaintsAfterLastJolt: number | null
  streamSpanS: number | null
}

const KEYS = 'measure the reply now'.split('')
const TYPE_START_MS = 16000
const TYPE_GAP_MS = 120
const ENTER_MS = TYPE_START_MS + KEYS.length * TYPE_GAP_MS + 400
const STORM_MS = ENTER_MS + 9000
const STORM = [
  { at: STORM_MS, size: '100x30' },
  { at: STORM_MS + 40, size: '110x36' },
  { at: STORM_MS + 80, size: '100x30' },
]
const TIMEOUT_S = 60 + REPEAT * 22

function captureLeg(leg: 'off' | 'on'): LegResult {
  const home = join(OUT, `home-${leg}`)
  seedFirstRun(home, [FIX, realpathSync(FIX)])
  const cap = join(OUT, `numbers-${leg}.rec`)
  const args = [
    join(RIG, 'ptyrec.py'),
    '--cols', String(COLS), '--rows', String(ROWS),
    '--out', cap,
    '--timeout', String(TIMEOUT_S),
    '--respond',
    '--quit-after-quiet', '6',
    '--cwd', FIX,
    '--env', `ANTHROPIC_BASE_URL=http://127.0.0.1:${FIXTURE_PORT}`,
    '--env', `ANTHROPIC_API_KEY=${FIXTURE_KEY}`,
    '--env', `MERCURY_CONFIG_DIR=${home}`,
    '--env', `MERCURY_DAEMON_DIR=${join(OUT, `daemon-${leg}`)}`,
    '--env', `MERCURY_TEAMS_DIR=${join(OUT, `teams-${leg}`)}`,
    '--env', `MERCURY_TABULA_DIR=${join(OUT, `tabula-${leg}`)}`,
    '--env', `MERCURY_HOME=${join(OUT, `mhome-${leg}`)}`,
    '--env', 'MERCURY_LIVE_GLYPHS=0',
    '--env', 'MERCURY_CRITTER_GAZE=0',
    '--env', 'MERCURY_TURN_RECEIPT=0',
    '--env', 'MERCURY_TABULA_MINERVA=0',
    '--env', 'MERCURY_LOCAL_PROBE_TARGETS=none',
    '--env', 'VISUAL=', '--env', 'EDITOR=',
    ...(leg === 'on' ? ['--env', 'MERCURY_RENDER_ENGINE=1', '--env', 'MERCURY_ENGINE_ASSERT=1'] : ['--env', 'MERCURY_RENDER_ENGINE=']),
  ]
  KEYS.forEach((k, i) => args.push('--send', `${TYPE_START_MS + i * TYPE_GAP_MS}:${k}`))
  args.push('--send', `${ENTER_MS}:\\r`)
  for (const s of STORM) args.push('--resize', `${s.at}:${s.size}`)
  args.push('--', 'node', BIN)

  // The key must be approved in the seeded home the way the product records
  // it (the seed reads ANTHROPIC_API_KEY from ITS env at seed time).
  const res = spawnSync(PY, args, {
    encoding: 'utf8',
    timeout: (TIMEOUT_S + 30) * 1000,
    env: { ...process.env, ANTHROPIC_API_KEY: FIXTURE_KEY },
  })
  const t0 = /ptyrec_t0_wall_ms=(\d+)/.exec(res.stderr ?? '')
  const t0WallMs = t0 ? Number(t0[1]) : null

  // ── analysis ─────────────────────────────────────────────────────────────
  const frames = loadFrames(cap)
  const outs = frames.filter(f => f.dir === 0)
  const ins = frames.filter(f => f.dir === 1)
  const enterFrame = ins.find(f => f.data.includes('\r'))
  const enterS = enterFrame ? enterFrame.t / 1e9 : null

  // Echo latency (single printable inputs → first output containing them).
  const lat: number[] = []
  for (const i of ins) {
    if (i.data.length !== 1 || i.data.charCodeAt(0) < 32 || i.data.charCodeAt(0) >= 127) continue
    const o = outs.find(o => o.t > i.t && o.data.includes(i.data))
    if (o) lat.push((o.t - i.t) / 1e6)
  }
  lat.sort((a, b) => a - b)
  const pct = (v: number[], p: number): number => (v.length ? v[Math.min(v.length - 1, Math.floor((p / 100) * v.length))]! : 0)
  const echo = lat.length && lat[0]! < 600 ? { n: lat.length, p50: pct(lat, 50), p90: pct(lat, 90), max: lat[lat.length - 1]! } : null

  // First glyph and stream end are read off the EMULATED SCREEN (raw frames
  // split words across cell-diff writes; the header clock repaints every
  // second forever, so a quiet-gap end never comes): the rig's screen.py
  // reports the first instant the answer's first word is visible, and the
  // first instant after it that the composer's idle hint is back.
  const marker = 'tighten'
  const firstVisible = (needle: string, after: number): number | null => {
    const r = spawnSync(PY, [join(RIG, 'screen.py'), cap, '--cols', String(COLS), '--rows', String(ROWS), '--find', needle, '--after', String(after)], { encoding: 'utf8', timeout: 120_000 })
    const m = /first visible at t=([0-9.]+)s/.exec(r.stdout ?? '')
    return m ? Number(m[1]) * 1e9 : null
  }
  const seenT = enterFrame ? firstVisible(marker, enterFrame.t / 1e9) : null
  const seen = seenT !== null ? { t: seenT } : undefined
  const ttfgMs = enterFrame && seen ? (seen.t - enterFrame.t) / 1e6 : null

  // Send start: Enter (wall) → the fixture's POST arrival (wall).
  let sendStartMs: number | null = null
  if (t0WallMs !== null && enterFrame) {
    const enterWall = t0WallMs + enterFrame.t / 1e6
    const posts = [...fixtureStderr.matchAll(/POST \/[^ ]*messages[^\n]*wall_ms=(\d+)/g)].map(m => Number(m[1]))
    const post = posts.filter(p => p >= enterWall - 50).sort((a, b) => a - b)[0]
    if (post !== undefined) sendStartMs = post - enterWall
  }

  // The stream span: first answer byte → the last fixture chunk landing
  // (approximated as the last output before a ≥1.5s quiet gap after the
  // stream began).
  let streamStartS: number | null = seen ? seen.t / 1e9 : null
  let streamEndS: number | null = null
  if (streamStartS !== null) {
    const idleT = firstVisible('Type a prompt', streamStartS + 2)
    streamEndS = idleT !== null ? idleT / 1e9 : outs[outs.length - 1]!.t / 1e9
  }

  // Paint gaps over the stream window, excluding the storm's own window
  // (the storm is measured separately below): coalesce <2ms bursts.
  let gapP99: number | null = null
  let gapP90: number | null = null
  let paints = 0
  if (streamStartS !== null && streamEndS !== null) {
    const stormT0 = (STORM[0]!.at - 200) / 1e3
    const stormT1 = (STORM[STORM.length - 1]!.at + 600) / 1e3
    const w = outs.filter(o => {
      const s = o.t / 1e9
      return s >= streamStartS! && s <= streamEndS! && !(s >= stormT0 && s <= stormT1)
    })
    const bursts: Array<[number, number]> = []
    for (const o of w) {
      if (bursts.length && o.t - bursts[bursts.length - 1]![1] < 2e6) bursts[bursts.length - 1]![1] = o.t
      else bursts.push([o.t, o.t])
    }
    paints = bursts.length
    const gaps: number[] = []
    for (let i = 1; i < bursts.length; i++) {
      const g = (bursts[i]![0] - bursts[i - 1]![0]) / 1e6
      // A gap that straddles the excluded storm window is not a paint gap.
      if (bursts[i - 1]![0] / 1e9 < stormT0 && bursts[i]![0] / 1e9 > stormT1) continue
      gaps.push(g)
    }
    gaps.sort((a, b) => a - b)
    gapP99 = pct(gaps, 99)
    gapP90 = pct(gaps, 90)
  }

  // Resize settle: from the LAST jolt to the end of the first paint burst
  // that follows it; paints between the last jolt and that settle.
  let resizeSettleMs: number | null = null
  let resizePaintsAfterLastJolt: number | null = null
  {
    const lastJoltS = STORM[STORM.length - 1]!.at / 1e3
    const after = outs.filter(o => o.t / 1e9 >= lastJoltS && o.t / 1e9 <= lastJoltS + 2)
    const bursts: Array<[number, number]> = []
    for (const o of after) {
      if (bursts.length && o.t - bursts[bursts.length - 1]![1] < 8e6) bursts[bursts.length - 1]![1] = o.t
      else bursts.push([o.t, o.t])
    }
    if (bursts.length) {
      // The settled repaint is the first burst that starts ≥ the settle
      // window (the engine's 120ms quiet) after the last jolt; earlier
      // bursts are holding paints or in-flight stream frames.
      const settled = bursts.find(b => b[0] / 1e9 >= lastJoltS + 0.1) ?? bursts[0]!
      resizeSettleMs = settled[1] / 1e6 - lastJoltS * 1e3
      resizePaintsAfterLastJolt = bursts.filter(b => b[0] <= settled[0]).length
    }
  }

  return {
    leg,
    cap,
    t0WallMs,
    analysis: '',
    echo,
    ttfgMs,
    sendStartMs,
    gapP99,
    gapP90,
    paints,
    resizeSettleMs,
    resizePaintsAfterLastJolt,
    streamSpanS: streamStartS !== null && streamEndS !== null ? streamEndS - streamStartS : null,
  }
}

function loadFrames(path: string): Array<{ t: number; dir: number; data: string }> {
  const buf = readFileSync(path)
  const frames: Array<{ t: number; dir: number; data: string }> = []
  let off = 0
  while (off + 13 <= buf.length) {
    const t = Number(buf.readBigUInt64LE(off))
    const dir = buf.readUInt8(off + 8)
    const n = buf.readUInt32LE(off + 9)
    off += 13
    frames.push({ t, dir, data: buf.subarray(off, off + n).toString('latin1') })
    off += n
  }
  return frames
}

const results: Record<string, LegResult> = {}
for (const leg of LEGS) {
  section(`leg ${leg.toUpperCase()} — ${leg === 'on' ? 'MERCURY_RENDER_ENGINE=1 (+ASSERT)' : 'today’s painter'}`)
  const r = captureLeg(leg)
  results[leg] = r
  check(`${leg}: the capture produced frames`, existsSync(r.cap) && r.paints > 0, `paints=${r.paints}`)
  note('keystroke echo', r.echo ? `n=${r.echo.n} p50=${r.echo.p50.toFixed(1)}ms p90=${r.echo.p90.toFixed(1)}ms max=${r.echo.max.toFixed(1)}ms` : 'not measurable')
  note('first glyph (Enter→first answer word)', r.ttfgMs === null ? 'not measurable' : `${r.ttfgMs.toFixed(0)}ms`)
  note('send start (Enter→POST arrival)', r.sendStartMs === null ? 'not measurable' : `${r.sendStartMs.toFixed(0)}ms`)
  note('streaming paint gaps', r.gapP99 === null ? 'not measurable' : `p90=${r.gapP90!.toFixed(1)}ms p99=${r.gapP99.toFixed(1)}ms over ${r.paints} paints, ${r.streamSpanS!.toFixed(1)}s stream`)
  note('resize settle (last jolt→settled repaint end)', r.resizeSettleMs === null ? 'not measurable' : `${r.resizeSettleMs.toFixed(0)}ms, ${r.resizePaintsAfterLastJolt} paint burst(s) to the settle`)
}

section('verdicts — the ratified thresholds on the ON leg, OFF beside them')
const on = results.on
const off = results.off
if (on) {
  check('ON: streaming paint gaps p99 ≤ 70ms over the long stream', on.gapP99 !== null && on.gapP99 <= 70, `p99=${on.gapP99?.toFixed(1)}ms (OFF p99=${off?.gapP99?.toFixed(1) ?? '—'}ms)`)
  check('ON: mid-stream resize — one settled repaint ≤ 300ms after the last jolt', on.resizeSettleMs !== null && on.resizeSettleMs <= 300, `${on.resizeSettleMs?.toFixed(0)}ms (OFF ${off?.resizeSettleMs?.toFixed(0) ?? '—'}ms)`)
  if (off?.echo && on.echo) {
    check('ON: keystroke echo p90 does not regress vs OFF (≤ OFF p90 + 5ms)', on.echo.p90 <= off.echo.p90 + 5, `ON p50=${on.echo.p50.toFixed(1)} p90=${on.echo.p90.toFixed(1)} · OFF p50=${off.echo.p50.toFixed(1)} p90=${off.echo.p90.toFixed(1)}`)
  } else {
    check('echo measurable on both legs', false)
  }
  note('first glyph ON vs OFF', `ON ${on.ttfgMs?.toFixed(0) ?? '—'}ms · OFF ${off?.ttfgMs?.toFixed(0) ?? '—'}ms (spec 06 budget: ≤600ms at a 400ms floor)`)
  note('send start ON vs OFF', `ON ${on.sendStartMs?.toFixed(0) ?? '—'}ms · OFF ${off?.sendStartMs?.toFixed(0) ?? '—'}ms (spec 06 budget: ≤100ms warmed)`)
}

writeFileSync(join(OUT, 'numbers.json'), JSON.stringify({ generatedAt: new Date().toISOString(), repeat: REPEAT, results }, null, 2))
fixture.kill('SIGTERM')
console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
console.log(`receipt: ${join(OUT, 'numbers.json')}`)
process.exit(failures === 0 ? 0 : 1)
