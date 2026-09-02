#!/usr/bin/env node
// ============================================================================
//  scripts/consistency-census/repro-un50-manifest-selfrow.mjs — UN-50 expect-red
//  driver (D7: the release manifest hashes its own pre-final bytes).
//
//  Mechanism under test: releaseLayoutSection(stagedDir, …) enumerates every
//  staged member INCLUDING manifest.json (role 'manifest') with the bytes+
//  sha256 it has at enumeration time; package.mjs then writes the resulting
//  releaseLayout BACK INTO manifest.json — so the shipped manifest's own
//  members[] row records a size and digest the final file can never have
//  (L20: no circular artifact claim). payloadDigestOf correctly excludes the
//  manifest — the whole-payload digest stays honest; only the self row lies.
//
//    §A stage a minimal payload (manifest.json + primary) and take the
//       REAL releaseLayoutSection
//    §B write the layout back into manifest.json (the package.mjs shape)
//    §C REPRODUCED: the final manifest bytes contradict the self row
//    §D the twin law holds: payloadDigest (manifest-exclusive) is unchanged
//       by the write-back — the defect is ONLY the circular member row
//
//  Exit 0 = defect REPRODUCED (the recorded red for UN-50's before-state).
//  Exit 1 = not reproduced. Not part of the green gate (repro-*, not prove-*).
// ============================================================================
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { payloadDigestOf, releaseLayoutSection } from '../release/payloadContract.mjs'

let failed = 0
const check = (label, cond, detail = '') => {
  if (!cond) failed++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
const sha256 = p => createHash('sha256').update(readFileSync(p)).digest('hex')

// §A — a minimal staged payload through the REAL section owner
const staged = mkdtempSync(join(tmpdir(), 'unison-un50-staged-'))
writeFileSync(join(staged, 'mercury.mjs'), '// primary fixture bundle\n')
writeFileSync(
  join(staged, 'manifest.json'),
  JSON.stringify({ version: '0.0.0-fixture', target: 'darwin-arm64' }, null, 2) + '\n',
)
const layout = releaseLayoutSection(staged, 'darwin-arm64', { floorVersion: '0.0.0' })
const selfRow = layout.members.find(m => m.path === 'manifest.json')
check('§A the layout carries a manifest self row (role manifest)', selfRow?.role === 'manifest')
if (!selfRow) {
  console.log('\n NOT REPRODUCED — the layout no longer claims manifest bytes (the W7-D fix); prove-manifest-noncircular.ts owns the green law')
  process.exit(1)
}

// §B — the packager write-back shape (package.mjs releaseLayout amendment)
const manifestPath = join(staged, 'manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
manifest.releaseLayout = layout
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

// §C — the final bytes contradict the claim
const finalBytes = statSync(manifestPath).size
const finalSha = sha256(manifestPath)
const staleSize = selfRow.bytes !== finalBytes
const staleSha = selfRow.sha256 !== finalSha
check(
  '§C REPRODUCED: self row records pre-final size',
  staleSize,
  `claimed ${selfRow.bytes} B, final ${finalBytes} B`,
)
check('§C REPRODUCED: self row records pre-final sha256', staleSha)

// §D — the manifest-exclusive whole-payload digest is UNAFFECTED (twin law)
check(
  '§D payloadDigest excludes the manifest and survives the write-back',
  payloadDigestOf(staged) === layout.payloadDigest,
)

console.log(
  failed === 0
    ? '\n REPRODUCED — UN-50 red recorded (circular manifest self-claim)'
    : '\n NOT REPRODUCED',
)
process.exit(failed === 0 ? 0 : 1)
