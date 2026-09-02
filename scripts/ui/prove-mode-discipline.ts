#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-mode-discipline.ts
//  PROOF: the terminal-mode
//  discipline that keeps Apple Terminal from sliding its window over the alt
//  screen — mouse tracking (?1000/1002/1003/1006) + alternate-scroll (?1007)
//  + alt screen (?1049) — is ARMED at boot and never left disarmed.
//    A. Behavioral (hermetic, real binary): boot the dist in a PTY with
//       VSHOT_TEE and assert each mode's FINAL state in the raw byte stream
//       is SET (last `?<m>h` after any `?<m>l`).
//    B. Source locks: both router ENGAGE paths (the flows both operator
//       breaks started from) idempotently re-assert; the stdin-resume and
//       sleep-wake re-asserts stay wired; the external-editor exit re-arms.
//  The engage flow's LIVE verification is the billed operator-flow E2E
//  (a gate proof must never spawn real daemons — hermeticity doctrine).
//  Run:  ~/.bun/bin/bun run scripts/ui/prove-mode-discipline.ts
// ============================================================================
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_HOME, scenario, cleanupScenario } from './renderScenarios.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

// ── A. behavioral: boot the real dist, tee the raw bytes ────────────────────
section('A. boot byte-stream — every viewport-lock mode ends ARMED')
const tee = join(tmpdir(), `mode-discipline-${process.pid}.bin`)
rmSync(tee, { force: true })
const cfg = { ...scenario('resume-2turn', 120, 44), out: join(tmpdir(), `mode-grid-${process.pid}.json`) }
const cfgPath = join(tmpdir(), `mode-cfg-${process.pid}.json`)
writeFileSync(cfgPath, JSON.stringify(cfg))
const res = spawnSync('/usr/bin/python3', [join(import.meta.dir, 'vshot.py'), cfgPath], {
  encoding: 'utf-8',
  timeout: vshotBudgetMs(60000),
  env: { ...process.env,
    // Split-home guard: bun-side writers and the stamp-defaulted dist must
    // resolve ONE home even outside the gate unit's pin (pinned home).
    MERCURY_CONFIG_DIR: CONFIG_HOME, VSHOT_TEE: tee },
})
cleanupScenario('resume-2turn')
check('pty boot captured', res.status === 0 && existsSync(tee), res.stderr?.slice(0, 200) ?? '')
if (res.status === 0 && existsSync(tee)) {
  const raw = readFileSync(tee, 'latin1')
  // Final-state oracle: the LAST set (h) of each mode must come after the
  // LAST reset (l). A mode never set at all is a fail — the lock was never
  // armed. 1003 is the hover segment (MOUSE_HOVER_OK) — armed on EVERY
  // platform since win32 reversal (operator directive; the
  // June audit-wave omission was an unmeasured cost guess).
  const modes: Array<[number, string]> = [
    [1049, 'alt screen'],
    [1000, 'mouse normal'],
    [1002, 'mouse button-motion'],
    [1003, 'mouse any-motion (all platforms)'],
    [1006, 'mouse SGR'],
    [1007, 'alternate scroll'],
  ]
  for (const [m, label] of modes) {
    const lastSet = raw.lastIndexOf(`[?${m}h`)
    const lastReset = raw.lastIndexOf(`[?${m}l`)
    check(`?${m} (${label}) ends ARMED`, lastSet >= 0 && lastSet > lastReset, `lastSet=${lastSet} lastReset=${lastReset}`)
  }
}
rmSync(tee, { force: true })
rmSync(cfgPath, { force: true })

