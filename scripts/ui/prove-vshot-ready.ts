#!/usr/bin/env bun
// ============================================================================
//  prove-vshot-ready.ts — the vshot observed-ready early exit is itself gated
// Laws, against a synthetic slow-booting TUI:
//    1. READY     — readyText on screen ⇒ the capture ends ~settle ticks
//                   later, far under the fixed budget; the grid holds the text.
//    2. DEADLINE  — readyText that never appears ⇒ the FULL fixed budget runs
//                   (total stays the hard deadline; never a truncated capture)
//                   and the capture REFUSES (non-zero exit + a receipt of
//                   readyAt/endReason). Burning the budget is not settling:
//                   returning the last frame silently is the wrong-frame class.
//    3. SENDS     — early exit is FORBIDDEN before every scheduled send has
//                   dispatched (send schedules are part of the scene).
//    4. ABSENT    — no readyText ⇒ byte-identical fixed-duration behavior.
// ============================================================================
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const VSHOT = join(ROOT, 'scripts', 'ui', 'vshot.py')
const work = mkdtempSync(join(tmpdir(), 'vshot-ready-'))
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

const CHILD = [
  'python3',
  '-u',
  '-c',
  'import time;print("BOOT");time.sleep(1.0);print("READY-SENTINEL");time.sleep(60)',
]

interface Cap {
  seconds: number
  gridText: string
  status: number | null
  stderr: string
  payload: {
    sendReceipts?: Array<{ atTick: number }>
    readyAt?: number | null
    endedAtTick?: number
    endReason?: string
    readyTextDeclared?: string[]
  }
}
function capture(cfg: Record<string, unknown>, scale = '1'): Cap {
  const cfgPath = join(work, `cfg-${Math.random().toString(36).slice(2)}.json`)
  const outPath = cfgPath.replace('.json', '-out.json')
  writeFileSync(cfgPath, JSON.stringify({ cols: 60, rows: 8, argv: CHILD, out: outPath, ...cfg }))
  const t0 = Date.now()
  // The mechanics laws below are AUTHORED-SCALE laws, so each capture pins
  // its own scale explicitly (default 1) — an ambient hosted profile (the
  // gate exports MERCURY_VSHOT_BUDGET_SCALE=3) must not stretch the very
  // timeline these checks measure. §11 pins the hosted profile on purpose.
  const r = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
    encoding: 'utf8',
    timeout: vshotBudgetMs(60_000),
    env: { ...process.env, MERCURY_VSHOT_BUDGET_SCALE: scale },
  })
  const seconds = (Date.now() - t0) / 1000
  const payload = JSON.parse(readFileSync(outPath, 'utf8'))
  return { seconds, gridText: r.stdout ?? '', status: r.status, stderr: r.stderr ?? '', payload }
}

