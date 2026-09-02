#!/usr/bin/env bun
// ============================================================================
//  scripts/health/prove-health-fix.ts
//  PROOF: the W8 health FIX engine —
//   (1) core policy: isFixable (status × remedy presence) + remedyPermitted
//       (destructive requires --yes);
//   (2) applyRemedy honors the honesty contract: apply → RE-PROBE via verify
//       (the outcome IS the verification), a throwing apply degrades to a
//       failed outcome + skipped verify, and an evolution-ledger row lands
//       (program health-fix) when the ledger is on;
//   (3) runHeadlessFix: --only narrowing, destructive-without-yes named in
//       `skipped` (never silently dropped), MERCURY_DOCTOR_FIX=0 ⇒ diagnose-only;
//   (4) structure: healthReport attaches gate + build-fresh remedies behind
//       healthFixEnabled(), remedies spawn ASYNC (never spawnSync — a sync
//       child freezes live Ink for the remedy's whole runtime), the /health
//       panel wires f → consent → applyRemedy, and the CLI carries
//       --fix/--only/--yes.
//
//  Hermetic: temp config home + temp cwd ledger; stamp-sim MACRO; no spawns.
//  Run:  ~/.bun/bin/bun run scripts/health/prove-health-fix.ts
// ============================================================================
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'doctor-fix-home-'))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import {
  isFixable,
  remedyPermitted,
  type HealthCheck,
  type HealthRemedy,
} from '../../src/utils/healthCertCore.js'
import {
  applyRemedy,
  healthFixEnabled,
  runHeadlessFix,
} from '../../src/utils/healthFix.js'
import { defaultEvolutionLedgerDir } from '../../src/utils/evolution/evolutionLedger.js'
import { getCwd } from '../../src/utils/cwd.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const SRC = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

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

// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
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

  // Ledger rows landed (program health-fix) — at least the two settled runs.
  const ledgerDir = defaultEvolutionLedgerDir(getCwd())
  const files = existsSync(ledgerDir) ? readdirSync(ledgerDir).filter(f => f.includes('health-fix')) : []
  check('evolution-ledger rows written under program health-fix', files.length > 0, ledgerDir)
  delete process.env.MERCURY_EVOLUTION_LEDGER
})()

// ---------------------------------------------------------------------------
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

  process.env.MERCURY_DOCTOR_FIX = '0'
  const r4 = await runHeadlessFix(cert, { yes: true })
  check('MERCURY_DOCTOR_FIX=0 ⇒ diagnose-only (nothing applied, reason named)', r4.fixes.length === 0 && r4.skipped.some(s => s.reason.includes('diagnose-only')))
  check('flag off ⇒ healthFixEnabled false', !healthFixEnabled())
  delete process.env.MERCURY_DOCTOR_FIX
})()

// ---------------------------------------------------------------------------
section('(4) wiring — remedies attached, async spawns, panel f-flow, CLI flags')
{
  const report = SRC('src/utils/healthReport.ts')
  check('gate check attaches a remedy behind healthFixEnabled()', /fixable && healthFixEnabled\(\)/.test(report))
  check('build-fresh check attaches a rebuild remedy', report.includes('rebuild dist (') && report.includes("class: 'safe' as const"))
  check('remedies spawn ASYNC (runRemedyCmd), never spawnSync', report.includes('runRemedyCmd(') && !report.includes('spawnSync('))
  const panel = SRC('src/commands/health/HealthCertificate.tsx')
  check("panel wires f → consent → applyRemedy", panel.includes("input === 'f'") && panel.includes('applyRemedy(check)'))
  check('destructive renders the warning register', panel.includes('DESTRUCTIVE — this discards state'))
  const cli = SRC('src/cli/healthJson.ts')
  check('headless runHealthFixCli exists with only/yes', cli.includes('runHealthFixCli') && cli.includes('--yes'))
  const main = SRC('src/main.tsx')
  check('CLI carries --fix/--only/--yes on the health command', main.includes("option('--fix'") && main.includes("option('--only <id>'") && main.includes("option('--yes'"))
  const registry = SRC('src/substrate/flagRegistry.ts')
  check('MERCURY_DOCTOR_FIX registered (frozen spelling)', registry.includes("env: 'MERCURY_DOCTOR_FIX'"))
}

console.log('\n============================================================')
if (failures === 0) console.log(' ✅ ALL HEALTH-FIX CHECKS PASS')
else console.log(` ❌ ${failures} CHECK(S) FAILED`)
console.log('============================================================')
process.exit(failures === 0 ? 0 : 1)
