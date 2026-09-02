#!/usr/bin/env bun
// ============================================================================
//  scripts/core-runtime/bench-baseline.ts — performance
//  baseline/receipt runner (operator-run; NOT a gate member — no run-all.sh
//  membership).
//
//  Records the brief's performance floor quantities against the CURRENT dist,
//  ≥30 reps each, reported p50/p95/max:
//    · cold first paint + cold editable (ready) — 30 real cold boots in a PTY
//    · idle keystroke echo — ≥120 trials across 3 process reps (the FEEL)
//    · idle render traffic + RSS/CPU during the idle window
//    · streaming(+tool) update echo — the sentinel bench, every scene
//
//  Usage:
//    bun run scripts/core-runtime/bench-baseline.ts --label baseline
//    bun run scripts/core-runtime/bench-baseline.ts --label after-t1
//
//  Writes <out>/<label>.json (+ prints the summary).
//  Compare runs with plain jq/diff — the ledger records deltas per cut.
// ============================================================================
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const SMOOTH = join(REPO, 'scripts', 'ui', 'bench-harness-smoothness.py')
const OUT_DIR = join(REPO, 'docs', 'benchmarks', 'native-core')

const argv = process.argv.slice(2)
const label = argv.includes('--label') ? argv[argv.indexOf('--label') + 1]! : 'baseline'
const COLD_REPS = Number(process.env.NC_COLD_REPS ?? 30)
const ECHO_RUNS = Number(process.env.NC_ECHO_RUNS ?? 3)
const ECHO_TRIALS = Number(process.env.NC_ECHO_TRIALS ?? 40)
// instrument options (defaults preserve the BASELINE.md protocol exactly):
//   NC_HONEST_READY=1 → measure TRUE editability (the default 1.5s pre-probe
//     pump floors ready_ms at ~1500ms; --honest-ready waits for the child to
//     arm raw mode — kernel echo off — then probes; see the harness header).
//   NC_SKIP_FLUX=1 → skip the streaming scenes (they are untouched by boot work).
const HONEST_READY = process.env.NC_HONEST_READY === '1'
const SKIP_FLUX = process.env.NC_SKIP_FLUX === '1'

interface SmoothRun {
  first_paint_ms: number | null
  alt_screen_ms?: number | null
  big_frame_ms?: number | null
  ready_ms: number | null
  echo_trials: number
  echo_all_ms?: number[]
  idle_writes_s: number | null
  idle_bytes_s: number | null
  rss_max_kb: number | null
  cpu_idle_avg_pct: number | null
  clears_post_ready: number
}

function runSmooth(args: string[]): SmoothRun {
  // PATH python3 (the harness needs 3.10+ union syntax; /usr/bin/python3 is
  // the 3.9 system stub on this machine — the python-owner lesson).
  const honest = HONEST_READY ? ['--honest-ready'] : []
  const res = spawnSync(
    'python3',
    [SMOOTH, '--label', label, ...honest, ...args, '--', 'node', join(REPO, 'dist', 'mercury.mjs')],
    { encoding: 'utf8', cwd: REPO, timeout: 180_000 },
  )
  if (res.status !== 0) throw new Error(`smoothness bench failed: ${res.stderr}`)
  // The JSON object is the last stdout line.
  const lines = res.stdout.trim().split('\n')
  return JSON.parse(lines[lines.length - 1]!) as SmoothRun
}

function pct(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
}
function stats(vals: number[]): { n: number; p50: number; p95: number; max: number } {
  const s = [...vals].sort((a, b) => a - b)
  return { n: s.length, p50: pct(s, 0.5), p95: pct(s, 0.95), max: s[s.length - 1]! }
}

