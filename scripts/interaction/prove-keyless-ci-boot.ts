#!/usr/bin/env bun

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

let failures = 0
const check = (label: string, cond: boolean, detail = '', hint = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` — ${hint}` : ''}`)
}

console.log('============================================================')
console.log(' keyless CI boot — the login cockpit, never a silent wedge')
console.log('============================================================')


console.log('\n── §2 REAL BINARY: CI=true, zero credentials, seeded home ───')
{
  const BIN = 'dist/mercury.mjs'
  const scratch = mkdtempSync(join(tmpdir(), 'ci-keyless-'))
  const home = join(scratch, 'pty-home')
  const seedEnv = { ...process.env }
  delete seedEnv.ANTHROPIC_API_KEY
  spawnSync(process.execPath, ['run', 'scripts/lib/firstRunSeed.ts', home, process.cwd()], {
    env: seedEnv,
  })

  const out = join(scratch, 'boot.json')
  const cfg = {
    cols: 120,
    rows: 40,
    total: 200,
    argv: ['node', BIN],
    out,
    cwd: process.cwd(),
    sends: [
      { atTick: 999, awaitText: 'no sign-in yet', minTick: 5, awaitSettleTicks: 2, data: '', mark: 'boot' },
    ],
  }
  const cfgPath = join(scratch, 'boot-cfg.json')
  writeFileSync(cfgPath, JSON.stringify(cfg))

  const env = { ...process.env }
  delete env.ANTHROPIC_API_KEY
  delete env.MERCURY_OAUTH_TOKEN
  delete env.MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR
  const res = spawnSync('/usr/bin/python3', ['scripts/ui/vshot.py', cfgPath], {
    encoding: 'utf-8',
    timeout: vshotBudgetMs(90_000),
    env: {
      ...env,
      CI: 'true',
      TERM: 'xterm-256color',
      MERCURY_CONFIG_DIR: home,
      MERCURY_BOOT_PREFLIGHT: '0',
      MERCURY_LIVE_GLYPHS: '0',
      MERCURY_HEALTH_STATE_DIR: join(scratch, 'health'),
      MERCURY_DAEMON_DIR: join(scratch, 'daemon'),
    },
  })
  check('the capture completed (vshot exit 0 — the wedge is the exit-4 path)', res.status === 0, `exit=${res.status} ${String(res.stderr ?? '').slice(0, 200)}`, 'run bun run build.ts so dist/mercury.mjs exists, then rerun with CI_KEYLESS_KEEP_SCRATCH=1 and read the boot face in the kept scratch folder; with CI=true and no credentials the app must reach the boot face, not wait for sign-in')

  type Grid = Array<Array<{ c: string }>>
  const gridText = (g: Grid): string => g.map(row => row.map(c => c.c).join('')).join('\n')
  let boot = ''
  let painted = 0
  try {
    const payload = JSON.parse(readFileSync(out, 'utf8')) as {
      grid: Grid
      marks?: Array<{ label: string; grid: Grid }>
    }
    boot = gridText((payload.marks ?? []).find(m => m.label === 'boot')?.grid ?? payload.grid)
    painted = boot.replace(/\s/g, '').length
  } catch {
  }
  check('the face names the way in and says no provider is signed in (Logins/Keys, no sign-in yet)', boot.includes('Logins/Keys') && boot.includes('no sign-in yet'), '', 'the model line under the list reads NO_SIGN_IN_ROW (src/models/catalogue/computedDefault.ts) when no provider is signed in, and Logins/Keys is a row of the list (assets/splash/splash-core.mjs); the boot face must paint both on a keyless start')
  check('the face is live (New Session standing — never an error screen, never a wedge)', boot.includes('New Session'), '', 'the boot face did not paint New Session; rerun with CI_KEYLESS_KEEP_SCRATCH=1 and look at the captured boot.json grid for an error screen or an empty frame')
  check('a real paint, not a near-blank grid', painted > 200, `${painted} painted glyphs`, 'the captured frame is near blank; the app drew little or nothing before the capture ended, so check that dist/mercury.mjs is current and that the vshot capture saw the boot face')

  if (process.env.CI_KEYLESS_KEEP_SCRATCH !== '1') rmSync(scratch, { recursive: true, force: true })
  else console.log(`scratch kept: ${scratch}`)
}

console.log('')
if (failures > 0) {
  console.log(`❌ prove-keyless-ci-boot — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ prove-keyless-ci-boot — all checks pass')