console.log('════ vshot observed-ready laws ════')
{
  const c = capture({ total: 50, readyText: 'READY-SENTINEL' })
  check(
    `1. READY: exits early (${c.seconds.toFixed(1)}s ≪ the 10s budget) with the text on the grid`,
    c.seconds < 6 && c.gridText.includes('READY-SENTINEL'),
    `${c.seconds}s`,
  )
  // The green control for law 2b/2c: a real settle carries a real receipt, so
  // the refusal above cannot be satisfied by a capture that never runs.
  check(
    '1b. READY receipt: readyAt recorded, endReason ready, exit 0',
    c.status === 0 && typeof c.payload.readyAt === 'number' && c.payload.endReason === 'ready',
    JSON.stringify({ status: c.status, readyAt: c.payload.readyAt, endReason: c.payload.endReason }),
  )
}
{
  const c = capture({ total: 8, readyText: 'NEVER-THERE' })
  check(
    `2. DEADLINE: never-ready runs the FULL fixed budget (${c.seconds.toFixed(1)}s ≥ 1.6s)`,
    c.seconds >= 1.6,
    `${c.seconds}s`,
  )
  // running the full budget is not the same as SETTLING. A declared
  // readyText that never appears must REFUSE rather than hand back whatever
  // happened to be on screen — the wrong-frame class that let a gate
  // scheduling stall read as a product regression in prove-party-board.
  check(
    '2b. NEVER-READY refuses: non-zero exit carrying the diagnostic',
    c.status !== 0 && /NEVER-READY/.test(c.stderr),
    `status=${c.status} stderr=${JSON.stringify(c.stderr.slice(0, 140))}`,
  )
  check(
    '2c. NEVER-READY receipt: readyAt null, endReason budget',
    c.payload.readyAt === null && c.payload.endReason === 'budget',
    JSON.stringify({ readyAt: c.payload.readyAt, endReason: c.payload.endReason }),
  )
}
{
  const c = capture({ total: 50, readyText: 'READY-SENTINEL', sends: [{ atTick: 12, data: 'x' }] })
  const receipts = c.payload.sendReceipts ?? []
  check(
    `3. SENDS: no exit before the tick-12 send dispatched (${c.seconds.toFixed(1)}s ≥ 2.4s, receipt present)`,
    c.seconds >= 2.4 && c.seconds < 9 && receipts.length === 1,
    `${c.seconds}s receipts=${JSON.stringify(receipts)}`,
  )
}
{
  const c = capture({ total: 10 })
  check(
    `4. ABSENT: no readyText ⇒ fixed duration (${c.seconds.toFixed(1)}s ≥ 2.0s)`,
    c.seconds >= 2.0,
    `${c.seconds}s`,
  )
}
{
  // awaitText send gating: the send's deadline is tick 40 (8s) but the child
  // shows READY-SENTINEL at ~1s — the gated send must fire EARLY, and with
  // readyText the whole capture ends far under budget.
  const c = capture({
    total: 60,
    readyText: 'READY-SENTINEL',
    sends: [{ atTick: 40, awaitText: 'READY-SENTINEL', data: 'x' }],
  })
  const receipts = c.payload.sendReceipts ?? []
  check(
    `5. AWAIT-SEND: gated send fired early (receipt tick ${receipts[0]?.atTick} < 20) and capture ended ${c.seconds.toFixed(1)}s ≪ 12s`,
    receipts.length === 1 && (receipts[0]?.atTick ?? 99) < 20 && c.seconds < 7,
    `${c.seconds}s receipts=${JSON.stringify(receipts)}`,
  )
}
{
  // awaitText that never appears: the atTick deadline fires the send — the
  // never-ready worst case is exactly the old fixed schedule.
  const c = capture({
    total: 14,
    sends: [{ atTick: 9, awaitText: 'NEVER-THERE', data: 'x' }],
  })
  const receipts = c.payload.sendReceipts ?? []
  check(
    `6. AWAIT-DEADLINE: unseen awaitText degrades to the atTick schedule (receipt tick ${receipts[0]?.atTick} ≥ 9)`,
    receipts.length === 1 && (receipts[0]?.atTick ?? 0) >= 9,
    JSON.stringify(receipts),
  )
}

{
  // stableTicks ALONE is deliberately hazardous on slow scenes: any loading
  // pause ≥ stableTicks×0.2s reads as settled and snaps the pre-loaded frame
  // (here: BOOT paints, the child pauses 1s, the capture exits BEFORE the
  // sentinel). This law PINS the hazard — it is WHY every real annotation
  // composes readyText (the scene's needle) with stableTicks (law 9).
  const c = capture({ total: 50, stableTicks: 4 })
  check(
    `7. STABLE-ALONE HAZARD: a mid-load pause reads as settled (exited ${c.seconds.toFixed(1)}s, pre-sentinel) — needles are mandatory in annotations`,
    c.seconds < 6 && !c.gridText.includes('READY-SENTINEL'),
    `${c.seconds}s`,
  )
}
{
  // an ANIMATED scene never stabilizes — the full budget runs (inherently
  // time-as-contract safe).
  const anim = [
    'python3',
    '-u',
    '-c',
    'import time\nwhile True: print("tick", time.time()); time.sleep(0.1)',
  ]
  const c = capture({ total: 12, stableTicks: 4, argv: anim })
  check(
    `8. ANIMATED: never-stable runs the FULL budget (${c.seconds.toFixed(1)}s ≥ 2.4s)`,
    c.seconds >= 2.4,
    `${c.seconds}s`,
  )
}
{
  // readyText AND stableTicks compose: stability alone is not enough until
  // the needle is on screen.
  const c = capture({ total: 50, stableTicks: 3, readyText: 'READY-SENTINEL' })
  check(
    `9. COMPOSED: ready+stable exits early with the needle present (${c.seconds.toFixed(1)}s ≪ 10s)`,
    c.seconds < 6 && c.gridText.includes('READY-SENTINEL'),
    `${c.seconds}s`,
  )
}