// ── A2. behavioral: nested-pane close must NOT tear down the session ────────
section('A2. pane open→close — the alt screen + lock survive (reentrancy)')
// THE dominant break (fable scroll investigation): a detail pane mounts a
// NESTED <AlternateScreen>; its close would otherwise write the FULL
// teardown — one esc dropped the whole session to the main screen,
// disarmed. Drive the real binary: open a nested pane over the cockpit,
// esc it, idle — then run the same final-state oracle. Pre-fix this leg is
// RED (the last ?1049l lands after the last ?1049h); the depth-counter fix
// keeps every mode armed. The vehicle is /ledger (NavigablePanes — the
// original /party board retired with the seat estate; the reentrancy law
// outlives any one pane).
const tee2 = join(tmpdir(), `mode-pane-${process.pid}.bin`)
rmSync(tee2, { force: true })
const cfg2 = {
  ...scenario('resume-2turn', 120, 44),
  out: join(tmpdir(), `mode-pane-grid-${process.pid}.json`),
}
;(cfg2 as { sends: Array<{ atTick: number; data: string }> }).sends = [
  { atTick: 30, data: '/ledger' },
  { atTick: 36, data: '\r' },
  { atTick: 46, data: String.fromCharCode(27) }, // esc — close the pane
]
;(cfg2 as { total: number }).total = 60
const cfg2Path = join(tmpdir(), `mode-pane-cfg-${process.pid}.json`)
writeFileSync(cfg2Path, JSON.stringify(cfg2))
const res2 = spawnSync('/usr/bin/python3', [join(import.meta.dir, 'vshot.py'), cfg2Path], {
  encoding: 'utf-8',
  timeout: vshotBudgetMs(60000),
  env: { ...process.env,
    // Split-home guard: bun-side writers and the stamp-defaulted dist must
    // resolve ONE home even outside the gate unit's pin (pinned home).
    MERCURY_CONFIG_DIR: CONFIG_HOME, VSHOT_TEE: tee2 },
})
cleanupScenario('resume-2turn')
check('pane-cycle pty captured', res2.status === 0 && existsSync(tee2), res2.stderr?.slice(0, 200) ?? '')
if (res2.status === 0 && existsSync(tee2)) {
  const raw2 = readFileSync(tee2, 'latin1')
  // POSITIVE pane-cycle assertion (fable audit: without it this leg is
  // vacuously green if /party never opens — boot arms everything and nothing
  // ever resets). The nested pane's mount+close each write a fresh clear;
  // boot writes one. ≥3 total 2J bursts ⇒ the pane really cycled.
  const clears = raw2.split('[2J').length - 1
  check('pane really cycled (≥3 clear bursts: boot + pane open + pane close)', clears >= 3, `clears=${clears}`)
  const panes: Array<[number, string]> = [
    [1049, 'alt screen'],
    [1000, 'mouse normal'],
    [1006, 'mouse SGR'],
    [1007, 'alternate scroll'],
  ]
  for (const [m, label] of panes) {
    const lastSet = raw2.lastIndexOf(`[?${m}h`)
    const lastReset = raw2.lastIndexOf(`[?${m}l`)
    check(`pane close: ?${m} (${label}) still ARMED`, lastSet >= 0 && lastSet > lastReset, `lastSet=${lastSet} lastReset=${lastReset}`)
  }
}
rmSync(tee2, { force: true })
rmSync(cfg2Path, { force: true })

// ── B. source locks — the re-assert web stays wired ────────────────────────
section('B. re-assert wiring (engage paths + resume/wake/editor seams)')
const srcOf = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')
const ink = srcOf('ink', 'ink.tsx')
// The reassert leaves through the ONE door (render-engine mount): flag-off
// termWrite IS stdout.write; flag-on it is the serialized door.
check('resize re-asserts mouse + 1007', ink.includes("termWrite(this.options.stdout, resizeReassertBytes(this.mouseTracking), 'mode')"))
// The editor-return composite moved into root/screen-session.ts
// the re-arm invariant lives in the builder.
const sess = srcOf('ink', 'root', 'screen-session.ts')
check('editor-exit re-arms both', /exitEditorBytes[\s\S]{0,500}\(opts\.mouseTracking \? ENABLE_MOUSE_TRACKING : ''\)[\s\S]{0,120}\(opts\.altActive \? ENABLE_ALTERNATE_SCROLL : ''\)/.test(sess) && ink.includes('exitEditorBytes({'))
const app = srcOf('ink', 'components', 'App.tsx')
check('stdin-resume re-assert wired (App → onStdinResume)', ink.includes('onStdinResume={this.onStdinResume}') && ink.includes('this.reassertTerminalModes(false)') && app.includes('onStdinResume'))
const stall = srcOf('utils', 'eventLoopStallDetector.ts')
check('sleep-wake self-heal re-enters alt screen', stall.includes('reassertTerminalModes(true)'))

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ ${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('✅ mode discipline — ALL CHECKS PASS')
