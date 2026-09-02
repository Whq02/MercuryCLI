#!/usr/bin/env bun
// prove-deployed-assets — the /health deployed-asset drift leg.
// Drives the PURE assessment core (healthDeployedAssets.ts —
// node:fs/path only, bun-loadable by design) with hermetic fixture homes:
// byte-match ⇒ ok · byte-drift ⇒ stale + redeploy fix · byte-patcher
// artifacts (patches.json/.d) ⇒ warn + delete fix · empty home ⇒ info. Also
// pins the REAL repo pair sources present and the launcher free of any
// banner-script or python dependency (mirrors the ops-suite ratchet from the
// src side, so a health-suite-only run still catches a reintroduction).
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assessDeployedAssets,
  DEPLOYED_ASSET_PAIRS,
  RETIRED_HOME_ARTIFACTS,
} from '../../src/utils/healthDeployedAssets.ts'

let failures = 0
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failures++
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const repoRoot = join(import.meta.dir, '..', '..')

// ── fixture scaffolding ──────────────────────────────────────────────────────
// A fake "repo" + fake "home" so every branch is exercised without touching
// the operator's real config home.
const fxRepo = mkdtempSync(join(tmpdir(), 'doctor-assets-repo-'))
const fxHome = mkdtempSync(join(tmpdir(), 'doctor-assets-home-'))
process.on('exit', () => {
  rmSync(fxRepo, { recursive: true, force: true })
  rmSync(fxHome, { recursive: true, force: true })
})
mkdirSync(join(fxRepo, 'scripts', 'ops'), { recursive: true })
mkdirSync(join(fxRepo, 'assets', 'splash'), { recursive: true })
mkdirSync(join(fxHome, 'bin'), { recursive: true })
const LAUNCHER_BYTES = '#!/usr/bin/env bash\necho mercury-launcher-v2\n'
const SPLASH_BYTES = 'console.log("mercury-splash-v2")\n'
const CORE_BYTES = 'export const core = "mercury-splash-core-v1"\n'
writeFileSync(join(fxRepo, 'scripts/ops/launcher-mercury.sh'), LAUNCHER_BYTES)
writeFileSync(join(fxRepo, 'assets/splash/mercury-splash.mjs'), SPLASH_BYTES)
writeFileSync(join(fxRepo, 'assets/splash/splash-core.mjs'), CORE_BYTES)

console.log('\n── byte-match ⇒ ok ─────────────────────────────────────────────')
writeFileSync(join(fxHome, 'bin/mercury'), LAUNCHER_BYTES)
writeFileSync(join(fxHome, 'splash.mjs'), SPLASH_BYTES)
writeFileSync(join(fxHome, 'splash-core.mjs'), CORE_BYTES)
{
  const a = assessDeployedAssets(fxRepo, fxHome)
  check('matching copies ⇒ ok', a.status === 'ok', a.evidence)
  check(
    'evidence names all three pairs (ruling 1: the splash deploys as driver + core)',
    a.evidence.includes('launcher') && a.evidence.includes('splash') && a.evidence.includes('splash-core'),
  )
  check('no drifted rows', a.drifted.length === 0)
  check('no fix on ok', a.fix === undefined)
}

console.log('\n── splash-core drift ⇒ stale + splash redeploy fix ─────────────')
writeFileSync(join(fxHome, 'splash-core.mjs'), 'export const core = "STALE-OLD-CORE"\n')
{
  const a = assessDeployedAssets(fxRepo, fxHome)
  check('drifted splash-core ⇒ stale', a.status === 'stale', a.status)
  check(
    'the drifted core row redeploys through the ONE splash deploy',
    a.drifted.length === 1 && a.drifted[0]!.label === 'splash-core' && a.drifted[0]!.redeploy.includes('scripts/splash/deploy.sh'),
  )
}
writeFileSync(join(fxHome, 'splash-core.mjs'), CORE_BYTES) // restore

console.log('\n── byte-drift ⇒ stale + redeploy fix ───────────────────────────')
writeFileSync(join(fxHome, 'bin/mercury'), '#!/usr/bin/env bash\necho STALE-OLD-LAUNCHER\n')
{
  const a = assessDeployedAssets(fxRepo, fxHome)
  check('drifted launcher ⇒ stale', a.status === 'stale', a.status)
  check('evidence says DRIFTED', a.evidence.includes('DRIFTED'))
  check('fix names the redeploy script', (a.fix ?? '').includes('deploy-launcher.sh'))
  check(
    'drifted row carries the redeploy command',
    a.drifted.length === 1 && a.drifted[0]!.redeploy.includes('deploy-launcher.sh'),
  )
  check('splash pair still reads matched', a.evidence.includes('splash + splash-core byte-match'))
}
writeFileSync(join(fxHome, 'bin/mercury'), LAUNCHER_BYTES) // restore