{
  // afterPrevTicks: relative scheduling — send 1 fires early on its
  // awaitText; send 2 fires N ticks after send 1's ACTUAL fire tick, so the
  // intended gap survives the compression.
  const c = capture({
    total: 60,
    readyText: 'READY-SENTINEL',
    sends: [
      { atTick: 40, awaitText: 'BOOT', data: 'a' },
      { afterPrevTicks: 3, data: 'b' },
    ],
  })
  const r = c.payload.sendReceipts ?? []
  const gap = (r[1]?.atTick ?? 0) - (r[0]?.atTick ?? 0)
  check(
    `10. RELATIVE: send 2 fired ${gap} ticks after send 1 (want ≈3), whole capture ${c.seconds.toFixed(1)}s ≪ 12s`,
    r.length === 2 && gap >= 3 && gap <= 5 && c.seconds < 8,
    `receipts=${JSON.stringify(r)} ${c.seconds}s`,
  )
}

{
  // §11 THE HOSTED PROFILE (MERCURY_VSHOT_BUDGET_SCALE) — the movie law:
  // the scale stretches the deadline AND the send schedule as one timeline
  // (gate run 2: deadline-only stretching fired blind sends into boots 3×
  // behind them), with the pure fixed-window carve-out (no sends, no
  // resizes, no readyText, no stableTicks ⇒ the authored window IS the
  // contract and stays byte-identical).
  const movie = capture(
    {
      total: 60,
      readyText: 'READY-SENTINEL',
      sends: [
        { atTick: 4, data: 'a' },
        { afterPrevTicks: 2, data: 'b' },
      ],
    },
    '3',
  )
  const r = movie.payload.sendReceipts ?? []
  const gap = (r[1]?.atTick ?? 0) - (r[0]?.atTick ?? 0)
  check(
    `11a. MOVIE: at scale 3 the blind tick-4 send fires at ~tick 12 (${r[0]?.atTick}) and the relative gap triples (${gap} ≈ 6)`,
    r.length === 2 && (r[0]?.atTick ?? 0) >= 12 && (r[0]?.atTick ?? 99) <= 16 && gap >= 6 && gap <= 8,
    `receipts=${JSON.stringify(r)}`,
  )
  check(
    `11b. MOVIE: observed-ready still ends the scaled scene early (${movie.seconds.toFixed(1)}s ≪ the 36s scaled budget)`,
    movie.status === 0 && movie.seconds < 12,
    `${movie.seconds}s status=${movie.status}`,
  )
  const fixed = capture({ total: 10 }, '3')
  check(
    `11c. CARVE-OUT: a pure fixed-window capture stays AUTHORED at scale 3 (${fixed.seconds.toFixed(1)}s ≈ 2s, not 6s)`,
    fixed.seconds >= 2.0 && fixed.seconds < 4.5,
    `${fixed.seconds}s`,
  )
  const stretched = capture({ total: 8, readyText: 'NEVER-THERE' }, '3')
  check(
    `11d. DEADLINE SCALES: a declared-ready scene's never-ready budget runs scaled (${stretched.seconds.toFixed(1)}s ≥ 4.0s, ended budget)`,
    stretched.seconds >= 4.0 && stretched.payload.endReason === 'budget' && stretched.status !== 0,
    `${stretched.seconds}s ${stretched.payload.endReason}`,
  )
}

rmSync(work, { recursive: true, force: true })
if (failures === 0) {
  console.log(' ✅ VSHOT OBSERVED-READY GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} VSHOT-READY FAILURE(S)`)
process.exit(1)
