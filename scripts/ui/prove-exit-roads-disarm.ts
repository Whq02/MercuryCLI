#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { cleanupScenario, scenario } from './renderScenarios.ts'
import { lastStateOf, mark, modeEventsBetween, MOUSE_FAMILIES, runJobControlHost, type HostReport } from './jobcontrolHost.ts'


let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log(`\n── ${t}`)
const exitRoadHint = 'fix the signal handlers in src/platform/processes/gracefulShutdown.ts or cleanupTerminalModes in src/screen/renderer/terminal-session/shutdownRestoration.ts so every exit road writes the terminal-mode resets'

const disarmed = (r: HostReport, from: number, label: string): void => {
  const ev = modeEventsBetween(r, from, null)
  check(`${label}: every mouse mode ends OFF`, MOUSE_FAMILIES.every(f => lastStateOf(ev, f) === 'off'), MOUSE_FAMILIES.map(f => `${f}=${lastStateOf(ev, f)}`).join(' ') + ` — ${exitRoadHint}`)
  check(`${label}: the alternate screen is left`, lastStateOf(ev, 'alt-screen') === 'off', exitRoadHint)
  check(`${label}: the cursor is shown`, lastStateOf(ev, 'cursor') === 'on', exitRoadHint)
  check(`${label}: bracketed paste + focus reporting end OFF`, lastStateOf(ev, 'bracketed-paste') === 'off' && lastStateOf(ev, 'focus-events') === 'off', exitRoadHint)
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
    MERCURY_HEALTH_STATE_DIR: join(home, 'health'),
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
      { wait: 'New Session', timeout: 45 },
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
  check(`${road.tag}: the journey completed`, run.status === 0 && r !== null && r.endReason === 'steps-done', `${run.stderr.slice(-300)} — status=${run.status} end=${r?.endReason}; the host run of this journey did not finish, read its report and stderr (scripts/ui/jobcontrolHost.ts)`)
  if (r && r.endReason === 'steps-done') {
    const armed = mark(r, 'armed')!
    const after = mark(r, 'after-exit')!
    const armedEv = modeEventsBetween(r, 0, armed.teeOffset)
    check(`${road.tag}: the surface was armed before the signal (mouse tracking on)`, MOUSE_FAMILIES.every(f => lastStateOf(armedEv, f) === 'on'), armedEv.map(e => e.mode).slice(-8).join(' ') + ' — the cockpit or face never turned mouse tracking on before the signal; look at the terminal-mode arming in the screen that opens, not at the exit road')
    disarmed(r, armed.teeOffset, `${road.tag}: after ${road.signal}`)
    check(`${road.tag}: the shell prompt is usable after the exit`, after.grid.includes('done-42'))
    check(`${road.tag}: no stop was reported (the process ended, never suspended)`, !r.shellLines.some(l => /suspended|Stopped/.test(l)), r.shellLines.join(' | ') + ` — ${exitRoadHint}; the process must end on the signal instead of stopping`)
  }
}
cleanupScenario('boot-face')
for (const h of homes) rmSync(h, { recursive: true, force: true })


if (failures > 0) {
  console.log(`\n ❌ exit-roads-disarm — ${failures} failure(s)`)
  process.exit(1)
}
console.log('\n ✅ exit-roads-disarm — SIGHUP and SIGINT on the cockpit, SIGHUP on the face: the stream ends disarmed; every shutdown road reaches the one teardown')
