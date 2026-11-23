#!/usr/bin/env bun
import { join } from 'node:path'
import { CONFIG_HOME, scenario, cleanupScenario } from './renderScenarios.ts'
import {
  lastStateOf,
  mark,
  modeEventsBetween,
  MOUSE_FAMILIES,
  runJobControlHost,
  samplesBetween,
  type HostReport,
} from './jobcontrolHost.ts'
import { runTeardownSuite, type TeardownHost } from '../../src/screen/renderer/root/teardown.ts'
import {
  continueRearmBytes,
  isStopSignal,
  POSIX_STOP_SIGNALS,
  restoreTerminalForStop,
  stopIsForeground,
  stopSignalsSupported,
  type StopSignal,
} from '../../src/screen/renderer/root/stop-continue.ts'
import { reassertModesBytes } from '../../src/screen/renderer/root/screen-session.ts'
import { DBP, DFE, EBP, EFE, ENABLE_MOUSE_TRACKING, EXIT_ALT_SCREEN, SHOW_CURSOR } from '../../src/screen/renderer/termio/dec.ts'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const stopFixHint = 'fix restoreTerminalForStop in src/screen/renderer/root/stop-continue.ts (it must run runTeardownSuite from src/screen/renderer/root/teardown.ts) and its caller in src/screen/renderer/instance/stop-continue.ts'
const rearmFixHint = 'fix continueRearmBytes in src/screen/renderer/root/stop-continue.ts (it must return reassertModesBytes from src/screen/renderer/root/screen-session.ts) and the SIGCONT handler in src/screen/renderer/instance/stop-continue.ts'
const section = (name: string): void => {
  console.log(`\n== ${name} ==`)
}

