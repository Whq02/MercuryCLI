#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-tty-suspend.ts — the terminal host's STOP / CONTINUE /
//  EXIT hygiene, on the built bundle under a real job-control shell.
//
//  A stopped process runs no JavaScript: whatever the terminal holds at the
//  stop is what the shell prompt inherits (mouse motion reports flooding
//  the line editor, a hidden cursor, the alternate screen), and what stays
//  if the stopped job is then killed. So a job-control stop must RESTORE
//  FIRST and only then stop; the continue must re-arm and repaint; every
//  exit must end with the same disarm set.
//
//  Legs (one PTY journey, bash hosting the bundle as a foreground job —
//  jobcontrol-host.py explains why a shell host and not a bare exec):
//   A  SIGTSTP to the bundle at the cockpit: the byte stream carries the
//      disarm set (mouse off · alt screen off · cursor shown · paste off ·
//      focus off) BEFORE `ps -o stat=` shows T; the shell reports a normally
//      stopped job; `fg` brings the re-arm set, the alternate screen and a
//      full repaint; keys typed after the resume land in the composer.
//   A2 the same through ctrl+z (the App's suspend dispatch rides the same
//      stop owner).
//   B  SIGTERM while running: the stream's tail is the disarm set and the
//      shell prompt is usable (the process is gone).
//   C  unit pins on the owners: the stop-time disarm IS the exit teardown
//      suite (byte-identical, one list); a background stop (SIGTTIN/SIGTTOU)
//      skips the raw-mode restore and the input drain; the continue re-arm
//      IS the arming owner's re-assert; the stop signals are POSIX-only;
//      the exit, stop and resume paths import the one owner; no file but
//      the DEC owner spells a mouse-mode sequence.
// ============================================================================
import { readdirSync, readFileSync, statSync } from 'node:fs'
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
import { runTeardownSuite, type TeardownHost } from '../../src/ink/root/teardown.ts'
import {
  continueRearmBytes,
  isStopSignal,
  POSIX_STOP_SIGNALS,
  restoreTerminalForStop,
  stopIsForeground,
  stopSignalsSupported,
  type StopSignal,
} from '../../src/ink/root/stop-continue.ts'
import { reassertModesBytes } from '../../src/ink/root/screen-session.ts'
import { DBP, DFE, EBP, EFE, ENABLE_MOUSE_TRACKING, EXIT_ALT_SCREEN, SHOW_CURSOR } from '../../src/ink/termio/dec.ts'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (name: string): void => {
  console.log(`\n== ${name} ==`)
}

