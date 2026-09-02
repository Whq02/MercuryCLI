#!/usr/bin/env bun
// ============================================================================
//  scripts/pulse/spinner/prove-stall-honesty.ts — the stall
//  machinery is phase-aware and NEVER paints failure on normal waits.
//
//  Drives the REAL pulse store (pinned clock) through the same per-frame
//  assessment the spinner hook runs (computeStallView + easeAttention):
//    · a provider that produces NO first chunk for >3s (and far beyond)
//      while the turn sits in accepted…waiting stays neutral — stillWaiting
//      false, zero attention intensity;
//    · thinking / tool-work / settling never stall at any gap;
//    · only a mid-RESPONDING gap ≥ MID_STREAM_STILL_WAITING_MS flags the
//      restrained treatment, and a stream event resets it;
//    · the legacy fallback (no pulse turn) obeys the same table, including
//      "responding before any token = a provider wait, not a stall";
//    · reduced motion is instant both ways; CRIMSON no longer flows from
//      this machinery at all (source pins).
//
//  Run: ~/.bun/bin/bun run scripts/pulse/spinner/prove-stall-honesty.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  beginPulseTurn,
  finishPhaseGeneration,
  getPulseActivity,
  getPulsePhase,
  notePulseStreamActivity,
  resetPulseForTests,
  setPulseClockForTests,
  setPulsePhase,
} from '../../../src/utils/pulse/index.js'
import {
  computeStallView,
  easeAttention,
  MID_STREAM_STILL_WAITING_MS,
  STILL_WAITING_MAX_INTENSITY,
} from '../../../src/components/Spinner/useStalledAnimation.js'
import type { SpinnerMode } from '../../../src/components/Spinner/types.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  if (!cond || process.env.PULSE_PROOF_VERBOSE) {
    console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

let t = 0
setPulseClockForTests(() => t)
resetPulseForTests()

/** The hook's per-frame view, fed from the live store exactly as the hook
 *  feeds it (pulse activity when a turn is open). */
function view(opts: { suppressed?: boolean; mode?: SpinnerMode; fallbackLastEventAt?: number | null } = {}) {
  const s = getPulsePhase()
  const pulseOpen = s.generation > 0 && s.phase !== 'idle'
  return computeStallView({
    pulseOpen,
    phase: s.phase,
    mode: opts.mode ?? 'responding',
    suppressed: opts.suppressed ?? false,
    lastEventAt: pulseOpen ? getPulseActivity().lastEventAt : (opts.fallbackLastEventAt ?? null),
    now: t,
  })
}

// ── pre-first-chunk waits stay neutral, no matter how long ─────────────────
{
  const g = beginPulseTurn()
  setPulsePhase(g, 'preparing', { reason: 'context' })
  t = 3_500 // past the OLD 3s red bar
  check('preparing at 3.5s: not stalled', view().stillWaiting === false)
  setPulsePhase(g, 'dispatching')
  setPulsePhase(g, 'waiting', { model: 'Fable 5', effort: 'high' })
  t = 30_000
  check('waiting (no first chunk) at 30s: not stalled', view().stillWaiting === false)
  check('waiting at 30s: zero attention target', view().targetIntensity === 0)
  t = 300_000
  check('waiting at 5min: STILL not stalled (never, pre-first-chunk)', view().stillWaiting === false)

  // ── thinking / tool-work / settling never stall ───────────────────────────
  setPulsePhase(g, 'thinking')
  notePulseStreamActivity(g, 'thinking')
  t += 60_000
  check('thinking with a 60s event gap: not stalled', view().stillWaiting === false)
  setPulsePhase(g, 'tool-work', { toolCount: 2 })
  t += 120_000
  check('tool-work with a 2min gap: not stalled', view().stillWaiting === false)

  // ── responding: the restrained mid-stream threshold, reset by events ─────
  setPulsePhase(g, 'responding')
  notePulseStreamActivity(g, 'text')
  const streamedAt = t
  t = streamedAt + MID_STREAM_STILL_WAITING_MS - 1
  check('responding gap just under the threshold: not stalled', view().stillWaiting === false)
  t = streamedAt + MID_STREAM_STILL_WAITING_MS
  check('responding gap at the threshold: still waiting flags', view().stillWaiting === true)
  check(
    'the flagged target is the RESTRAINED cap (attention, not alarm)',
    view().targetIntensity === STILL_WAITING_MAX_INTENSITY &&
      STILL_WAITING_MAX_INTENSITY <= 0.5,
  )
  check('…and stays suppressible (tools/idle leader)', view({ suppressed: true }).stillWaiting === false)
  notePulseStreamActivity(g, 'text')
  check('a fresh stream event RESETS the flag', view().stillWaiting === false)

  // settling never stalls
  t += 20_000
  setPulsePhase(g, 'settling')
  t += 20_000
  check('settling with an old event stamp: not stalled', view().stillWaiting === false)
  // Close the phase generation — resetPulseForTests wipes the TRACE store
  // only; the phase store idles through its own lifecycle.
  finishPhaseGeneration(g)
}

