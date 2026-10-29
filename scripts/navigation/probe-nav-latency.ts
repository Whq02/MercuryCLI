#!/usr/bin/env bun
import { runCompassArena, requireDist } from './arena.js'

requireDist()

const KEYS = 8
const GAP = 400
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
