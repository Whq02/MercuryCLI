#!/usr/bin/env bun
// ============================================================================
//  scripts/consistency-census/prove-manifest-noncircular.ts — W7-D (UN-50/51):
//  the release manifest makes zero impossible claims.
//
//  §A the layout carries NO hash/size row for manifest.json; the manifest is
//     identified explicitly (manifestMember, digest-free by L20).
//  §B the package.mjs write-back leaves EVERY member claim verifiable
//     against final staged bytes (re-enumeration after write-back matches).
//  §C the twin payload-digest law survives: payloadDigest is manifest-
//     exclusive and unchanged by the write-back.
//  §D the shipped decoder consumes the layout unchanged (describePayload
//     arm 1, schema 1 — reader compatibility audited: no reader ever
//     consumed the self row).
// ============================================================================
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error — .mjs module without types (the packager's own dialect)
import { payloadDigestOf, releaseLayoutSection } from '../release/payloadContract.mjs'

let failed = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failed++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
const sha256 = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex')

const staged = mkdtempSync(join(tmpdir(), 'unison-w7-staged-'))
writeFileSync(join(staged, 'mercury.mjs'), '// primary fixture bundle\n')
writeFileSync(join(staged, 'mercury'), '#!/bin/sh\n')
writeFileSync(
  join(staged, 'manifest.json'),
  JSON.stringify({ version: '0.0.0-fixture', target: 'darwin-arm64' }, null, 2) + '\n',
)
const layout = releaseLayoutSection(staged, 'darwin-arm64', { floorVersion: '0.0.0' })

// §A — no self claim
check('§A no manifest row in hash-bearing members[]', !layout.members.some((m: { path: string }) => m.path === 'manifest.json'))
check('§A the manifest is identified digest-free', layout.manifestMember?.path === 'manifest.json' && layout.manifestMember?.role === 'manifest' && !('sha256' in layout.manifestMember) && !('bytes' in layout.manifestMember))

// §B — the write-back leaves every claim verifiable at FINAL bytes
const manifestPath = join(staged, 'manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
manifest.releaseLayout = layout
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
const everyClaimHolds = layout.members.every((m: { path: string; bytes?: number; sha256?: string; treeDigest?: string }) => {
  const full = join(staged, m.path)
  if (m.treeDigest !== undefined) return payloadDigestOf(full) === m.treeDigest
  return statSync(full).size === m.bytes && sha256(full) === m.sha256
})
check('§B every member claim verifies against FINAL staged bytes', everyClaimHolds)
const relayout = releaseLayoutSection(staged, 'darwin-arm64', { floorVersion: '0.0.0' })
check('§B re-enumeration after write-back is layout-stable', JSON.stringify(relayout.members) === JSON.stringify(layout.members))

// §C — twin law
check('§C payloadDigest is manifest-exclusive and survives the write-back', payloadDigestOf(staged) === layout.payloadDigest && relayout.payloadDigest === layout.payloadDigest)

// §D — the shipped decoder still decodes arm 1 (schema 1 stands)
const { describePayload } = await import('../../src/services/privateChannel/channelCore.ts')
const described = describePayload(manifest, ['mercury.mjs', 'mercury', 'manifest.json'], null)
check('§D describePayload decodes the non-circular layout (arm 1)', described.state === 'ok' && described.descriptor.generation === 'release-layout' && described.descriptor.primary === 'mercury.mjs', described.state === 'ok' ? described.descriptor.generation : described.note)

console.log(failed === 0 ? '\n ✅ NON-CIRCULAR MANIFEST CONTRACT HOLDS' : `\n ❌ ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
