#!/usr/bin/env bun
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
    MERCURY_CONFIG_DIR: CONFIG_HOME, VSHOT_TEE: tee },
})
cleanupScenario('resume-2turn')
check('pty boot captured', res.status === 0 && existsSync(tee), res.stderr?.slice(0, 200) ?? '')
if (res.status === 0 && existsSync(tee)) {
  const raw = readFileSync(tee, 'latin1')
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

section('A2. pane open→close — the alt screen + lock survive (reentrancy)')
const tee2 = join(tmpdir(), `mode-pane-${process.pid}.bin`)
rmSync(tee2, { force: true })
const cfg2 = {
  ...scenario('resume-2turn', 120, 44),
  out: join(tmpdir(), `mode-pane-grid-${process.pid}.json`),
}
;(cfg2 as { sends: Array<{ atTick: number; data: string }> }).sends = [
  { atTick: 30, data: '/ledger' },
  { atTick: 36, data: '\r' },
  { atTick: 46, data: String.fromCharCode(27) },
]
;(cfg2 as { total: number }).total = 60
const cfg2Path = join(tmpdir(), `mode-pane-cfg-${process.pid}.json`)
writeFileSync(cfg2Path, JSON.stringify(cfg2))
const res2 = spawnSync('/usr/bin/python3', [join(import.meta.dir, 'vshot.py'), cfg2Path], {
  encoding: 'utf-8',
  timeout: vshotBudgetMs(60000),
  env: { ...process.env,
    MERCURY_CONFIG_DIR: CONFIG_HOME, VSHOT_TEE: tee2 },
})
cleanupScenario('resume-2turn')
check('pane-cycle pty captured', res2.status === 0 && existsSync(tee2), res2.stderr?.slice(0, 200) ?? '')
if (res2.status === 0 && existsSync(tee2)) {
  const raw2 = readFileSync(tee2, 'latin1')
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

section('B. re-assert wiring (engage paths + resume/wake/editor seams)')
const srcOf = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')
const ink = srcOf('ink', 'ink.tsx')
check('resize re-asserts mouse + 1007', ink.includes("termWrite(this.options.stdout, resizeReassertBytes(this.mouseTracking), 'mode')"))
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