console.log('\n── retired artifacts ⇒ warn + delete fix ───────────────────────')
mkdirSync(join(fxHome, 'patches.d'), { recursive: true })
writeFileSync(join(fxHome, 'patches.json'), '{}')
{
  const a = assessDeployedAssets(fxRepo, fxHome)
  check('cruft ⇒ warn (matches stay ok-grade)', a.status === 'warn', a.status)
  check('cruft named', a.cruft.includes('patches.d') && a.cruft.includes('patches.json'))
  check('fix says delete', (a.fix ?? '').toLowerCase().includes('delete'))
}

console.log('\n── drift DOMINATES cruft ───────────────────────────────────────')
writeFileSync(join(fxHome, 'splash.mjs'), 'console.log("OLD")\n')
{
  const a = assessDeployedAssets(fxRepo, fxHome)
  check('drift + cruft ⇒ stale (worse wins)', a.status === 'stale', a.status)
  check('cruft still surfaced in evidence', a.evidence.includes('patches.json'))
}
rmSync(join(fxHome, 'patches.d'), { recursive: true, force: true })
rmSync(join(fxHome, 'patches.json'))
writeFileSync(join(fxHome, 'splash.mjs'), SPLASH_BYTES) // restore

console.log('\n── R-4: the splash-action markers survive in the real launcher ─')
{
  const launcher = readFileSync(join(repoRoot, 'scripts/ops/launcher-mercury.sh'), 'utf8')
  check('MERCURY-SPLASH-ACTION-START marker present', launcher.includes('# MERCURY-SPLASH-ACTION-START'))
  check('MERCURY-SPLASH-ACTION-END marker present', launcher.includes('# MERCURY-SPLASH-ACTION-END'))
  check('the args=() fallback anchor is byte-intact', /^args=\(\)$/m.test(launcher))
  // The canonical block splash-deploy INJECTS must be byte-equal to the
  // launcher's managed block — a divergent canonical block (the F-5 class:
  // a stale $MERCURY_HOME assignment under the launcher's set -u) would BRICK
  // every boot the moment /health's own remedy runs splash-deploy.
  const canonicalBlock = readFileSync(join(repoRoot, 'assets/splash/launcher-action-block.sh'), 'utf8').trimEnd()
  const managed = launcher.slice(
    launcher.indexOf('# MERCURY-SPLASH-ACTION-START'),
    launcher.indexOf('# MERCURY-SPLASH-ACTION-END') + '# MERCURY-SPLASH-ACTION-END'.length,
  )
  check('canonical action block is byte-equal to the launcher managed block (F-5 pin)', managed === canonicalBlock)
  // the block consumes ONLY the exit code the launcher captured — a
  // defaulted expansion keeps it viable under set -u in both launcher
  // generations, and NO line reads a splash-written file (the retired txt
  // reader is what killed every 1.5.4 Windows boot in the cmd twin of this
  // block).
  check(
    'the block gates on the defaulted exit-code capture (set -u safe)',
    canonicalBlock.includes('[ -n "${MERCURY_SA_EXIT:-}" ]'),
  )
  check(
    'the block reads NO splash-written file (BM-30 ratchet)',
    !canonicalBlock.includes('read -r') && !canonicalBlock.includes('splash-action.json"') && !canonicalBlock.includes('SPLASH_ACTION_FILE='),
  )
}

console.log('\n── empty home ⇒ info (direct-run setup, never a fault) ─────────')
{
  const bare = mkdtempSync(join(tmpdir(), 'doctor-assets-bare-'))
  const a = assessDeployedAssets(fxRepo, bare)
  check('nothing deployed ⇒ info', a.status === 'info', a.status)
  check('evidence says drift n/a', a.evidence.includes('n/a'))
  rmSync(bare, { recursive: true, force: true })
}

console.log('\n── the real repo carries every pair source ─────────────────────')
for (const pair of DEPLOYED_ASSET_PAIRS) {
  check(`repo canon exists: ${pair.repoRel}`, existsSync(join(repoRoot, pair.repoRel)))
}

console.log('\n── src-side ratchet: the retired fallbacks stay retired ────────')
{
  const launcher = readFileSync(join(repoRoot, 'scripts/ops/launcher-mercury.sh'), 'utf8')
  const live = launcher
    .split('\n')
    .filter(l => !/^\s*#/.test(l))
    .join('\n')
  check('no live welcome.py reference in the launcher', !live.includes('welcome.py'))
  check('no live python dependency in the launcher', !live.includes('python'))
  check(
    'RETIRED_HOME_ARTIFACTS names exactly the byte-patcher pair',
    RETIRED_HOME_ARTIFACTS.length === 2,
  )
}

console.log()
if (failures > 0) {
  console.log(`❌ DEPLOYED-ASSETS PROOF RED (${failures})`)
  process.exit(1)
}
console.log('✅ DEPLOYED-ASSETS PROOF PASS')