section('C · the one owner: stop disarm = exit teardown; continue re-arm = the arming owner')
{
  type Capture = { bytes: string[]; drains: number; pointer: number }
  const capturingHost = (cap: Capture, altScreenActive: boolean): TeardownHost => ({
    altScreenActive,
    tabStatusSupported: false,
    write: b => {
      cap.bytes.push(b)
    },
    drainStdin: () => {
      cap.drains++
    },
    resetPointer: () => {
      cap.pointer++
    },
  })
  const rawStdin = (isRaw: boolean) => {
    const calls: boolean[] = []
    return {
      stdin: { isTTY: true, isRaw, setRawMode: (m: boolean) => calls.push(m) },
      calls,
    }
  }
  for (const alt of [true, false]) {
    const exit: Capture = { bytes: [], drains: 0, pointer: 0 }
    runTeardownSuite(capturingHost(exit, alt))
    const stop: Capture = { bytes: [], drains: 0, pointer: 0 }
    const fg = rawStdin(true)
    const receipt = restoreTerminalForStop('SIGTSTP', capturingHost(stop, alt), fg.stdin)
    check(
      `SIGTSTP (alt=${alt}): the stop writes EXACTLY the exit teardown suite's bytes, in its order`,
      stop.bytes.join('\x01') === exit.bytes.join('\x01'),
      `stop=${JSON.stringify(stop.bytes)} exit=${JSON.stringify(exit.bytes)} — ${stopFixHint}`,
    )
    check(`SIGTSTP (alt=${alt}): the input queue is drained (foreground stop)`, stop.drains === 1 && stop.pointer === 1, `drains=${stop.drains} pointer=${stop.pointer} — a foreground stop must drain stdin and reset the pointer once each; ${stopFixHint}`)
    check(`SIGTSTP (alt=${alt}): raw mode off, receipted`, fg.calls.join() === 'false' && receipt.rawModeOff === true, `setRawMode calls=${fg.calls.join()} rawModeOff=${receipt.rawModeOff} — a foreground stop must call stdin.setRawMode(false) once and report rawModeOff; ${stopFixHint}`)
    const joined = stop.bytes.join('')
    check(
      `SIGTSTP (alt=${alt}): the disarm set is inside — mouse off · ${alt ? 'alt exit · ' : ''}focus off · paste off · cursor shown`,
      joined.includes('\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l') &&
        joined.includes(EXIT_ALT_SCREEN) === alt &&
        joined.includes(DFE) &&
        joined.includes(DBP) &&
        joined.includes(SHOW_CURSOR),
      `bytes=${JSON.stringify(stop.bytes)} — the stop bytes must come from runTeardownSuite in src/screen/renderer/root/teardown.ts and carry every disarm sequence named in the label`,
    )
    for (const bg of ['SIGTTIN', 'SIGTTOU'] as const) {
      const cap: Capture = { bytes: [], drains: 0, pointer: 0 }
      const st = rawStdin(true)
      const r = restoreTerminalForStop(bg, capturingHost(cap, alt), st.stdin)
      check(`${bg} (alt=${alt}): same bytes as the exit suite`, cap.bytes.join('\x01') === exit.bytes.join('\x01'), `stop=${JSON.stringify(cap.bytes)} exit=${JSON.stringify(exit.bytes)} — ${stopFixHint}`)
      check(
        `${bg} (alt=${alt}): a BACKGROUND stop never touches the line discipline nor reads the terminal (SIGTTOU/SIGTTIN would stop it mid-restore)`,
        cap.drains === 0 && st.calls.length === 0 && r.rawModeOff === false,
        `drains=${cap.drains} setRawMode calls=${st.calls.length} rawModeOff=${r.rawModeOff} — restoreTerminalForStop in src/screen/renderer/root/stop-continue.ts must only drain stdin and clear raw mode when stopIsForeground(signal) is true`,
      )
    }
  }
  const cooked = rawStdin(false)
  const r0 = restoreTerminalForStop('SIGTSTP', capturingHost({ bytes: [], drains: 0, pointer: 0 }, true), cooked.stdin)
  check('a stop with raw mode already off records no raw-mode debt', cooked.calls.length === 0 && r0.rawModeOff === false, `setRawMode calls=${cooked.calls.length} rawModeOff=${r0.rawModeOff} — restoreTerminalForStop in src/screen/renderer/root/stop-continue.ts must touch raw mode only when stdin.isRaw is true`)

  let rearmIdentity = true
  let rearmShape = true
  for (const extendedKeys of [true, false])
    for (const altActive of [true, false])
      for (const mouseTracking of [true, false]) {
        const o = { extendedKeys, altActive, mouseTracking }
        const bytes = continueRearmBytes(o)
        if (bytes !== reassertModesBytes(o)) rearmIdentity = false
        const wantsMouse = altActive && mouseTracking
        if (!bytes.includes(EBP) || !bytes.includes(EFE) || bytes.includes(ENABLE_MOUSE_TRACKING) !== wantsMouse) rearmShape = false
      }
  check('the continue re-arm IS the arming owner’s re-assert (byte-identical over the option matrix)', rearmIdentity, 'continueRearmBytes in src/screen/renderer/root/stop-continue.ts must return exactly reassertModesBytes from src/screen/renderer/root/screen-session.ts')
  check('…and carries paste + focus always, the mouse family exactly on an alt screen that tracks', rearmShape, 'reassertModesBytes in src/screen/renderer/root/screen-session.ts must always emit bracketed paste and focus enable, and the mouse enable only when altActive and mouseTracking are both true')

  check('the stop signals are the three catchable POSIX job-control stops', POSIX_STOP_SIGNALS.join() === 'SIGTSTP,SIGTTIN,SIGTTOU', `got ${POSIX_STOP_SIGNALS.join()} — POSIX_STOP_SIGNALS in src/screen/renderer/root/stop-continue.ts must list exactly SIGTSTP, SIGTTIN, SIGTTOU`)
  check('Windows has no stop signals (no listener there)', stopSignalsSupported('win32') === false && stopSignalsSupported('darwin') && stopSignalsSupported('linux'), 'stopSignalsSupported in src/screen/renderer/root/stop-continue.ts (via terminalSupportsJobControl in src/platform/host-os/terminal.ts) must be false on win32 and true on darwin and linux')
  check('SIGTSTP is the foreground stop; SIGTTIN/SIGTTOU are background stops', stopIsForeground('SIGTSTP') && !stopIsForeground('SIGTTIN') && !stopIsForeground('SIGTTOU'), 'stopIsForeground in src/screen/renderer/root/stop-continue.ts must be true only for SIGTSTP')
  check('isStopSignal admits exactly the three', (['SIGTSTP', 'SIGTTIN', 'SIGTTOU'] as StopSignal[]).every(isStopSignal) && !isStopSignal('SIGSTOP') && !isStopSignal('SIGCONT'), 'isStopSignal in src/screen/renderer/root/stop-continue.ts must accept only the names in POSIX_STOP_SIGNALS')

}

