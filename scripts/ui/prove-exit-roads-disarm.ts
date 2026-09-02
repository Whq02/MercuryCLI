#!/usr/bin/env bun
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { cleanupScenario, scenario } from './renderScenarios.ts'
import { lastStateOf, mark, modeEventsBetween, MOUSE_FAMILIES, runJobControlHost, type HostReport } from './jobcontrolHost.ts'

const ROOT = process.cwd()
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log(`\n── ${t}`)

const disarmed = (r: HostReport, from: number, label: string): void => {
  const ev = modeEventsBetween(r, from, null)
  check(`${label}: every mouse mode ends OFF`, MOUSE_FAMILIES.every(f => lastStateOf(ev, f) === 'off'), MOUSE_FAMILIES.map(f => `${f}=${lastStateOf(ev, f)}`).join(' '))
  check(`${label}: the alternate screen is left`, lastStateOf(ev, 'alt-screen') === 'off')
  check(`${label}: the cursor is shown`, lastStateOf(ev, 'cursor') === 'on')
  check(`${label}: bracketed paste + focus reporting end OFF`, lastStateOf(ev, 'bracketed-paste') === 'off' && lastStateOf(ev, 'focus-events') === 'off')
}

section('A · the cockpit under SIGHUP · the cockpit under SIGINT · the face under SIGHUP')
const base = scenario('boot-face', 120, 40) as { argv: string[]; cwd: string }
const homes: string[] = []
const roads: Array<{ tag: string; signal: string; toCockpit: boolean }> = [
  { tag: 'hup-cockpit', signal: 'SIGHUP', toCockpit: true },
  { tag: 'int-cockpit', signal: 'SIGINT', toCockpit: true },
  { tag: 'hup-face', signal: 'SIGHUP', toCockpit: false },
]
for (const road of roads) {
  const home = mkdtempSync(join(tmpdir(), `exit-road-${road.tag}-`))
  homes.push(home)
  seedFirstRun(home, [base.cwd])
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_FULLSCREEN: '1',
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_DOCTOR_STATE_DIR: join(home, 'doctor'),
    MERCURY_CREDENTIAL_STORE: 'file',
  }
  const run = runJobControlHost({
    tag: road.tag,
    argv: base.argv,
    cwd: base.cwd,
    cols: 120,
    rows: 40,
    env,
    budgetSeconds: 90,
    steps: [
      { wait: 'host$', timeout: 15 },
      { launch: true },
      { wait: 'Doctor / Health Check', timeout: 45 },
      { sleep: 1.5 },
      ...(road.toCockpit
        ? [{ send: '\r' }, { wait: 'Type a prompt', timeout: 30 }, { sleep: 1.5 }]
        : []),
      { observe: 'armed' },
      { mark: 'armed' },
      { signal: road.signal },
      { sleep: 2.0 },
      { typeline: 'echo done-$((40+2))' },
      { wait: 'done-42', timeout: 25 },
      { sleep: 0.5 },
      { observe: 'after-exit' },
      { mark: 'after-exit' },
    ],
  })
  const r = run.report
  check(`${road.tag}: the journey completed`, run.status === 0 && r !== null && r.endReason === 'steps-done', `status=${run.status} end=${r?.endReason} ${run.stderr.slice(-300)}`)
  if (r && r.endReason === 'steps-done') {
    const armed = mark(r, 'armed')!
    const after = mark(r, 'after-exit')!
    const armedEv = modeEventsBetween(r, 0, armed.teeOffset)
    check(`${road.tag}: the surface was armed before the signal (mouse tracking on)`, MOUSE_FAMILIES.every(f => lastStateOf(armedEv, f) === 'on'), armedEv.map(e => e.mode).slice(-8).join(' '))
    disarmed(r, armed.teeOffset, `${road.tag}: after ${road.signal}`)
    check(`${road.tag}: the shell prompt is usable after the exit`, after.grid.includes('done-42'))
    check(`${road.tag}: no stop was reported (the process ended, never suspended)`, !r.shellLines.some(l => /suspended|Stopped/.test(l)), r.shellLines.join(' | '))
  }
}
cleanupScenario('boot-face')
for (const h of homes) rmSync(h, { recursive: true, force: true })

section('B · every road reaches the one teardown (source)')
{
  const shutdown = read('src/utils/gracefulShutdown.ts')
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    const at = shutdown.indexOf(`process.on('${sig}', () => {`)
    const arm = at >= 0 ? shutdown.slice(at, at + 700) : ''
    check(`${sig} ends in the bounded shutdown`, arm.includes('gracefulShutdownSync('))
  }
  check('the orphan probe (revoked descriptors) ends in the bounded shutdown', /orphan_detected[\s\S]{0,300}gracefulShutdownSync\(129\)/.test(shutdown))
  check('the loud failure restores the terminal before its card and exit', /runTerminalRestoration\(\)\n\s+const firstLine/.test(shutdown))
  check('the crash breaker restores the terminal before its dump', /Restore the terminal first so the dump lands on a sane terminal\.\n\s+runTerminalRestoration\(\)/.test(shutdown))
  check('the failsafe timer restores the terminal before forcing the exit', /failsafeTimer = setTimeout\(\(\) => \{\n\s+runTerminalRestoration\(\)/.test(shutdown))
  check('the fallback bytes cover the road where the restoration module failed to load', shutdown.includes("FALLBACK_EXIT_ALT_SCREEN = '\\x1b[?1049l'") && shutdown.includes("FALLBACK_SHOW_CURSOR = '\\x1b[?25h'") && shutdown.includes('writeSync(1, FALLBACK_EXIT_ALT_SCREEN)'))
  const restoration = read('src/utils/shutdownRestoration.ts')
  const cleanup = restoration.slice(restoration.indexOf('export function cleanupTerminalModes'), restoration.indexOf('export function cleanupTerminalModes') + 2400)
  check('the restoration disarms mouse tracking FIRST', /Mouse tracking first[\s\S]{0,400}writeSync\(1, DISABLE_MOUSE_TRACKING\)/.test(cleanup))
  check('the restoration leaves the alt screen by UNMOUNTING (the exit suite runs)', cleanup.includes('inst.unmount()') && cleanup.includes('writeSync(1, EXIT_ALT_SCREEN)'))
  const ink = read('src/ink/ink.tsx')
  check('the renderer registers its unmount with the exit hook — a bare process.exit after mount still runs the suite', ink.includes('this.unsubscribeExit = onExit(this.unmount)'))
  check("the unmount runs the ONE teardown suite through the host the stop road shares", ink.includes('runTeardownSuite(this.teardownHost())'))
  const teardown = read('src/ink/root/teardown.ts')
  check('the suite is the ONE ordered list (mouse · alt-scroll · alt exit · paste · focus · cursor)', teardown.includes('export const TEARDOWN_SUITE: readonly TeardownStep[] = Object.freeze(['))
}

if (failures > 0) {
  console.log(`\n ❌ exit-roads-disarm — ${failures} failure(s)`)
  process.exit(1)
}
console.log('\n ✅ exit-roads-disarm — SIGHUP and SIGINT on the cockpit, SIGHUP on the face: the stream ends disarmed; every shutdown road reaches the one teardown')
