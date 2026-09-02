// ============================================================================
//  render-idle-lane-stability — the idle Helm home must hold its geometry.
//
//  Locks the root-cause pair (task #63, idle-damage forensics):
//
//  1. MEASURE CONTAMINATION (the invariant
//     lives in Mercury Cell Layout, src/ink/layout/cellLayout.ts): measure
//     passes write geometry, so a layout-pass cache hit that skips a subtree
//     whose children hold measure-constraint geometry composes wrong-width
//     lanes — the 72↔120 center-box oscillation class. Guarded by the
//     measRecGen contamination stamp + the two-tier cache. INK_YOGA_TRACE
//     observes the invariant directly: a
//     layout-pass cache-hit restore whose child exceeds the restored box
//     logs one JSONL event.
//
//  2. IDLE COMMIT STORM (AnimatedCritterArt/BreathingDot): raw-clock-time
//     state committed ~21×/s while the rendered output (pupil glyph, breath
//     shade) changed far less often. useAnimationValue commits only on output
//     edges → ~7/s. The commit ceiling here catches a re-introduced storm.
//
//  PTY-booting proof (≈16s): joins the suite under UI_RENDER=1, like every
//  other render-*.ts. The INK_YOGA_TRACE hook itself is permanent and free
//  when the env is unset.
// ============================================================================
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { railPlan } from '../../src/utils/helmGeometry.js'
import { CONFIG_HOME, cleanupScenario, scenario } from './renderScenarios.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const VSHOT = new URL('./vshot.py', import.meta.url).pathname
const composed = '/tmp/lane-stability-composed.jsonl'
const yogaTrace = '/tmp/lane-stability-yoga.jsonl'
const commits = '/tmp/lane-stability-commits.jsonl'
for (const f of [composed, yogaTrace, commits]) {
  try { rmSync(f) } catch { /* fresh run */ }
}

const cfg = { ...scenario('resume-2turn', 120, 44), out: '/tmp/lane-stability-grid.json', total: 60, sends: [] }
const cfgPath = '/tmp/lane-stability-cfg.json'
writeFileSync(cfgPath, JSON.stringify(cfg))
const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
  encoding: 'utf-8',
  timeout: vshotBudgetMs(90000),
  env: {
    ...process.env,
    // Split-home guard: bun-side writers and the stamp-defaulted dist must
    // resolve ONE home even outside the gate unit's pin (pinned home).
    MERCURY_CONFIG_DIR: CONFIG_HOME,
    INK_COMPOSED_TEE: composed,
    INK_YOGA_TRACE: yogaTrace,
    INK_COMMIT_TEE: commits,
  },
})
cleanupScenario('resume-2turn')
if (res.status !== 0) {
  console.error(`✗ vshot failed: ${res.stderr?.slice(0, 300)}`)
  process.exit(1)
}

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) failures++
}

// 1. Yoga invariant: no performLayout cache-hit ever skipped a subtree whose
//    child out-measured the restored width.
const contamEvents = existsSync(yogaTrace)
  ? readFileSync(yogaTrace, 'utf8').trim().split('\n').filter(Boolean).length
  : 0
check(contamEvents === 0, `yoga skip-contamination events: ${contamEvents} (want 0)`)

// 2. No center-lane width oscillation in the layout-shift reasons.
const lines = readFileSync(composed, 'utf8').trim().split('\n').map(l => JSON.parse(l))
const shiftReasons = lines
  .filter(l => l.phase === 'full-damage')
  .flatMap(l => (l.reasons ?? [l.reason]).filter(Boolean) as string[])
const laneFlips = shiftReasons.filter(r => /moved:.*→24,0,1[01][0-9]x/.test(r))
check(laneFlips.length === 0, `center-lane ≥100-wide flips: ${laneFlips.length} (want 0)`)
if (laneFlips.length > 0) for (const r of laneFlips.slice(0, 4)) console.log(`    ${r}`)

const PLAN = railPlan(120)
// The probe measures the center BOX (cols − mounted rails), not the narrowed
// text override: old two-rail slot was 120−48=72; the plan's box is
// 120 − railW×rails (96 at the single-rail tier).
const SLOT = 120 - PLAN.railW * (PLAN.telemetry ? 2 : 1)
// 3. Per-commit slot geometry: the cockpit inner column never exceeds its slot.
// Slot derives from the CENTER-FIRST railPlan — never a frozen
// number; the invariant is 'the box never exceeds what the PLAN allots'.
const commitLines = readFileSync(commits, 'utf8').trim().split('\n').map(l => JSON.parse(l))
const badCommits = commitLines.filter(l =>
  (l.inner ?? []).some((r: string) => {
    const w = Number(/,(\d+)x\d+$/.exec(r)?.[1] ?? /^(\d+)x/.exec(r)?.[1] ?? 0)
    return w > SLOT
  }),
)
check(badCommits.length === 0, `commits with inner column wider than the ${SLOT} slot: ${badCommits.length} (want 0)`)

// 4. Idle commit ceiling: ~7/s healthy (breath bucket edges + blink lids +
//    1Hz freshness). 160 over the ~16s run = generous 2× headroom that still
//    fails the pre-fix ~21/s storm (~260+).
check(commitLines.length < 160, `commits over the run: ${commitLines.length} (ceiling 160; pre-fix storm was ~260)`)

console.log(failures === 0 ? '✅ idle lane stability GREEN' : `❌ idle lane stability RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
