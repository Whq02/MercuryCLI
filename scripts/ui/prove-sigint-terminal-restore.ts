import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCaptureDriver } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { removeScratch } from '../lib/removeScratch.ts'
import { cleanupScenario, scenario } from './renderScenarios.ts'
import { runJobControlHost, mark } from './jobcontrolHost.ts'

const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.log(`prove-sigint-terminal-restore: SKIPPED — the drive needs the POSIX pty job-control host; this host has ${driver.kind === 'unavailable' ? `none (${driver.reason}; ${driver.remedy})` : driver.kind}`)
  process.exit(0)
}
const home = mkdtempSync(join(tmpdir(), 'sigint-restore-'))
process.env.MERCURY_CONFIG_DIR = home
const base = scenario('boot-face', 120, 40) as { argv: string[]; cwd: string }
try {
  seedFirstRun(home, [base.cwd])
  const run = runJobControlHost({
    tag: 'sigint-title', argv: base.argv, cwd: base.cwd, cols: 120, rows: 40, budgetSeconds: 90,
    env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_DAEMON_DIR: join(home, 'daemon'), MERCURY_CREDENTIAL_STORE: 'file', MERCURY_FULLSCREEN: '1' },
    steps: [
      { wait: 'host$', timeout: 15 }, { launch: true }, { wait: 'New Session', timeout: 45 },
      { send: '\r' }, { wait: 'Type a prompt', timeout: 30 }, { sleep: 1 }, { mark: 'armed' },
      { signal: 'SIGINT' }, { sleep: 3 }, { typeline: 'echo status-$?' }, { wait: 'status-130', timeout: 25 },
    ],
  })
  assert.equal(run.status, 0, `${run.stderr}; the job-control host (scripts/ui/jobcontrolHost.ts) did not finish cleanly, read its stderr above`)
  assert.equal(run.report?.endReason, 'steps-done', `${JSON.stringify(run.report)}; the steps did not all complete within the budget, so the cockpit did not reach the prompt or did not exit after SIGINT (the shell never printed status-130)`)
  const from = mark(run.report!, 'armed')!.teeOffset
  const before = run.tee.subarray(0, from).toString()
  const after = run.tee.subarray(from).toString()
  assert.ok(/\x1b\][02];[^\x07]+Mercury/.test(before), 'the cockpit set its terminal title; the boot face never wrote an OSC 0 or OSC 2 title ending in Mercury before the SIGINT, check where src sets the terminal title')
  assert.ok(after.includes('\x1b]0;\x07'), 'SIGINT clears the title through terminal restoration; the OSC 0 empty-title write is missing after SIGINT, check the SIGINT handler in src/platform/processes/gracefulShutdown.ts and cleanupTerminalModes in src/screen/renderer/terminal-session/shutdownRestoration.ts')
  assert.ok(after.includes('\x1b]111\x07'), 'SIGINT restores the terminal background; the OSC 111 write is missing after SIGINT, check restoreOriginalBackground as called from cleanupTerminalModes in src/screen/renderer/terminal-session/shutdownRestoration.ts')
  assert.ok(after.includes('\x1b[?1049l'), 'SIGINT leaves the alternate screen; the 1049l write is missing after SIGINT, check cleanupTerminalModes in src/screen/renderer/terminal-session/shutdownRestoration.ts and the SIGINT handler in src/platform/processes/gracefulShutdown.ts')
  console.log('PASS tui-12 SIGINT exits 130 after restoring title, background and alternate screen')
} finally {
  cleanupScenario('boot-face')
  removeScratch(home)
}
