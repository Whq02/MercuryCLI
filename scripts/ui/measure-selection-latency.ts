#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/measure-selection-latency.ts — SELECTION LATENCY on a long
//  session (a before/after instrument, not a gate leg).
//
//  The operator's complaint: a long session makes selection slow. This
//  measures it where it is felt — the shipped binary, a real PTY, resumed
//  onto the deterministic 1,011-line fixture (scripts/navigation/arena.ts) —
//  as keypress → first terminal write (p50/p95/max over pooled runs), the
//  number of app-side frames a single key costs (the INK_WRITE_TEE seam),
//  and the keys that painted nothing. Legs:
//    cursor   message-actions cursor over the transcript (shift+↑ enters;
//             ↑ ×10, ↓ ×5 spaced; esc) — the transcript selection
//    manager  /sessions over the 1k with twelve staged sessions (↓ ×8; esc)
//    picker   /model (↓ ×6; esc)
//  The cursor leg also runs the MERCURY_CONNECTOR_TRACE seam and reports
//  the virtual list's renders: any stale or duplicate key across the walk
//  is a red line in the receipt, whatever the latency says.
//
//  Run: bun scripts/ui/measure-selection-latency.ts [--legs cursor,manager,picker]
//         [--runs 3] [--json out.json]
//  Re-runnable by design: the same command before and after a change.
// ============================================================================
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runCompassArena, requireDist, pct, firstOutAfter, type CompassRun } from '../navigation/arena.ts'
import { buildCompass1k } from '../navigation/fixture1k.ts'

requireDist()

// The arena execs `node` from a curated PATH built off NODE_BIN (else `which
// node` from bun's frozen PATH snapshot). A silent '' there execs nothing and
// every run ends in a heartbeat with zero samples — resolve it here, loudly.
if (!process.env.NODE_BIN) {
  const bunWhich = (globalThis as { Bun?: { which?: (bin: string) => string | null } }).Bun?.which?.('node') ?? null
  const shellWhich = spawnSync('which', ['node'], { encoding: 'utf8', env: process.env }).stdout?.trim() || null
  const candidates = [bunWhich, shellWhich, '/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'].filter((c): c is string => !!c)
  const found = candidates.find(c => existsSync(c))
  if (!found) {
    console.error('selection-latency: no `node` found (NODE_BIN unset, none on PATH, none at the usual homes) — set NODE_BIN=<path>')
    process.exit(2)
  }
  process.env.NODE_BIN = found
}
process.stderr.write(`[selection-latency] node: ${process.env.NODE_BIN} (${dirname(process.env.NODE_BIN)})\n`)

const SETTLE = 9000 // ms after spawn before the first interaction (the 1k resume load)
const GAP = 350 // ms between selection keys — each key an isolated experiment

const b64 = (s: string): string => Buffer.from(s, 'latin1').toString('base64')
const UP = '\\x1b[A'
const DOWN = '\\x1b[B'
const SHIFT_UP = '\\x1b[1;2A'
const ESC = '\\x1b'
const ENTER = '\\r'
const B64_UP = b64('\x1b[A')
const B64_DOWN = b64('\x1b[B')
const B64_SHIFT_UP = b64('\x1b[1;2A')

function typeSends(startMs: number, text: string, gapMs: number): string[] {
  return [...text].map((ch, i) => `${startMs + i * gapMs}:${ch}`)
}

type Summary = { n: number; p50: number; p95: number; max: number }
function summarize(xs: number[]): Summary {
  return { n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), max: xs.length ? Math.max(...xs) : -1 }
}

/** Per matching send: keypress → first PTY output, bounded by the next send;
 *  and the app-side frames written inside that window. */
function keyStats(run: CompassRun, match: (b64: string) => boolean, ceilingMs = 1000): { lat: number[]; frames: number[]; noPaint: number } {
  const lat: number[] = []
  const frames: number[] = []
  let noPaint = 0
  for (let i = 0; i < run.sends.length; i++) {
    const s = run.sends[i]!
    if (!match(s.b64)) continue
    const ceiling = Math.min(run.sends[i + 1]?.sent ?? Infinity, s.sent + ceilingMs)
    const o = firstOutAfter(run, s.sent, ceiling)
    if (o) lat.push(o.ts - s.sent)
    else noPaint++
    frames.push(run.teeLines.filter(t => t.ts > s.sent && t.ts <= ceiling).length)
  }
  return { lat, frames, noPaint }
}

/** A run that painted nothing or fired no send is the silent-zero class:
 *  say what the driver and the child said, then refuse. */
