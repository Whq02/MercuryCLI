#!/usr/bin/env node
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

const manifestPath = join(staged, 'manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
manifest.releaseLayout = layout
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

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
