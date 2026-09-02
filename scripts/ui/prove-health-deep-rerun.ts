#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-health-deep-rerun.ts — the health screen's `d` (deep)
//  then `r` (re-run) never costs the process its terminal.
//
//  The field failure: on the Boot face's Doctor / Health Check, `d` then `r`
//  froze the screen and the shell printed `suspended (tty input)` with a
//  flood of mouse reports on the prompt. The deep run's python-debugger
//  probe spawns the debug adapter, whose launcher opens /dev/tty and hands
//  the terminal's FOREGROUND process group to the debuggee; when the
//  debuggee exits nothing hands it back, Mercury is a background job of its
//  own terminal, and its next keyboard read stops the whole process group
//  (SIGTTIN) with every terminal mode armed. The adapter tree now runs in
//  its own session (no controlling terminal): the /dev/tty open fails and
//  the hand-off never happens.
//
//  Under a job-control shell (jobcontrol-host.py — a bare exec lands in an
//  orphaned process group where none of this is observable), the journey:
//  boot → Doctor / Health Check → the fast certificate → `d` → `r` within a
//  second (the operator's timing, mid-probe) → the deep certificate → `r`
//  again after it settles → esc → SIGTERM. Pins: the process never enters T;
//  its process group stays the terminal's foreground group at every sample;
//  no child ever takes the foreground; the shell never reports a stop; the
//  byte stream carries no disarm mid-journey; the certificate re-paints
//  its "issued … ago" line after each re-run; the exit ends disarmed.
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_HOME, scenario, cleanupScenario } from './renderScenarios.ts'
import {
  lastStateOf,
  mark,
  modeEventsBetween,
  MOUSE_FAMILIES,
  runJobControlHost,
  samplesBetween,
} from './jobcontrolHost.ts'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (name: string): void => {
  console.log(`\n== ${name} ==`)
}

section('S · the source guarantee: the debug adapter tree gets no controlling terminal')
{
  const dap = readFileSync(join(ROOT, 'src/services/dap/dapClient.ts'), 'utf8')
  const spawnSite = dap.slice(dap.indexOf('const child = spawn(spec.command, spec.args, {'))
  const block = spawnSite.slice(0, spawnSite.indexOf('})') + 2)
  check('the ONE adapter spawn runs detached on POSIX (a new session — no /dev/tty for a launcher to grab)', block.includes("detached: process.platform !== 'win32'"), block.slice(0, 200))
  check('…with piped stdio (no inherited terminal descriptors)', block.includes("stdio: ['pipe', 'pipe', 'pipe']"))
  const probes = readFileSync(join(ROOT, 'src/utils/healthDeepProbes.ts'), 'utf8')
  const report = readFileSync(join(ROOT, 'src/utils/healthReport.ts'), 'utf8')
  check('no probe on the health path inherits the terminal', !/stdio:\s*'inherit'/.test(probes) && !/stdio:\s*'inherit'/.test(report) && !/'inherit'/.test(probes))
}