let silentRuns = 0
function diagnoseRun(label: string, run: CompassRun): void {
  if (run.outs.length > 0 && run.sends.length > 0) return
  silentRuns++
  console.error(`[selection-latency] ${label}: ${run.outs.length} output chunks · ${run.sends.length} sends fired — the child produced no journey`)
  const driver = run.driverOut.trim()
  if (driver) console.error(`  driver: ${driver.slice(-600).replace(/\n/g, '\n          ')}`)
  // The child's own words, from the drive log (the arena keeps byte counts
  // only): decode the first chunks so a refusal or a stack trace is read.
  if (existsSync(run.paths.drive)) {
    const said: string[] = []
    for (const line of readFileSync(run.paths.drive, 'utf8').split('\n')) {
      if (said.join('').length > 1500) break
      try {
        const r = JSON.parse(line) as { b64?: string; ts?: number }
        if (typeof r.ts === 'number' && typeof r.b64 === 'string') said.push(Buffer.from(r.b64, 'base64').toString('utf8'))
      } catch {
        /* skip */
      }
    }
    const text = said.join('').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').trim()
    if (text) console.error(`  child: ${text.slice(0, 1500).replace(/\n/g, '\n         ')}`)
    else console.error('  child: (no output at all — the exec itself failed, or the process died before its first write)')
  }
}

type ListRender = { ev?: string; range: [number, number]; messages: number; keys: number; stale: number; dupKeys: string[] }
function readTrace(path: string): ListRender[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => {
      try {
        return JSON.parse(l) as ListRender
      } catch {
        return null
      }
    })
    .filter((r): r is ListRender => r !== null && r.ev === 'list-render')
}

async function legCursor(runs: number): Promise<Record<string, unknown>> {
  const sends: string[] = [`${SETTLE}:${SHIFT_UP}`]
  let t = SETTLE + 700
  for (let k = 0; k < 10; k++, t += GAP) sends.push(`${t}:${UP}`)
  for (let k = 0; k < 5; k++, t += GAP) sends.push(`${t}:${DOWN}`)
  sends.push(`${t + 200}:${ESC}`)
  const up: number[] = []
  const down: number[] = []
  const frames: number[] = []
  let enter: number[] = []
  let noPaint = 0
  let renders = 0
  let stale = 0
  let dup = 0
  let offHead = 0
  for (let r = 0; r < runs; r++) {
    const scratch = mkdtempSync(join(tmpdir(), 'selection-trace-'))
    const trace = join(scratch, 'connector-trace.jsonl')
    const run = await runCompassArena({ sends, seconds: Math.ceil((t + 2500) / 1000), extraEnv: { MERCURY_CONNECTOR_TRACE: trace } })
    try {
      diagnoseRun(`cursor run ${r + 1}`, run)
      const e = keyStats(run, s => s === B64_SHIFT_UP, 1500)
      const u = keyStats(run, s => s === B64_UP)
      const d = keyStats(run, s => s === B64_DOWN)
      enter = enter.concat(e.lat)
      up.push(...u.lat)
      down.push(...d.lat)
      frames.push(...u.frames, ...d.frames)
      noPaint += u.noPaint + d.noPaint
      const list = readTrace(trace)
      renders += list.length
      stale += list.filter(x => x.stale > 0).length
      dup += list.filter(x => x.dupKeys.length > 0).length
      offHead += list.filter(x => x.range[0] > 0 && x.range[1] < x.messages).length
    } finally {
      run.cleanup()
      rmSync(scratch, { recursive: true, force: true })
    }
  }
  return {
    runs,
    surface: 'message-actions cursor over the 1k resumed transcript',
    enter: summarize(enter),
    up: summarize(up),
    down: summarize(down),
    pooled: summarize([...up, ...down]),
    framesPerKey: summarize(frames),
    noPaintKeys: noPaint,
    trace: { listRenders: renders, staleRenders: stale, duplicateKeyRenders: dup, windowOffBothEnds: offHead },
  }
}

/** Twelve short sessions beside the fixture: the switcher's list to walk.
 *  Each rides the fixture's proven record shapes under its own ids. */
function extraSessions(cwd: string): Array<{ sid: string; lines: Record<string, unknown>[] }> {
  const head = buildCompass1k(cwd).lines.slice(0, 30)
  const out: Array<{ sid: string; lines: Record<string, unknown>[] }> = []
  for (let k = 1; k <= 12; k++) {
    const tag = k.toString(16).padStart(3, '0')
    const sid = `00000000-c0c0-4000-8${tag}-00000000${tag}0`
    const re = (v: unknown): unknown => (typeof v === 'string' ? v.replace('-8000-', `-8${tag}-`) : v)
    const lines = head.map((l, i) => ({
      ...l,
      sessionId: sid,
      uuid: re(l.uuid),
      parentUuid: i === 0 ? null : re(l.parentUuid),
      timestamp: new Date(Date.parse(String(l.timestamp)) - k * 3_600_000).toISOString(),
    }))
    out.push({ sid, lines })
  }
  return out
}

