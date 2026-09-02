#!/usr/bin/env bun
// ============================================================================
//  scripts/pulse/matrix/prove-wait-neutrality.ts — a normal pre-first-chunk
//  provider wait NEVER wears failure paint.
//
//  STATUS: Slice-3 ACCEPTANCE — runs against current HEAD with no integrator
//  seams (raw PTY bytes only). Against the pre-Slice-3 stall machinery this
//  file is expected RED: useStalledAnimation reddens after 3s without tokens
//  INCLUDING the normal provider wait, and by ~7s the interpolation converges
//  on the exact CRIMSON escape. Green = the Slice-3 rework landed.
//
//  Method: two hermetic scenes hold the provider's first bytes for 8s
//  (before headers / headers→first chunk — long enough that the legacy fade
//  reaches the EXACT failure color). During the wait window (Enter+1s →
//  first visible response sentinel) no terminal write may carry a truecolor
//  foreground equal to CRIMSON (src/components/mercuryPalette.ts — parsed from
//  source, never hardcoded) or within distance 35 of it (the deep tail of
//  the interpolation; the brand TERRA sits at distance ~44, safely outside).
//  The frame must also stay ALIVE (writes keep flowing — calm ≠ frozen).
//
//  Run:  ~/.bun/bin/bun run scripts/pulse/matrix/prove-wait-neutrality.ts
// ============================================================================

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, section, finish, armWatchdog } from '../lib/proveKit.ts'
import { runPulseArena, visibleText, type PulseRun } from '../lib/pulseArena.ts'
import { T1 } from './scenes.ts'

armWatchdog('PULSE wait neutrality', 240_000)

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

// The failure color, from source — a re-tint must retune this prover's target.
const themeSrc = readFileSync(join(ROOT, 'src', 'components', 'mercuryPalette.ts'), 'utf8')
const crimsonHex = /export const CRIMSON = '#([0-9A-Fa-f]{6})'/.exec(themeSrc)?.[1]
if (!crimsonHex) {
  console.log('❌ cannot parse CRIMSON from src/components/mercuryPalette.ts — retune the prover')
  process.exit(1)
}
const CRIMSON = {
  r: parseInt(crimsonHex.slice(0, 2), 16),
  g: parseInt(crimsonHex.slice(2, 4), 16),
  b: parseInt(crimsonHex.slice(4, 6), 16),
}

const FG_TRUECOLOR = /\x1b\[(?:[0-9;]*;)?38;2;(\d{1,3});(\d{1,3});(\d{1,3})/g

interface Offender {
  atMs: number
  rgb: string
  dist: number
}

/** Truecolor foregrounds within `radius` of CRIMSON across a window. */
function crimsonFamily(run: PulseRun, fromTs: number, toTs: number, radius: number): Offender[] {
  const out: Offender[] = []
  for (const t of run.teeLines) {
    if (t.ts < fromTs || t.ts > toTs || !t.content) continue
    for (const m of t.content.matchAll(FG_TRUECOLOR)) {
      const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])]
      const dist = Math.hypot(r - CRIMSON.r, g - CRIMSON.g, b - CRIMSON.b)
      if (dist <= radius) out.push({ atMs: t.ts - fromTs, rgb: `${r},${g},${b}`, dist: Math.round(dist) })
    }
  }
  return out
}

// Detector liveness — a scanner that can't see escapes would pass vacuously
// (the green-proof-enforcing-a-bug class). Prove it flags a synthetic
// CRIMSON write and that real windows contain parseable truecolor fgs.
section('detector self-test (no vacuous green)')
{
  const synthetic = {
    teeLines: [
      { ts: 1000, content: `\x1b[38;2;${CRIMSON.r};${CRIMSON.g};${CRIMSON.b}m✗\x1b[39m` },
      { ts: 1001, content: '\x1b[1;38;2;10;20;30mok\x1b[39m' },
    ],
  } as unknown as PulseRun
  check('the scanner flags an exact CRIMSON escape', crimsonFamily(synthetic, 0, 2000, 0.5).length === 1)
  check('…and a near-CRIMSON one', crimsonFamily(synthetic, 0, 2000, 35).length === 1)
  check('…and ignores unrelated colors', crimsonFamily(synthetic, 0, 2000, 35).every(o => o.rgb !== '10,20,30'))
}

async function waitScene(kind: 'header' | 'chunk'): Promise<PulseRun> {
  return runPulseArena({
    turns: [
      {
        kind: 'stream',
        blocks: [{ type: 'text', deltas: [`${T1} `, 'patience ', 'rewarded.'] }],
        gapMs: 40,
        ...(kind === 'header' ? { headerDelayMs: 8000 } : { firstChunkDelayMs: 8000 }),
      },
    ],
    sends: ['5000:hello', '5600:\\r'],
    seconds: 22,
  })
}

for (const kind of ['header', 'chunk'] as const) {
  section(
    kind === 'header'
      ? 'scene 7-long — 8s provider wait before headers stays neutral'
      : 'scene 8-long — 8s headers→first-chunk wait stays neutral',
  )
  const run = await waitScene(kind)
  const enter = run.sendLog.find(s => Buffer.from(s.b64, 'base64').toString('utf8') === '\r')
  check('the Enter press was delivered', !!enter)
  if (!enter) {
    run.cleanup()
    continue
  }
  const sentinelWrite = run.teeLines.find(
    t => t.ts > enter.sent && t.content !== undefined && visibleText(t.content).includes('⟦P1⟧'),
  )
  check('the response eventually paints (the wait ends honestly)', !!sentinelWrite)
  const windowStart = enter.sent + 1000
  const windowEnd = (sentinelWrite?.ts ?? enter.sent + 9000) - 50
  const writesInWindow = run.teeLines.filter(t => t.ts >= windowStart && t.ts <= windowEnd)
  check(
    'the frame stays ALIVE during the wait (calm ≠ frozen)',
    writesInWindow.length >= 8,
    `${writesInWindow.length} writes in ${Math.round(windowEnd - windowStart)}ms`,
  )
  const parsedFgs = writesInWindow.reduce(
    (n, t) => n + [...(t.content ?? '').matchAll(FG_TRUECOLOR)].length,
    0,
  )
  check(
    'the window carries parseable truecolor paint (detector not blind)',
    parsedFgs > 0,
    String(parsedFgs),
  )
  const exact = crimsonFamily(run, windowStart, windowEnd, 0.5)
  check(
    `no EXACT CRIMSON foreground during the wait (38;2;${CRIMSON.r};${CRIMSON.g};${CRIMSON.b})`,
    exact.length === 0,
    exact.slice(0, 3).map(o => `${o.rgb}@+${Math.round(o.atMs)}ms`).join(' '),
  )
  const near = crimsonFamily(run, windowStart, windowEnd, 35)
  check(
    'no near-CRIMSON family paint either (distance ≤ 35; TERRA sits at ~44)',
    near.length === 0,
    near.slice(0, 3).map(o => `${o.rgb} d=${o.dist}@+${Math.round(o.atMs)}ms`).join(' '),
  )
  run.cleanup()
}

finish('PULSE wait neutrality')