// ── C first: the owners, in-process (no PTY needed) ─────────────────────────
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
      `stop=${JSON.stringify(stop.bytes)} exit=${JSON.stringify(exit.bytes)}`,
    )
    check(`SIGTSTP (alt=${alt}): the input queue is drained (foreground stop)`, stop.drains === 1 && stop.pointer === 1)
    check(`SIGTSTP (alt=${alt}): raw mode off, receipted`, fg.calls.join() === 'false' && receipt.rawModeOff === true)
    const joined = stop.bytes.join('')
    check(
      `SIGTSTP (alt=${alt}): the disarm set is inside — mouse off · ${alt ? 'alt exit · ' : ''}focus off · paste off · cursor shown`,
      joined.includes('\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l') &&
        joined.includes(EXIT_ALT_SCREEN) === alt &&
        joined.includes(DFE) &&
        joined.includes(DBP) &&
        joined.includes(SHOW_CURSOR),
    )
    for (const bg of ['SIGTTIN', 'SIGTTOU'] as const) {
      const cap: Capture = { bytes: [], drains: 0, pointer: 0 }
      const st = rawStdin(true)
      const r = restoreTerminalForStop(bg, capturingHost(cap, alt), st.stdin)
      check(`${bg} (alt=${alt}): same bytes as the exit suite`, cap.bytes.join('\x01') === exit.bytes.join('\x01'))
      check(
        `${bg} (alt=${alt}): a BACKGROUND stop never touches the line discipline nor reads the terminal (SIGTTOU/SIGTTIN would stop it mid-restore)`,
        cap.drains === 0 && st.calls.length === 0 && r.rawModeOff === false,
      )
    }
  }
  const cooked = rawStdin(false)
  const r0 = restoreTerminalForStop('SIGTSTP', capturingHost({ bytes: [], drains: 0, pointer: 0 }, true), cooked.stdin)
  check('a stop with raw mode already off records no raw-mode debt', cooked.calls.length === 0 && r0.rawModeOff === false)

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
  check('the continue re-arm IS the arming owner’s re-assert (byte-identical over the option matrix)', rearmIdentity)
  check('…and carries paste + focus always, the mouse family exactly on an alt screen that tracks', rearmShape)

  check('the stop signals are the three catchable POSIX job-control stops', POSIX_STOP_SIGNALS.join() === 'SIGTSTP,SIGTTIN,SIGTTOU')
  check('Windows has no stop signals (no listener there)', stopSignalsSupported('win32') === false && stopSignalsSupported('darwin') && stopSignalsSupported('linux'))
  check('SIGTSTP is the foreground stop; SIGTTIN/SIGTTOU are background stops', stopIsForeground('SIGTSTP') && !stopIsForeground('SIGTTIN') && !stopIsForeground('SIGTTOU'))
  check('isStopSignal admits exactly the three', (['SIGTSTP', 'SIGTTIN', 'SIGTTOU'] as StopSignal[]).every(isStopSignal) && !isStopSignal('SIGSTOP') && !isStopSignal('SIGCONT'))

  // Source pins: the exit path, the stop path and the resume path import
  // the one owner; no renderer spells a mouse-mode sequence of its own.
  const ink = readFileSync(join(ROOT, 'src/ink/ink.tsx'), 'utf8')
  const app = readFileSync(join(ROOT, 'src/ink/components/App.tsx'), 'utf8')
  const owner = readFileSync(join(ROOT, 'src/ink/root/stop-continue.ts'), 'utf8')
  check('the stop owner disarms through the exit teardown suite (one list, imported)', owner.includes("from './teardown.js'") && owner.includes('runTeardownSuite('))
  check('the stop owner re-arms through the arming owner (imported, never a second list)', owner.includes("from './screen-session.js'") && owner.includes('reassertModesBytes('))
  check(
    'the terminal host imports the stop owner for the stop AND the resume path',
    ink.includes("from './root/stop-continue.js'") && ink.includes('restoreTerminalForStop(signal, this.teardownHost(), this.options.stdin)') && ink.includes('continueRearmBytes({'),
  )
  check('the exit path and the stop path share ONE teardown host', ink.includes('runTeardownSuite(this.teardownHost())') && (ink.match(/this\.teardownHost\(\)/g) ?? []).length >= 2)
  check('the stop handler attaches every stop signal and re-raises the SAME signal under its default disposition', ink.includes('for (const signal of POSIX_STOP_SIGNALS) process.on(signal, this.stopForSignal)') && ink.includes('process.kill(process.pid, signal)'))
  check('the resume path re-arms raw mode the stop turned off, then the modes (and re-hides the cursor the stop showed), then the destructive alt re-entry', /this\.rawModeOffForStop = false[\s\S]{0,900}continueRearmBytes\(\{[\s\S]{0,900}this\.reenterAltScreen\(\);/.test(ink) && ink.includes("shutdownReleaseObligations().includes('cursor-hidden')"))
  check("ctrl+z rides the stop owner (SIGTSTP), never a bare SIGSTOP", app.includes("process.kill(process.pid, 'SIGTSTP')") && !app.includes("'SIGSTOP'"))

  const mouseLiteral = /\\x1b\[\?100[0236][hl]|\\u001b\[\?100[0236][hl]|\[\?100[0236][hl]/
  const offenders: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.(ts|tsx)$/.test(name)) continue
      if (full.endsWith('src/ink/termio/dec.ts')) continue
      const text = readFileSync(full, 'utf8')
      // Comments may NAME a mode; a spelled sequence is the offence.
      if (mouseLiteral.test(text)) offenders.push(full.slice(ROOT.length + 1))
    }
  }
  walk(join(ROOT, 'src'))
  check('no file but the DEC owner spells a mouse-mode sequence', offenders.length === 0, offenders.join(', '))
}

// ── A · A2 · B: the PTY journey under a job-control shell ───────────────────
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
    { wait: 'Doctor / Health Check', timeout: 45 },
    { sleep: 1.5 },
    { send: '\r' }, // New Session → the cockpit
    { wait: 'Type a prompt', timeout: 30 },
    { sleep: 1.5 },
    { observe: 'cockpit' },
    { mark: 'pre-stop' },
    // A — the kernel-shaped stop.
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
    // A2 — the App's own dispatch.
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
    // B — SIGTERM while running.
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
check('the journey completed', run.status === 0 && run.report !== null && run.report.endReason === 'steps-done', `status=${run.status} end=${run.report?.endReason} ${run.stderr.slice(-300)}`)

const disarmed = (r: HostReport, from: number, to: number | null, label: string, alt = true): void => {
  const ev = modeEventsBetween(r, from, to)
  check(`${label}: every mouse mode ends OFF`, MOUSE_FAMILIES.every(f => lastStateOf(ev, f) === 'off'), MOUSE_FAMILIES.map(f => `${f}=${lastStateOf(ev, f)}`).join(' '))
  if (alt) check(`${label}: the alternate screen is left`, lastStateOf(ev, 'alt-screen') === 'off')
  check(`${label}: the cursor is shown`, lastStateOf(ev, 'cursor') === 'on')
  check(`${label}: bracketed paste + focus reporting end OFF`, lastStateOf(ev, 'bracketed-paste') === 'off' && lastStateOf(ev, 'focus-events') === 'off')
}
const rearmed = (r: HostReport, from: number, to: number | null, label: string): void => {
  const ev = modeEventsBetween(r, from, to)
  check(`${label}: every mouse mode ends ON again`, MOUSE_FAMILIES.every(f => lastStateOf(ev, f) === 'on'), MOUSE_FAMILIES.map(f => `${f}=${lastStateOf(ev, f)}`).join(' '))
  check(`${label}: the alternate screen is re-entered`, lastStateOf(ev, 'alt-screen') === 'on')
  check(`${label}: bracketed paste + focus reporting are back ON`, lastStateOf(ev, 'bracketed-paste') === 'on' && lastStateOf(ev, 'focus-events') === 'on')
  check(`${label}: the cursor is hidden again (the stop showed it; the cockpit draws its own caret)`, lastStateOf(ev, 'cursor') === 'off')
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

  // A
  const stopSamples = samplesBetween(r, pre.ms, stopped.ms)
  check('A: ps -o stat= showed T (a real stop) after SIGTSTP', stopSamples.some(s => s.stat?.startsWith('T')), stopSamples.map(s => s.stat).join(','))
  disarmed(r, pre.teeOffset, stopped.teeOffset, 'A: before the stop')
  check("A: the shell saw a normally stopped job ('Stopped' on its prompt line)", stopped.grid.includes('Stopped'), stopped.grid.split('\n').filter(l => l.trim()).slice(-4).join(' | '))
  check("A: …and never a 'tty input' stop (the process kept its terminal)", !r.shellLines.some(l => /tty input|tty output/.test(l)), r.shellLines.join(' | '))
  rearmed(r, stopped.teeOffset, continued.teeOffset, 'A: after fg')
  check('A: the cockpit repainted in full after fg (composer + footer chrome back)', continued.grid.includes('Type a prompt') && continued.grid.includes('for shortcuts'), continued.grid.split('\n').filter(l => l.trim()).slice(-6).join(' | '))
  const resumed = samplesBetween(r, continued.ms - 1, typed.ms + 1).filter(s => s.stat !== null)
  check('A: the process is running again after fg', resumed.length > 0 && resumed.every(s => !s.stat!.startsWith('T')), resumed.map(s => s.stat).join(','))
  check('A: keys typed after the resume landed in the composer', typed.grid.includes('typed after resume'))

  // A2
  const stopSamplesZ = samplesBetween(r, typed.ms, stoppedZ.ms)
  check('A2: ctrl+z stopped the process (T)', stopSamplesZ.some(s => s.stat?.startsWith('T')), stopSamplesZ.map(s => s.stat).join(','))
  disarmed(r, typed.teeOffset, stoppedZ.teeOffset, 'A2: before the ctrl+z stop')
  check("A2: the shell saw a normally stopped job", stoppedZ.grid.includes('Stopped'))
  rearmed(r, stoppedZ.teeOffset, continuedZ.teeOffset, 'A2: after fg')
  check('A2: the composer kept the earlier text and took the new keys', typed2.grid.includes('typed after resume again'))
  const resumed2 = samplesBetween(r, continuedZ.ms - 1, typed2.ms + 1).filter(s => s.stat !== null)
  check('A2: the process is running again after fg', resumed2.length > 0 && resumed2.every(s => !s.stat!.startsWith('T')), resumed2.map(s => s.stat).join(','))

  // B
  disarmed(r, typed2.teeOffset, null, 'B: SIGTERM — the stream’s tail')
  const gone = samplesBetween(r, afterExit.ms - 1, null)
  check('B: the process is gone and the shell prompt is usable', gone.length > 0 && gone.every(s => s.stat === null) && afterExit.grid.includes('done-42'))
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(` ❌ prove-tty-suspend: ${failures} failure(s)`)
  process.exit(1)
}
console.log(' ✅ tty-suspend — stop restores first (SIGTSTP · ctrl+z) · fg re-arms + repaints · SIGTERM ends disarmed · one owner (E2E under a job-control shell)')