section('J · the operator’s journey under a job-control shell: d, then r within a second, then r again')
const base = scenario('boot-face', 120, 40) as { argv: string[]; cwd: string }
const env: NodeJS.ProcessEnv = { ...process.env, MERCURY_FULLSCREEN: '1', MERCURY_CONFIG_DIR: CONFIG_HOME }
const run = runJobControlHost({
  tag: 'health-deep-rerun',
  argv: base.argv,
  cwd: base.cwd,
  cols: 120,
  rows: 40,
  env,
  budgetSeconds: 330,
  steps: [
    { wait: 'host$', timeout: 15 },
    { launch: true },
    { wait: 'Doctor / Health Check', timeout: 45 },
    { sleep: 1.5 },
    { observe: 'face' },
    { face_row: 'Doctor / Health Check' },
    { wait: 'd deep', timeout: 30 },
    { wait: 'issued', timeout: 60 },
    { sleep: 0.5 },
    { observe: 'fast-settled' },
    { mark: 'fast' },
    // d, then r while the deep probes are still running (the operator's timing).
    { send: 'd' },
    { sleep: 0.7 },
    { send: 'r' },
    { mark: 'after-r' },
    // The deep run ends when the certificate re-paints its issued line; the
    // process state is sampled every 200 ms the whole way.
    { poll: true, seconds: 130, interval: 0.2, label: 'deep-1', until: 'issued' },
    { sleep: 0.5 },
    { observe: 'deep-settled' },
    { mark: 'deep-settled' },
    // r again on the settled deep certificate.
    { send: 'r' },
    { sleep: 0.5 },
    { poll: true, seconds: 130, interval: 0.2, label: 'deep-2', until: 'issued' },
    { sleep: 0.5 },
    { observe: 'deep-settled-2' },
    { mark: 'deep-settled-2' },
    // A key AFTER the runs: the read that stopped the operator's process.
    { send: '\x1b' }, // esc → back to the face
    { wait: 'New Session', timeout: 15 },
    { sleep: 0.5 },
    { observe: 'back-on-face' },
    { mark: 'back-on-face' },
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

if (run.report && run.report.endReason === 'steps-done') {
  const r = run.report
  const fast = mark(r, 'fast')!
  const afterR = mark(r, 'after-r')!
  const deep1 = mark(r, 'deep-settled')!
  const deep2 = mark(r, 'deep-settled-2')!
  const back = mark(r, 'back-on-face')!
  const afterExit = mark(r, 'after-exit')!

  const live = samplesBetween(r, 0, back.ms + 1).filter(s => s.stat !== null)
  check(`the process was sampled throughout (${live.length} samples)`, live.length >= 20)
  check('the process NEVER entered T (no stop, at any sample)', live.every(s => !s.stat!.startsWith('T')), live.filter(s => s.stat!.startsWith('T')).map(s => `${s.label}@${s.ms}`).slice(0, 5).join(','))
  check('Mercury’s process group stayed the terminal’s foreground group at EVERY sample', live.every(s => s.foreground === true), live.filter(s => s.foreground !== true).map(s => `${s.label}@${s.ms}: pgid=${s.pgid} tpgid=${s.tpgid}`).slice(0, 5).join(' ; '))
  const grabbers = live.flatMap(s => s.tree.filter(p => p.pid !== r.bundlePid && p.pgid === p.tpgid && p.pgid !== s.pgid))
  check('no child ever held the terminal’s foreground group', grabbers.length === 0, grabbers.slice(0, 3).map(p => `${p.pid} ${p.cmd.slice(0, 60)}`).join(' ; '))
  const debugTree = live.flatMap(s => s.tree.filter(p => /debugpy|debug adapter|adapter/.test(p.cmd)))
  check(`the deep run did spawn the debug adapter tree (${debugTree.length} sightings) — the probe ran, the terminal was never handed over`, debugTree.length > 0)
  check('the shell never reported a stop', r.shellLines.length === 0, r.shellLines.join(' | '))

  const mid = modeEventsBetween(r, fast.teeOffset, back.teeOffset)
  check('no mouse disarm mid-journey (the tracking stayed armed from the fast certificate to the face)', MOUSE_FAMILIES.every(f => !mid.some(e => e.mode === `${f}:off`)), mid.filter(e => e.mode.endsWith(':off')).map(e => e.mode).join(','))
  check('the alternate screen was never left mid-journey', !mid.some(e => e.mode === 'alt-screen:off'))

  check('after r the certificate was CLEARED (a run in progress, not the stale fast one)', !afterR.grid.includes('issued') || afterR.grid.includes('examining'), afterR.grid.split('\n').filter(l => l.includes('issued') || l.includes('examining')).join(' | '))
  check("the deep certificate re-painted its 'issued … ago' line", /issued \d+s ago/.test(deep1.grid), deep1.grid.split('\n').filter(l => l.includes('issued')).join(' | '))
  check('…and the deep depth is what ran (deep rows on the certificate)', /\(deep\)|deep/.test(deep1.grid))
  check("the second re-run settled and re-painted 'issued' again", /issued \d+s ago/.test(deep2.grid))
  check('esc after the runs took the key (the process read its terminal and lived)', back.grid.includes('New Session'))

  const tail = modeEventsBetween(r, back.teeOffset, null)
  check('the exit ended with the disarm set (mouse off · alt off · cursor shown)', MOUSE_FAMILIES.every(f => lastStateOf(tail, f) === 'off') && lastStateOf(tail, 'alt-screen') === 'off' && lastStateOf(tail, 'cursor') === 'on')
  const gone = samplesBetween(r, afterExit.ms - 1, null)
  check('the process is gone and the shell prompt is usable', gone.length > 0 && gone.every(s => s.stat === null) && afterExit.grid.includes('done-42'))
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(` ❌ prove-health-deep-rerun: ${failures} failure(s)`)
  process.exit(1)
}
console.log(' ✅ health-deep-rerun — d then r keeps the terminal: never T, foreground kept, no child grab, no mid-journey disarm, the certificate re-paints (E2E under a job-control shell)')