async function legManager(runs: number): Promise<Record<string, unknown>> {
  const sends: string[] = [...typeSends(SETTLE, '/sessions', 40), `${SETTLE + 600}:${ENTER}`]
  let t = SETTLE + 2200
  for (let k = 0; k < 8; k++, t += GAP) sends.push(`${t}:${DOWN}`)
  sends.push(`${t + 200}:${ESC}`)
  const down: number[] = []
  const frames: number[] = []
  let noPaint = 0
  for (let r = 0; r < runs; r++) {
    const run = await runCompassArena({ sends, seconds: Math.ceil((t + 2500) / 1000), extraSessions })
    try {
      diagnoseRun(`manager run ${r + 1}`, run)
      const d = keyStats(run, s => s === B64_DOWN)
      down.push(...d.lat)
      frames.push(...d.frames)
      noPaint += d.noPaint
    } finally {
      run.cleanup()
    }
  }
  return { runs, surface: '/sessions card selection over the 1k transcript (12 staged sessions)', down: summarize(down), framesPerKey: summarize(frames), noPaintKeys: noPaint }
}

async function legPicker(runs: number): Promise<Record<string, unknown>> {
  const sends: string[] = [...typeSends(SETTLE, '/model', 40), `${SETTLE + 500}:${ENTER}`]
  let t = SETTLE + 2000
  for (let k = 0; k < 6; k++, t += GAP) sends.push(`${t}:${DOWN}`)
  sends.push(`${t + 200}:${ESC}`)
  const down: number[] = []
  const frames: number[] = []
  let noPaint = 0
  for (let r = 0; r < runs; r++) {
    const run = await runCompassArena({ sends, seconds: Math.ceil((t + 2500) / 1000) })
    try {
      diagnoseRun(`picker run ${r + 1}`, run)
      const d = keyStats(run, s => s === B64_DOWN)
      down.push(...d.lat)
      frames.push(...d.frames)
      noPaint += d.noPaint
    } finally {
      run.cleanup()
    }
  }
  return { runs, surface: '/model picker row selection over the 1k transcript', down: summarize(down), framesPerKey: summarize(frames), noPaintKeys: noPaint }
}

const ALL_LEGS = ['cursor', 'manager', 'picker'] as const
type Leg = (typeof ALL_LEGS)[number]

const args = process.argv.slice(2)
const legsArg = args.includes('--legs') ? args[args.indexOf('--legs') + 1]! : ALL_LEGS.join(',')
const runs = args.includes('--runs') ? Number(args[args.indexOf('--runs') + 1]) : 3
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1]! : null
const legs = legsArg.split(',').map(s => s.trim()) as Leg[]
for (const l of legs) {
  if (!ALL_LEGS.includes(l)) {
    console.error(`unknown leg: ${l} (valid: ${ALL_LEGS.join(', ')})`)
    process.exit(2)
  }
}

const results: Record<string, unknown> = { fixture: '1k resumed transcript (scripts/navigation/fixture1k.ts)', cols: 120, rows: 40, settleMs: SETTLE, keyGapMs: GAP, runs }
for (const leg of legs) {
  process.stderr.write(`[selection-latency] leg ${leg}…\n`)
  const t0 = Date.now()
  try {
    results[leg] = leg === 'cursor' ? await legCursor(runs) : leg === 'manager' ? await legManager(runs) : await legPicker(runs)
  } catch (e) {
    results[leg] = { failed: String(e) }
  }
  process.stderr.write(`[selection-latency] leg ${leg} done in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`)
}
// Zero samples is a refusal, never a receipt: every leg must have measured.
const empty = legs.filter(leg => {
  const r = results[leg] as Record<string, { n?: number } | unknown> | undefined
  if (!r || 'failed' in r) return true
  const pooled = (r.pooled ?? r.down) as { n?: number } | undefined
  return (pooled?.n ?? 0) === 0
})
results.verdict = empty.length === 0 ? 'measured' : `NO SAMPLES on ${empty.join(', ')} (${silentRuns} silent run(s) — see stderr)`
const payload = JSON.stringify(results, null, 2)
console.log(payload)
if (jsonOut) writeFileSync(jsonOut, payload + '\n')
if (empty.length > 0) {
  console.error(`[selection-latency] REFUSED: no samples on ${empty.join(', ')} — a silent zero is not a measurement`)
  process.exit(1)
}
