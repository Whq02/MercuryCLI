#!/usr/bin/env bun
// ============================================================================
//  scripts/interaction/prove-keyless-ci-boot.ts — a credential-less interactive
//  boot under CI=true paints the login cockpit, never a silent wedge.
//
//  getAnthropicApiKeyWithSource (utils/auth.ts) deliberately THROWS under
//  CI=true / NODE_ENV=test when no credential env exists — the loud failure
//  headless `-p` runs want. But three boot-path PROBES evaluated that throw
//  eagerly: the /login command description (commands loading — the swallowed
//  async-preAction rejection wedges boot alive-and-silent pre-paint), the
//  useApiKeyVerification useState initializer (a render error), and two
//  statusNoticeDefinitions isActive gates (the notice filter). On a hosted
//  runner CI=true is ambient, so every keyless PTY capture painted ZERO cells.
//
//  The guarded red: the zero-painted-cells class
//  across hosted shards. Every probe is non-throwing: no key means
//  'missing'/'none'/inactive — the login cockpit, not a detonation.
//
//  §1 the probes are non-throwing in source
//  §2 REAL BINARY: CI=true + zero credential env + seeded home boots to the
//     'Not logged in · Run /login' cockpit with a live composer
// ============================================================================

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' keyless CI boot — the login cockpit, never a silent wedge')
console.log('============================================================')

console.log('\n── §1 the probes are non-throwing in source ─────────────────')
{
  const read = (p: string): string => readFileSync(join(import.meta.dir, '..', '..', p), 'utf8')
  const auth = read('src/utils/auth.ts')
  check(
    'hasAnthropicApiKeyAuth cannot throw (the /login description probe)',
    /hasAnthropicApiKeyAuth\(\): boolean \{[\s\S]{0,600}?try \{[\s\S]{0,400}?\} catch \{\s*return false/.test(auth),
  )
  const hook = read('src/hooks/useApiKeyVerification.ts')
  check(
    'the useState initializer probe cannot throw (a render error otherwise)',
    /useState<VerificationStatus>\(\(\) => \{[\s\S]{0,900}?try \{[\s\S]{0,600}?\} catch \{/.test(hook),
  )
  const notices = read('src/utils/statusNoticeDefinitions.tsx')
  const guardedProbes = notices
    .split('isActive: ')
    .slice(1)
    .filter(body => body.slice(0, 700).includes('getAnthropicApiKeyWithSource'))
  check(
    'every notice isActive that reads the key source is try/caught',
    guardedProbes.length >= 2 && guardedProbes.every(body => body.slice(0, 700).includes('try {')),
    `${guardedProbes.length} probes`,
  )
}

console.log('\n── §2 REAL BINARY: CI=true, zero credentials, seeded home ───')
{
  const BIN = 'dist/mercury.mjs'
  const scratch = mkdtempSync(join(tmpdir(), 'ci-keyless-'))
  const home = join(scratch, 'pty-home')
  // Keyless seed: NO credential in the seeder env either, so the home carries
  // no customApiKeyResponses approval — the product boots with nothing.
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
      // STRICT: the login row must paint from boot with ZERO PTY input — a
      // missing needle is the exit-4 refusal (the wedge class), never a
      // deadline pass-through.
      // The keyless boot lands the FACE (the landing rule) and its Logins
      // row adverts the way in — the retired 'Not logged in · Run /login'
      // cockpit row died with the pre-face world.
      { atTick: 999, awaitText: 'sign in to providers', minTick: 5, awaitSettleTicks: 2, data: '', mark: 'boot' },
    ],
  }
  const cfgPath = join(scratch, 'boot-cfg.json')
  writeFileSync(cfgPath, JSON.stringify(cfg))

  // The EXACT failing shape from the hosted runner: CI=true ambient, no
  // credential env of any kind. Everything else pinned like every capture.
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
      MERCURY_DOCTOR_STATE_DIR: join(scratch, 'doctor'),
      MERCURY_DAEMON_DIR: join(scratch, 'daemon'),
    },
  })
  check('the capture completed (vshot exit 0 — the wedge is the exit-4 path)', res.status === 0, `exit=${res.status} ${String(res.stderr ?? '').slice(0, 200)}`)

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
    /* empty */
  }
  check('the Logins row adverts the way in (sign in to providers)', boot.includes('Logins') && boot.includes('sign in to providers'))
  check('the face is live (New Session standing — never an error screen, never a wedge)', boot.includes('New Session'))
  check('a real paint, not a near-blank grid', painted > 200, `${painted} painted glyphs`)

  if (process.env.CI_KEYLESS_KEEP_SCRATCH !== '1') rmSync(scratch, { recursive: true, force: true })
  else console.log(`scratch kept: ${scratch}`)
}

console.log('')
if (failures > 0) {
  console.log(`❌ prove-keyless-ci-boot — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ prove-keyless-ci-boot — all checks pass')