section('A · SIGTSTP: restore first, then stop; fg re-arms + repaints; keys land · A2 · ctrl+z · B · SIGTERM')
const base = scenario('boot-face', 120, 40) as { argv: string[]; cwd: string }
const env: NodeJS.ProcessEnv = { ...process.env, MERCURY_FULLSCREEN: '1', MERCURY_CONFIG_DIR: CONFIG_HOME }
const run = runJobControlHost({
  tag: 'suspend',
  argv: base.argv,
  cwd: base.cwd,
  cols: 120,
  rows: 40,
  env,
  budgetSeconds: 170,
  steps: [
    { wait: 'host$', timeout: 15 },
    { launch: true },
    { wait: 'New Session', timeout: 45 },
    { sleep: 1.5 },
    { send: '\r' },
    { wait: 'Type a prompt', timeout: 30 },
    { sleep: 1.5 },
    { observe: 'cockpit' },
    { mark: 'pre-stop' },
    { signal: 'SIGTSTP' },
    { await_state: 'T', timeout: 8 },
    { sleep: 1.0 },
    { observe: 'stopped' },
    { mark: 'stopped' },
    { typeline: 'fg' },
    { sleep: 0.5 },
    { await_settle: true, checks: 4, timeout: 15 },
    { observe: 'continued' },
    { mark: 'continued' },
    { send: 'typed after resume' },
    { wait: 'typed after resume', timeout: 10 },
    { observe: 'typed' },
    { mark: 'typed' },
    { send: '\x1a' },
    { await_state: 'T', timeout: 8 },
    { sleep: 1.0 },
    { observe: 'stopped-ctrlz' },
    { mark: 'stopped-ctrlz' },
    { typeline: 'fg' },
    { sleep: 0.5 },
    { await_settle: true, checks: 4, timeout: 15 },
    { mark: 'continued-ctrlz' },
    { send: ' again' },
    { wait: 'typed after resume again', timeout: 10 },
    { observe: 'typed-2' },
    { mark: 'typed-2' },
    { signal: 'SIGTERM' },
    { sleep: 2.0 },
    { typeline: 'echo done-$((40+2))' },
    { wait: 'done-42', timeout: 25 },
    { sleep: 0.5 },
    { observe: 'after-exit' },
    { mark: 'after-exit' },
  ],
})
cleanupScenario('boot-face')
check('the journey completed', run.status === 0 && run.report !== null && run.report.endReason === 'steps-done', `status=${run.status} end=${run.report?.endReason} ${run.stderr.slice(-300)} — the step that stalled is the last one in the host report; see runJobControlHost in scripts/ui/jobcontrolHost.ts and the steps list in this file`)

const disarmed = (r: HostReport, from: number, to: number | null, label: string, alt = true): void => {
  const ev = modeEventsBetween(r, from, to)
  check(`${label}: every mouse mode ends OFF`, MOUSE_FAMILIES.every(f => lastStateOf(ev, f) === 'off'), MOUSE_FAMILIES.map(f => `${f}=${lastStateOf(ev, f)}`).join(' ') + ` — ${stopFixHint}`)
  if (alt) check(`${label}: the alternate screen is left`, lastStateOf(ev, 'alt-screen') === 'off', `alt-screen=${lastStateOf(ev, 'alt-screen')} — ${stopFixHint}`)
  check(`${label}: the cursor is shown`, lastStateOf(ev, 'cursor') === 'on', `cursor=${lastStateOf(ev, 'cursor')} — ${stopFixHint}`)
  check(`${label}: bracketed paste + focus reporting end OFF`, lastStateOf(ev, 'bracketed-paste') === 'off' && lastStateOf(ev, 'focus-events') === 'off', `bracketed-paste=${lastStateOf(ev, 'bracketed-paste')} focus-events=${lastStateOf(ev, 'focus-events')} — ${stopFixHint}`)
}
const rearmed = (r: HostReport, from: number, to: number | null, label: string): void => {
  const ev = modeEventsBetween(r, from, to)
  check(`${label}: every mouse mode ends ON again`, MOUSE_FAMILIES.every(f => lastStateOf(ev, f) === 'on'), MOUSE_FAMILIES.map(f => `${f}=${lastStateOf(ev, f)}`).join(' ') + ` — ${rearmFixHint}`)
  check(`${label}: the alternate screen is re-entered`, lastStateOf(ev, 'alt-screen') === 'on', `alt-screen=${lastStateOf(ev, 'alt-screen')} — ${rearmFixHint}`)
  check(`${label}: bracketed paste + focus reporting are back ON`, lastStateOf(ev, 'bracketed-paste') === 'on' && lastStateOf(ev, 'focus-events') === 'on', `bracketed-paste=${lastStateOf(ev, 'bracketed-paste')} focus-events=${lastStateOf(ev, 'focus-events')} — ${rearmFixHint}`)
  check(`${label}: the cursor is hidden again (the stop showed it; the cockpit draws its own caret)`, lastStateOf(ev, 'cursor') === 'off', `cursor=${lastStateOf(ev, 'cursor')} — ${rearmFixHint}`)
}

