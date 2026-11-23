#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'health-fix-home-'))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import {
  isFixable,
  remedyPermitted,
  type HealthCheck,
  type HealthRemedy,
} from '../../src/platform/health/healthCertCore.js'
import {
  applyRemedy,
  healthFixEnabled,
  runHeadlessFix,
} from '../../src/platform/health/healthFix.js'
import { getCwd } from '../../src/platform/files/cwd.js'
import { getFlagSpec } from '../../src/platform/substrate/flagRegistry.js'

let failures = 0
let fixAt = ''
const fixAtBySection: Record<string, string> = {
  '(1)': 'isFixable and remedyPermitted in src/platform/health/healthCertCore.ts, healthFixEnabled in src/platform/health/healthFix.ts',
  '(2)': 'applyRemedy in src/platform/health/healthFix.ts',
  '(3)': 'runHeadlessFix in src/platform/health/healthFix.ts',
  '(4)': 'the gate row in src/platform/health/sections/proofs.ts, the build-fresh row in src/platform/health/sections/identity.ts, the health command flags (--fix, --only, --yes) and MERCURY_HEALTH_FIX in FLAG_REGISTRY',
}
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  const hint = !cond && fixAt ? ` | to fix, change ${fixAt}` : ''
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}${hint}`)
}
function section(t: string): void {
  fixAt = fixAtBySection[t.slice(0, 3)] ?? ''
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const remedy = (over: Partial<HealthRemedy> = {}): HealthRemedy => ({
  plan: 'test remedy',
  class: 'safe',
  apply: async () => ({ ok: true, note: 'applied' }),
  verify: async () => ({ ok: true, note: 'verified fresh' }),
  ...over,
})
const mkCheck = (status: HealthCheck['status'], r?: HealthRemedy): HealthCheck => ({
  id: 'test',
  label: 'Test check',
  status,
  evidence: 'synthetic',
  ...(r ? { remedy: r } : {}),
})

console.log('============================================================')
console.log(' Health FIX engine (W8) — policy · honesty contract · headless')
console.log('============================================================')

section('(1) core policy — isFixable × remedyPermitted')
{
  check('fail + remedy ⇒ fixable', isFixable(mkCheck('fail', remedy())))
  check('stale + remedy ⇒ fixable', isFixable(mkCheck('stale', remedy())))
  check('warn + remedy ⇒ fixable', isFixable(mkCheck('warn', remedy())))
  check('ok + remedy ⇒ NOT fixable (nothing proven wrong)', !isFixable(mkCheck('ok', remedy())))
  check('unknown + remedy ⇒ NOT fixable (no evidence either way)', !isFixable(mkCheck('unknown', remedy())))
  check('fail without remedy ⇒ not fixable', !isFixable(mkCheck('fail')))
  check('safe permitted without --yes', remedyPermitted({ class: 'safe' }, { yes: false }))
  check('destructive REFUSED without --yes', !remedyPermitted({ class: 'destructive' }, { yes: false }))
  check('destructive permitted with --yes', remedyPermitted({ class: 'destructive' }, { yes: true }))
  check('fix engine on by default in a stamped build', healthFixEnabled())
}

section('(2) applyRemedy — verify is the outcome; throws degrade honestly')
await (async () => {
  process.env.MERCURY_EVOLUTION_LEDGER = '1'
  const calls: string[] = []
  const good = await applyRemedy(
    mkCheck(
      'fail',
      remedy({
        apply: async () => {
          calls.push('apply')
          return { ok: true, note: 'did the thing' }
        },
        verify: async () => {
          calls.push('verify')
          return { ok: true, note: 're-probed clean' }
        },
      }),
    ),
  )
  check('apply then verify, in order', calls.join(',') === 'apply,verify')
  check('outcome carries both notes', good.applied.note === 'did the thing' && good.verified?.note === 're-probed clean')

  const lying = await applyRemedy(
    mkCheck(
      'fail',
      remedy({
        apply: async () => ({ ok: true, note: 'claims success' }),
        verify: async () => ({ ok: false, note: 'still broken on re-probe' }),
      }),
    ),
  )
  check('a lying apply is exposed by verify', lying.applied.ok && lying.verified?.ok === false)

  const thrown = await applyRemedy(
    mkCheck(
      'fail',
      remedy({
        apply: async () => {
          throw new Error('exploded mid-apply')
        },
      }),
    ),
  )
  check('throwing apply ⇒ failed outcome, verify skipped', !thrown.applied.ok && thrown.verified === null && thrown.applied.note.includes('exploded'))

  delete process.env.MERCURY_EVOLUTION_LEDGER
})()

section('(3) runHeadlessFix — only/yes semantics, honest skips, flag off')
await (async () => {
  const cert = {
    sections: [
      {
        id: 's',
        title: 'S',
        checks: [
          { ...mkCheck('fail', remedy()), id: 'a' },
          { ...mkCheck('fail', remedy({ class: 'destructive' })), id: 'b' },
          { ...mkCheck('ok', remedy()), id: 'c' },
        ],
      },
    ],
  }
  const r1 = await runHeadlessFix(cert, { yes: false })
  check('safe fix applied', r1.fixes.some(f => f.id === 'a'))
  check('destructive skipped without --yes, NAMED', r1.skipped.some(s => s.id === 'b' && s.reason.includes('--yes')))
  check('healthy check untouched', !r1.fixes.some(f => f.id === 'c'))

  const r2 = await runHeadlessFix(cert, { yes: true })
  check('--yes unlocks the destructive fix', r2.fixes.some(f => f.id === 'b'))

  const r3 = await runHeadlessFix(cert, { only: 'b', yes: true })
  check('--only narrows to the named id', r3.fixes.length === 1 && r3.fixes[0]!.id === 'b')

  process.env.MERCURY_HEALTH_FIX = '0'
  const r4 = await runHeadlessFix(cert, { yes: true })
  check('MERCURY_HEALTH_FIX=0 ⇒ diagnose-only (nothing applied, reason named)', r4.fixes.length === 0 && r4.skipped.some(s => s.reason.includes('diagnose-only')))
  check('flag off ⇒ healthFixEnabled false', !healthFixEnabled())
  delete process.env.MERCURY_HEALTH_FIX
})()

section('(4) wiring — remedies attached, async spawns, panel f-flow, CLI flags')
{
  const fsF = await import('node:fs')
  const { execFileSync } = await import('node:child_process')
  const { gateVerdictPath, healthContext } = await import('../../src/platform/health/healthReport.ts')
  const { proofsChecks } = await import('../../src/platform/health/sections/proofs.ts')
  const { identityChecks } = await import('../../src/platform/health/sections/identity.ts')
  const project = mkdtempSync(join(tmpdir(), 'health-fix-gate-'))
  fsF.mkdirSync(join(project, 'scripts'), { recursive: true })
  fsF.writeFileSync(join(project, 'scripts', 'run-all-suites.sh'), '#!/bin/bash\nexit 1\n')
  const stateBefore = process.env.MERCURY_HEALTH_STATE_DIR
  process.env.MERCURY_HEALTH_STATE_DIR = join(project, 'state')
  fsF.mkdirSync(join(gateVerdictPath(), '..'), { recursive: true })
  fsF.writeFileSync(gateVerdictPath(), JSON.stringify({ ok: false, ranAt: new Date().toISOString(), pass: [], fail: ['fixture-suite'] }))
  const gateRow = proofsChecks({ ...(await healthContext()), cwd: project, head: { sha: null, branch: null, dirty: null } }).find(row => row.id === 'gate')
  const armed = await gateRow?.run()
  process.env.MERCURY_HEALTH_FIX = '0'
  const disarmed = await gateRow?.run()
  delete process.env.MERCURY_HEALTH_FIX
  check('gate check attaches a remedy behind healthFixEnabled()', armed?.status === 'fail' && armed.remedy?.class === 'safe' && disarmed?.status === 'fail' && disarmed.remedy === undefined, JSON.stringify({ armed: armed?.status, plan: armed?.remedy?.plan, disarmed: disarmed?.remedy?.plan }))
  const applying = armed?.remedy?.apply()
  const applied = await applying
  if (stateBefore === undefined) delete process.env.MERCURY_HEALTH_STATE_DIR
  else process.env.MERCURY_HEALTH_STATE_DIR = stateBefore
  check('remedies spawn ASYNC (runRemedyCmd), never spawnSync', applying instanceof Promise && applied?.ok === false && applied.note.startsWith('gate exited '), JSON.stringify(applied))
  const checkout = mkdtempSync(join(tmpdir(), 'health-fix-build-'))
  fsF.mkdirSync(join(checkout, 'src'))
  fsF.mkdirSync(join(checkout, 'dist'))
  fsF.writeFileSync(join(checkout, 'build.ts'), '')
  fsF.writeFileSync(join(checkout, 'src', 'a.ts'), 'export {}\n')
  fsF.writeFileSync(join(checkout, 'dist', 'mercury.mjs'), '')
  const yesterday = new Date(Date.now() - 86_400_000)
  fsF.utimesSync(join(checkout, 'dist', 'mercury.mjs'), yesterday, yesterday)
  const git = (...args: string[]): void => void execFileSync('git', ['-C', checkout, '-c', 'user.name=fixture', '-c', 'user.email=fixture@mercury.invalid', '-c', 'commit.gpgsign=false', ...args], { stdio: 'ignore' })
  git('init', '-q')
  git('add', 'build.ts', 'src/a.ts')
  git('commit', '-q', '-m', 'fixture')
  const entryBefore = process.argv[1]
  process.argv[1] = join(checkout, 'dist', 'mercury.mjs')
  const stale = await identityChecks(await healthContext()).find(row => row.id === 'build-fresh')?.run()
  process.argv[1] = entryBefore!
  check('build-fresh check attaches a rebuild remedy', stale?.status === 'stale' && stale.remedy?.class === 'safe' && stale.remedy.plan.startsWith('rebuild dist ('), JSON.stringify({ status: stale?.status, evidence: stale?.evidence, plan: stale?.remedy?.plan }))
  const { builtHelp } = await import('../lib/builtProduct.ts')
  const healthHelp = builtHelp('health')
  check('CLI carries --fix/--only/--yes on the health command', healthHelp.includes(' --fix ') && healthHelp.includes(' --only <id> ') && healthHelp.includes(' --yes '))
  check('MERCURY_HEALTH_FIX registered (frozen spelling)', getFlagSpec('MERCURY_HEALTH_FIX') !== undefined)
}

console.log('\n============================================================')
if (failures === 0) console.log(' ✅ ALL HEALTH-FIX CHECKS PASS')
else console.log(` ❌ ${failures} CHECK(S) FAILED`)
console.log('============================================================')
process.exit(failures === 0 ? 0 : 1)
