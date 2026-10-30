import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { cleanupScenario, scenario } from './renderScenarios.ts'
import { runJobControlHost, mark } from './jobcontrolHost.ts'

const home = mkdtempSync(join(tmpdir(), 'sigint-restore-'))
process.env.MERCURY_CONFIG_DIR = home
const base = scenario('boot-face', 120, 40) as { argv: string[]; cwd: string }
try {
  seedFirstRun(home, [base.cwd])
  const run = runJobControlHost({
    tag: 'sigint-title', argv: base.argv, cwd: base.cwd, cols: 120, rows: 40, budgetSeconds: 90,
    env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_DAEMON_DIR: join(home, 'daemon'), MERCURY_CREDENTIAL_STORE: 'file', MERCURY_FULLSCREEN: '1' },
    steps: [
      { wait: 'host$', timeout: 15 }, { launch: true }, { wait: 'Health Check', timeout: 45 },
      { send: '\r' }, { wait: 'Type a prompt', timeout: 30 }, { sleep: 1 }, { mark: 'armed' },
      { signal: 'SIGINT' }, { sleep: 3 }, { typeline: 'echo status-$?' }, { wait: 'status-130', timeout: 25 },
    ],
  })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.report?.endReason, 'steps-done', JSON.stringify(run.report))
  const from = mark(run.report!, 'armed')!.teeOffset
  const before = run.tee.subarray(0, from).toString()
  const after = run.tee.subarray(from).toString()
  assert.ok(/\x1b\][02];[^\x07]+Mercury/.test(before), 'the cockpit set its terminal title')
  assert.ok(after.includes('\x1b]0;\x07'), 'SIGINT clears the title through terminal restoration')
  assert.ok(after.includes('\x1b]111\x07'), 'SIGINT restores the terminal background')
  assert.ok(after.includes('\x1b[?1049l'), 'SIGINT leaves the alternate screen')
  console.log('PASS tui-12 SIGINT exits 130 after restoring title, background and alternate screen')
} finally {
  cleanupScenario('boot-face')
  rmSync(home, { recursive: true, force: true })
}