if (run.report && run.report.endReason === 'steps-done') {
  const r = run.report
  const pre = mark(r, 'pre-stop')!
  const stopped = mark(r, 'stopped')!
  const continued = mark(r, 'continued')!
  const typed = mark(r, 'typed')!
  const stoppedZ = mark(r, 'stopped-ctrlz')!
  const continuedZ = mark(r, 'continued-ctrlz')!
  const typed2 = mark(r, 'typed-2')!
  const afterExit = mark(r, 'after-exit')!

  const stopSamples = samplesBetween(r, pre.ms, stopped.ms)
  check('A: ps -o stat= showed T (a real stop) after SIGTSTP', stopSamples.some(s => s.stat?.startsWith('T')), stopSamples.map(s => s.stat).join(',') + ' — the SIGTSTP handler in src/screen/renderer/instance/stop-continue.ts must stop the process after restoring the terminal')
  disarmed(r, pre.teeOffset, stopped.teeOffset, 'A: before the stop')
  check("A: the shell saw a normally stopped job ('Stopped' on its prompt line)", stopped.grid.includes('Stopped'), stopped.grid.split('\n').filter(l => l.trim()).slice(-4).join(' | ') + ' — the SIGTSTP handler in src/screen/renderer/instance/stop-continue.ts must really stop the process (not exit it) so the shell reports a stopped job')
  check("A: …and never a 'tty input' stop (the process kept its terminal)", !r.shellLines.some(l => /tty input|tty output/.test(l)), r.shellLines.join(' | ') + ' — the stop in src/screen/renderer/instance/stop-continue.ts must restore the terminal first so the process is not stopped by SIGTTIN or SIGTTOU')
  rearmed(r, stopped.teeOffset, continued.teeOffset, 'A: after fg')
  check('A: the cockpit repainted in full after fg (composer + footer chrome back)', /^\s*│❯ /m.test(continued.grid) && continued.grid.includes('for shortcuts'), continued.grid.split('\n').filter(l => l.trim()).slice(-6).join(' | ') + ' — the SIGCONT handler in src/screen/renderer/instance/stop-continue.ts must request a full repaint after fg')
  const resumed = samplesBetween(r, continued.ms - 1, typed.ms + 1).filter(s => s.stat !== null)
  check('A: the process is running again after fg', resumed.length > 0 && resumed.every(s => !s.stat!.startsWith('T')), resumed.map(s => s.stat).join(',') + ' — the process must leave state T after fg; check the SIGCONT handler in src/screen/renderer/instance/stop-continue.ts')
  check('A: keys typed after the resume landed in the composer', typed.grid.includes('typed after resume'), 'stdin must be raw again after fg; check the SIGCONT handler in src/screen/renderer/instance/stop-continue.ts')

  const stopSamplesZ = samplesBetween(r, typed.ms, stoppedZ.ms)
  check('A2: ctrl+z stopped the process (T)', stopSamplesZ.some(s => s.stat?.startsWith('T')), stopSamplesZ.map(s => s.stat).join(',') + ' — ctrl+z (byte 0x1a) must reach the SIGTSTP stop path in src/screen/renderer/instance/stop-continue.ts')
  disarmed(r, typed.teeOffset, stoppedZ.teeOffset, 'A2: before the ctrl+z stop')
  check("A2: the shell saw a normally stopped job", stoppedZ.grid.includes('Stopped'), 'the ctrl+z stop in src/screen/renderer/instance/stop-continue.ts must really stop the process so the shell prints Stopped')
  rearmed(r, stoppedZ.teeOffset, continuedZ.teeOffset, 'A2: after fg')
  check('A2: the composer kept the earlier text and took the new keys', typed2.grid.includes('typed after resume again'), 'the composer text must survive the stop and fg, and stdin must be raw again; check the SIGCONT handler in src/screen/renderer/instance/stop-continue.ts')
  const resumed2 = samplesBetween(r, continuedZ.ms - 1, typed2.ms + 1).filter(s => s.stat !== null)
  check('A2: the process is running again after fg', resumed2.length > 0 && resumed2.every(s => !s.stat!.startsWith('T')), resumed2.map(s => s.stat).join(',') + ' — the process must leave state T after fg; check the SIGCONT handler in src/screen/renderer/instance/stop-continue.ts')

  disarmed(r, typed2.teeOffset, null, 'B: SIGTERM — the stream’s tail')
  const gone = samplesBetween(r, afterExit.ms - 1, null)
  check('B: the process is gone and the shell prompt is usable', gone.length > 0 && gone.every(s => s.stat === null) && afterExit.grid.includes('done-42'), 'SIGTERM must end the process and hand the terminal back; check the SIGTERM exit path through runTeardownSuite in src/screen/renderer/root/teardown.ts')
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(` ❌ prove-tty-suspend: ${failures} failure(s)`)
  process.exit(1)
}
console.log(' ✅ tty-suspend — stop restores first (SIGTSTP · ctrl+z) · fg re-arms + repaints · SIGTERM ends disarmed · one owner (E2E under a job-control shell)')