// ── 1. cold boots: first paint + editable, COLD_REPS real process launches ──
console.log(`[native-core bench] ${COLD_REPS} cold boots …`)
const paints: number[] = []
const altScreens: number[] = []
const bigFrames: number[] = []
const readies: number[] = []
for (let i = 0; i < COLD_REPS; i++) {
  const r = runSmooth(['--trials', '0', '--idle-seconds', '0'])
  if (r.first_paint_ms != null) paints.push(r.first_paint_ms)
  if (r.alt_screen_ms != null) altScreens.push(r.alt_screen_ms)
  if (r.big_frame_ms != null) bigFrames.push(r.big_frame_ms)
  if (r.ready_ms != null) readies.push(r.ready_ms)
  process.stdout.write(`  boot ${i + 1}/${COLD_REPS}: paint=${r.first_paint_ms}ms alt=${r.alt_screen_ms ?? '-'}ms frame=${r.big_frame_ms ?? '-'}ms ready=${r.ready_ms}ms\n`)
}

// ── 2. idle echo: ECHO_RUNS process reps × ECHO_TRIALS keystrokes ──
console.log(`[native-core bench] ${ECHO_RUNS}×${ECHO_TRIALS} echo trials …`)
const echoAll: number[] = []
const idleWrites: number[] = []
const idleBytes: number[] = []
const rss: number[] = []
const cpu: number[] = []
let clears = 0
for (let i = 0; i < ECHO_RUNS; i++) {
  const r = runSmooth(['--trials', String(ECHO_TRIALS), '--idle-seconds', '12'])
  echoAll.push(...(r.echo_all_ms ?? []))
  if (r.idle_writes_s != null) idleWrites.push(r.idle_writes_s)
  if (r.idle_bytes_s != null) idleBytes.push(r.idle_bytes_s)
  if (r.rss_max_kb != null) rss.push(r.rss_max_kb)
  if (r.cpu_idle_avg_pct != null) cpu.push(r.cpu_idle_avg_pct)
  clears += r.clears_post_ready
}

// ── 3. streaming(+tool) echo: the sentinel bench, all scenes ──
console.log(SKIP_FLUX ? '[native-core bench] FLUX scenes skipped (NC_SKIP_FLUX=1)' : '[native-core bench] FLUX stream-fluidity scenes …')
let flux: unknown = null
if (SKIP_FLUX) {
  flux = { skipped: true }
} else try {
  const out = execFileSync(
    process.execPath.includes('bun') ? process.execPath : `${process.env.HOME}/.bun/bin/bun`,
    ['run', join(REPO, 'scripts', 'streaming', 'bench-stream-fluidity.ts')],
    { encoding: 'utf8', cwd: REPO, timeout: 600_000, maxBuffer: 64 * 1024 * 1024 },
  )
  // Keep the raw report — scene names/metrics are the bench's contract.
  flux = { raw: out.split('\n').filter(l => l.trim().length > 0) }
} catch (e) {
  flux = { error: String(e) }
}

const receipt = {
  label,
  recordedAt: new Date().toISOString(),
  sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim(),
  coldPaintMs: stats(paints),
  coldAltScreenMs: altScreens.length ? stats(altScreens) : null,
  coldBigFrameMs: bigFrames.length ? stats(bigFrames) : null,
  coldEditableMs: stats(readies),
  readyInstrument: HONEST_READY ? 'honest (raw-arm gated)' : 'default (1.5s pre-probe floor)',
  echoMs: stats(echoAll),
  idle: {
    writesPerSec: stats(idleWrites),
    bytesPerSec: stats(idleBytes),
    rssMaxKb: rss.length ? Math.max(...rss) : null,
    cpuIdleAvgPct: cpu.length ? Math.max(...cpu) : null,
    clearsPostReady: clears,
  },
  streamFluidity: flux,
}

mkdirSync(OUT_DIR, { recursive: true })
const outPath = join(OUT_DIR, `${label}.json`)
writeFileSync(outPath, JSON.stringify(receipt, null, 2))
console.log(`\n[native-core bench] wrote ${outPath}`)
console.log(JSON.stringify({
  coldPaintMs: receipt.coldPaintMs,
  coldAltScreenMs: receipt.coldAltScreenMs,
  coldBigFrameMs: receipt.coldBigFrameMs,
  coldEditableMs: receipt.coldEditableMs,
  echoMs: receipt.echoMs,
  idle: receipt.idle,
}, null, 2))
