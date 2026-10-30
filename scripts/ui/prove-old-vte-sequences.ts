import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { cleanupScenario, scenario } from './renderScenarios.ts'
import { runJobControlHost } from './jobcontrolHost.ts'
import { enterEditorBytes, rawModeDisarmBytes } from '../../src/ink/root/screen-session.ts'

const home = mkdtempSync(join(tmpdir(), 'vte-sequences-'))
process.env.MERCURY_CONFIG_DIR = home
const base = scenario('boot-face', 120, 40) as { argv: string[]; cwd: string }
try {
  for (const version of ['5002', '5299', '5300', '7600', undefined]) {
    if (version === undefined) delete process.env.VTE_VERSION
    else process.env.VTE_VERSION = version
    const safe = version === undefined || Number(version) >= 5300
    for (const bytes of [rawModeDisarmBytes(), enterEditorBytes({ altActive: true, mouseTracking: true })]) {
      assert.equal(bytes.includes('\x1b[>4m'), safe, `modifyOtherKeys reset at ${version}`)
      assert.equal(bytes.includes('\x1b[<u'), safe, `kitty reset at ${version}`)
    }
  }
  for (const version of ['5002', '5300']) {
    const cfg = join(home, version)
    seedFirstRun(cfg, [base.cwd])
    const run = runJobControlHost({
      tag: `vte-${version}`, argv: base.argv, cwd: base.cwd, cols: 120, rows: 40, budgetSeconds: 90,
      env: { ...process.env, VTE_VERSION: version, MERCURY_CONFIG_DIR: cfg, MERCURY_DAEMON_DIR: join(cfg, 'daemon'), MERCURY_CREDENTIAL_STORE: 'file' },
      steps: [{ wait: 'host$', timeout: 15 }, { launch: true }, { wait: 'Health Check', timeout: 45 },
        { send: '\r' }, { wait: 'Type a prompt', timeout: 30 }, { sleep: 1 }, { signal: 'SIGTERM' },
        { sleep: 3 }, { typeline: 'echo done-$((40+2))' }, { wait: 'done-42', timeout: 25 }],
    })
    assert.equal(run.status, 0, run.stderr)
    assert.equal(run.report?.endReason, 'steps-done', JSON.stringify(run.report))
    for (const sequence of ['\x1b[>0q', '\x1b[>4m', '\x1b[<u']) {
      assert.equal(run.tee.includes(sequence), version === '5300', `VTE ${version} ${JSON.stringify(sequence)}`)
    }
  }
  console.log('PASS tui-08 VTE below 0.53 receives no unsafe identity query or extended keyboard reset')
} finally {
  cleanupScenario('boot-face')
  rmSync(home, { recursive: true, force: true })
}
