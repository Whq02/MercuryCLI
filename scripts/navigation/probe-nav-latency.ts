#!/usr/bin/env bun
// ============================================================================
//  probe-nav-latency — Slice-6 diagnosis instrument (NOT a gate leg).
//
//  Question: why is keypress→selection-paint p50 ≈22ms on the suggestion list
//  when composer echo is ≈4ms? Hypothesis: a first ZERO-DELTA commit consumes
//  the scheduler's leading edge (zero-dirty ⇒ zero bytes ⇒ no visible chunk),
//  parking the visible selection frame on the +16ms trailing edge.
//
//  Method: boot the 1k fixture, open the slash list, send SPACED ↓ keys, and
//  for each key report EVERY app-side tee write in its window (offset + len)
//  — two writes (tiny-then-real) vs one late write discriminates.
//
//  Run: ~/.bun/bin/bun run scripts/navigation/probe-nav-latency.ts
// ============================================================================
import { runCompassArena, requireDist } from './arena.js'

requireDist()

const KEYS = 8
const GAP = 400 // well past any window — each key is an isolated experiment
const sends: string[] = ['9000:/']
for (let i = 0; i < KEYS; i++) sends.push(`${9800 + i * GAP}:\\x1b[B`)

const run = await runCompassArena({
  label: 'probe-nav',
  cols: 120,
  rows: 40,
  seconds: Math.ceil((9800 + KEYS * GAP + 2500) / 1000),
  sends,
} as Parameters<typeof runCompassArena>[0])

try {
  for (let i = 0; i < KEYS; i++) {
    const keyAt = run.sends[1 + i]?.sent
    if (keyAt === undefined) continue
    const windowEnd = keyAt + GAP - 50
    const writes = run.teeLines.filter(w => w.ts >= keyAt && w.ts < windowEnd)
    const outs = run.outs.filter(o => o.ts >= keyAt && o.ts < windowEnd)
    const w = writes.map(x => `+${(x.ts - keyAt).toFixed(1)}ms ${x.len ?? '?'}B`).join(' · ')
    const o = outs.map(x => `+${(x.ts - keyAt).toFixed(1)}ms ${x.bytes}B`).join(' · ')
    console.log(`↓ #${i + 1}: tee[${writes.length}] ${w || '(none)'}  |  pty[${outs.length}] ${o || '(none)'}`)
  }
} finally {
  run.cleanup()
}