// ── the legacy fallback table (no pulse turn open) ──────────────────────────
{
  resetPulseForTests()
  t = 1_000_000
  check('fallback requesting at any age: not stalled', view({ mode: 'requesting', fallbackLastEventAt: null }).stillWaiting === false)
  check(
    'fallback responding BEFORE any token: a provider wait, not a stall',
    view({ mode: 'responding', fallbackLastEventAt: null }).stillWaiting === false,
  )
  check('fallback thinking: never', view({ mode: 'thinking', fallbackLastEventAt: t - 60_000 }).stillWaiting === false)
  check('fallback tool-use: never', view({ mode: 'tool-use', fallbackLastEventAt: t - 60_000 }).stillWaiting === false)
  check('fallback tool-input: never', view({ mode: 'tool-input', fallbackLastEventAt: t - 60_000 }).stillWaiting === false)
  check(
    'fallback responding with a real mid-stream gap: flags',
    view({ mode: 'responding', fallbackLastEventAt: t - MID_STREAM_STILL_WAITING_MS - 1 }).stillWaiting === true,
  )
  check(
    'fallback responding with recent tokens: calm',
    view({ mode: 'responding', fallbackLastEventAt: t - 2_000 }).stillWaiting === false,
  )
}

// ── easing: reduced motion instant, animated restrained ─────────────────────
{
  check('reduced motion: onset is instant', easeAttention(0, STILL_WAITING_MAX_INTENSITY, 0, true) === STILL_WAITING_MAX_INTENSITY)
  check('reduced motion: reset is instant', easeAttention(STILL_WAITING_MAX_INTENSITY, 0, 0, true) === 0)
  const oneStep = easeAttention(0, STILL_WAITING_MAX_INTENSITY, 50, false)
  check('animated onset eases (one 50ms step is partial)', oneStep > 0 && oneStep < STILL_WAITING_MAX_INTENSITY)
  let v = 0
  for (let i = 0; i < 100; i++) v = easeAttention(v, STILL_WAITING_MAX_INTENSITY, 50, false)
  check('animated ease converges to the cap and NEVER overshoots', v === STILL_WAITING_MAX_INTENSITY)
}

// ── CRIMSON no longer flows from the stall machinery (source pins) ──────────
{
  const stall = readFileSync(join(root, 'src/components/Spinner/useStalledAnimation.ts'), 'utf8')
  const glyph = readFileSync(join(root, 'src/components/Spinner/SpinnerGlyph.tsx'), 'utf8')
  const glimmer = readFileSync(join(root, 'src/components/Spinner/GlimmerMessage.tsx'), 'utf8')
  check('useStalledAnimation names the threshold constant', stall.includes('MID_STREAM_STILL_WAITING_MS = 10_000'))
  check('no CRIMSON import in the stall trio', !/import\s*\{[^}]*CRIMSON/.test(stall) && !/import\s*\{[^}]*CRIMSON/.test(glyph) && !/import\s*\{[^}]*CRIMSON/.test(glimmer))
  check('glyph attention target = the theme WARNING role (AMBER spine)', /parseRGB\(theme\.warning\)/.test(glyph))
  check('verb attention target = the theme WARNING role (AMBER spine)', /parseRGB\(theme\.warning\)/.test(glimmer))
  check('the old universal 3s red bar is gone', !/3000/.test(stall) && !/ERROR_RED/.test(glyph) && !/ERROR_RED/.test(glimmer))
  const hold = readFileSync(join(root, 'src/components/Spinner/StreamingHoldRow.tsx'), 'utf8')
  check(
    'the streaming hold carries the SAME phase-aware quiet suffix (prose-stall visibility)',
    hold.includes('MID_STREAM_STILL_WAITING_MS') && hold.includes('still waiting') && /snap\.phase === 'responding'/.test(hold),
  )
}

setPulseClockForTests(null)
resetPulseForTests()
if (failures > 0) {
  console.log(`\n❌ prove-stall-honesty: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ stall-honesty — phase-aware, restrained, never failure-red')
