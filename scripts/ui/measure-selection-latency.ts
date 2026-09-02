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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCompassArena, requireDist, pct, firstOutAfter, type CompassRun } from '../navigation/arena.ts'
import { buildCompass1k } from '../navigation/fixture1k.ts'

requireDist()

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
const payload = JSON.stringify(results, null, 2)
console.log(payload)
if (jsonOut) writeFileSync(jsonOut, payload + '\n')
