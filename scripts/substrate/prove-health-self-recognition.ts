// ============================================================================
//  prove-health-self-recognition — /health self-recognition.
//
//  The guarded class: a doctor that assumes a store install falls through to
//  'unknown' for a source build, fetches foreign versions from a foreign
//  endpoint ('Failed to fetch versions'), and flags an UNRELATED bare stamp
//  as a duplicate of itself.
//  Every probe is Mercury-honest, unconditionally:
//    · self-recognition  — installationType === 'source-build'   (healthDiagnostic)
//    · config method     — 'source build (n/a)', never a leaked 'global'
//    · no false dupes    — detectMultipleInstallations() === []  for the fork
//    · no npm-perm probe — hasUpdatePermissions stays null (no shell-out)
//    · no version fetch  — getNpmDistTags/getGcsDistTags → {null,null}, no network
//    · no remote changelog — the fetch pipeline is REMOVED; release notes are the
//                          BUNDLED Mercury changelog (src/constants/changelog.ts)
//
//  COVERAGE NOTE (honest): this proof drives the one loyalty branch whose
//  module is loadable under bun-run — releaseNotes — under BOTH stamps
//  (stamp-independence). healthDiagnostic.ts and autoUpdater.ts CANNOT be imported under
//  `bun run`: their app-graph reaches modules using the build-time `feature()`
//  macro from `bun:bundle` (voice/*) which bun rejects outside a build, and
//  the feature-gate module's BLOCKS_ON_INIT — neither overridable at runtime. Those
//  branches are verified by (1) a clean `bun run build.ts` (compiles the real
//  branches) and (2) RENDER-VERIFY of the /health screen (the mandated gate for
//  any TUI change). This proof does NOT fake-assert what it cannot load.
//
//  READ-ONLY, no network.
// ============================================================================

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAllReleaseNotes, getStoredChangelog } from '../../src/utils/releaseNotes.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The bundled changelog must carry a section for the version the package
// declares: the release packager refuses to ship without it.
const PACKAGE_VERSION = (JSON.parse(readFileSync(join(import.meta.dir, '../../package.json'), 'utf8')) as { version: string }).version

let fail = 0
function check(label: string, cond: boolean): void {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`)
  if (!cond) fail = 1
}

console.log('============================================================')
console.log(' /health self-recognition — proof')
console.log('============================================================')


// ── PROOF 1 — release notes are the BUNDLED Mercury changelog ────────────────
// (the one loyalty branch whose module loads under bun-run — releaseNotes has
// no feature()/feature-gate app-graph dependency.)
console.log('\n[1] release notes are bundled Mercury notes (no fetch, no disk cache)')
{
  const t0 = Date.now()
  const changelog = await getStoredChangelog()
  const elapsed = Date.now() - t0
  // A network GET or even a disk read would show up here; bundled is instant.
  check(`getStoredChangelog() resolves instantly (${elapsed}ms < 400)`, elapsed < 400)
  check(
    `bundled changelog is Mercury's own (names Mercury, carries ## ${PACKAGE_VERSION})`,
    changelog.includes('Mercury') && changelog.includes(`## ${PACKAGE_VERSION}`),
  )
  const parsed = getAllReleaseNotes(changelog)
  check(
    'parseable: getAllReleaseNotes() yields ≥1 versioned section with notes',
    parsed.length >= 1 && (parsed[0]?.[1].length ?? 0) >= 1,
  )
}

// ── PROOF 2 — the compat-changelog fetch machinery is REMOVED (structural) ──────
// The sweep deleted the axios pipeline + upstream URLs outright;
// absence is the strongest no-fetch guarantee (nothing left to mis-route).
console.log('\n[2] the compat-changelog fetch pipeline is REMOVED (structural)')
{
  const src = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'utils', 'releaseNotes.ts'),
    'utf8',
  )
  check('no axios import in releaseNotes.ts', !src.includes('axios'))
  check('no anthropics/claude-code URL', !src.includes('anthropics/claude-code'))
  check('no raw.githubusercontent fetch target', !src.includes('raw.githubusercontent'))
  check('the retired fetchAndStoreChangelog symbol is gone', !src.includes('fetchAndStoreChangelog'))
}

console.log('\n============================================================')
console.log(fail === 0 ? ' ✅ HEALTH-LOYALTY PROOF PASS' : ' ❌ HEALTH-LOYALTY PROOF FAILED')
console.log('  (healthDiagnostic.ts / autoUpdater.ts fork branches:')
console.log('   build-compiled + RENDER-VERIFY — not bun-loadable, see header.)')
console.log('============================================================')
process.exit(fail)
