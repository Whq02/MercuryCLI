#!/usr/bin/env bun
// ============================================================================
//  scripts/updater/prove-channel-core.ts — the PURE channel core, decision by
//  decision (PRIVATE BETA RELEASE §9): tag grammar, ordering across private
//  counters, release filtering/selection, platform asset mapping, checksum
//  parsing, extracted-layout judgement, repo-slug derivation.
// ============================================================================
import {
  assetNameFor,
  BUNDLE_MEMBER_NAMES,
  CHECKSUM_MANIFEST_NAME,
  comparePrivateVersions,
  describePayload,
  formatPrivateVersion,
  judgeExtractedLayout,
  lookupChecksum,
  parsePrivateTag,
  parsePrivateVersion,
  repoSlugFromUrl,
  resolveBundleMember,
  selectBridgePrevious,
  selectRelease,
  type ChannelRelease,
} from '../../src/services/privateChannel/channelCore.js'

import { createHash } from 'node:crypto'

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) failures++
}
const createHashHex = (text: string): string => createHash('sha256').update(text).digest('hex')

console.log('── §1 tag grammar ──')
check('v1.2.0-beta.1 parses', JSON.stringify(parsePrivateTag('v1.2.0-beta.1')) === JSON.stringify({ major: 1, minor: 2, patch: 0, label: 'beta', counter: 1 }))
check('v10.20.30-beta.42 parses', parsePrivateTag('v10.20.30-beta.42')?.counter === 42)
for (const bad of ['v1.2.0', '1.2.0-beta.1', 'v1.2.0-beta-rc.1', 'v1.2.0-beta.0', 'v1.2.0-beta.01', 'v1.2-beta.1', 'archive/edgar-bugaudit', 'bench-corpus-v1', 'v1.2.0-beta.1.5', 'V1.2.0-beta.1', 'v1.2.0-beta.1 ']) {
  check(`rejects tag ${JSON.stringify(bad)}`, parsePrivateTag(bad) === null)
}
check('version form 1.2.0-beta.1 parses', parsePrivateVersion('1.2.0-beta.1') !== null)
check('version form rejects v-prefixed', parsePrivateVersion('v1.2.0-beta.1') === null)
check('format round-trips', formatPrivateVersion(parsePrivateTag('v3.4.5-beta.7')!) === '3.4.5-beta.7')
check('v1.0.0-beta.1 parses with the beta label', JSON.stringify(parsePrivateTag('v1.0.0-beta.1')) === JSON.stringify({ major: 1, minor: 0, patch: 0, label: 'beta', counter: 1 }))
check('a hyphenated label is not a channel tag', parsePrivateTag('v1.0.0-beta-2.1') === null)
check('labels order as semver identifiers: beta before rc', comparePrivateVersions(parsePrivateVersion('1.0.0-beta.9')!, parsePrivateVersion('1.0.0-rc.1')!) < 0)
check('counters order within a label', comparePrivateVersions(parsePrivateVersion('1.0.0-beta.1')!, parsePrivateVersion('1.0.0-beta.2')!) < 0)

console.log('── §2 ordering across private-beta counters ──')
const v = (s: string) => parsePrivateVersion(s)!
const pairsAsc: Array<[string, string]> = [
  ['1.1.0-beta.1', '1.2.0-beta.1'],
  ['1.2.0-beta.1', '1.2.0-beta.2'],
  ['1.2.0-beta.2', '1.2.0-beta.10'],
  ['1.2.0-beta.9', '1.2.1-beta.1'],
  ['1.9.9-beta.9', '1.10.0-beta.1'],
  ['1.10.0-beta.1', '2.0.0-beta.1'],
]
for (const [a, b] of pairsAsc) {
  check(`${a} < ${b}`, comparePrivateVersions(v(a), v(b)) < 0 && comparePrivateVersions(v(b), v(a)) > 0)
}
check('equal compares 0', comparePrivateVersions(v('1.2.0-beta.3'), v('1.2.0-beta.3')) === 0)

console.log('── §3 platform asset mapping (exactly one, honest gaps) ──')
check('linux/x64', assetNameFor('1.2.0-beta.1', 'linux', 'x64') === 'mercury-v1.2.0-beta.1-linux-x64.tar.gz')
check('darwin/arm64', assetNameFor('1.2.0-beta.1', 'darwin', 'arm64') === 'mercury-v1.2.0-beta.1-macos-arm64.tar.gz')
check('win32/x64', assetNameFor('1.2.0-beta.1', 'win32', 'x64') === 'mercury-v1.2.0-beta.1-windows-x64.zip')
check('darwin/x64 has no channel asset', assetNameFor('1.2.0-beta.1', 'darwin', 'x64') === null)
check('linux/arm64 has no channel asset', assetNameFor('1.2.0-beta.1', 'linux', 'arm64') === null)

console.log('── §4 release selection ──')
const rel = (tagName: string, over: Partial<ChannelRelease> = {}): ChannelRelease => ({
  tagName,
  isDraft: false,
  isPrerelease: true,
  assetNames: [
    `mercury-${tagName}-linux-x64.tar.gz`,
    `mercury-${tagName}-macos-arm64.tar.gz`,
    `mercury-${tagName}-windows-x64.zip`,
    CHECKSUM_MANIFEST_NAME,
  ],
  ...over,
})
const installed = v('1.1.0-beta.1')
{
  const s = selectRelease([rel('v1.2.0-beta.1'), rel('v1.1.0-beta.1')], installed, 'linux', 'x64')
  check('newest newer prerelease selected', s.state === 'update-available' && s.tag === 'v1.2.0-beta.1' && s.assetName === 'mercury-v1.2.0-beta.1-linux-x64.tar.gz')
}
{
  const s = selectRelease([rel('v1.2.0-beta.2'), rel('v1.2.0-beta.1'), rel('v1.1.0-beta.1')], installed, 'darwin', 'arm64')
  check('highest counter wins', s.state === 'update-available' && s.tag === 'v1.2.0-beta.2')
}
check('current when nothing newer', selectRelease([rel('v1.1.0-beta.1')], installed, 'linux', 'x64').state === 'current')
check('current when installed IS newest', selectRelease([rel('v1.2.0-beta.1')], v('1.2.0-beta.1'), 'linux', 'x64').state === 'current')
check('no-releases when only foreign tags', selectRelease([rel('bench-corpus-v1'), rel('v2.0')], installed, 'linux', 'x64').state === 'no-releases')
check('empty list is no-releases', selectRelease([], installed, 'linux', 'x64').state === 'no-releases')
check('drafts are ignored', selectRelease([rel('v1.3.0-beta.1', { isDraft: true }), rel('v1.1.0-beta.1')], installed, 'linux', 'x64').state === 'current')
{
  const s = selectRelease([rel('v1.2.0-beta.1', { isPrerelease: false })], installed, 'linux', 'x64')
  check('non-prerelease newest refused as malformed', s.state === 'malformed-release')
}
{
  const s = selectRelease([rel('v1.2.0-beta.1', { assetNames: [`mercury-v1.2.0-beta.1-linux-x64.tar.gz`] })], installed, 'linux', 'x64')
  check('missing SHA256SUMS refused as malformed', s.state === 'malformed-release' && s.note.includes(CHECKSUM_MANIFEST_NAME))
}
{
  const s = selectRelease([rel('v1.2.0-beta.1', { assetNames: [CHECKSUM_MANIFEST_NAME] })], installed, 'linux', 'x64')
  check('missing platform asset refused as malformed', s.state === 'malformed-release' && s.note.includes('linux-x64'))
}
check('unsupported platform is its own state', selectRelease([rel('v1.2.0-beta.1')], installed, 'darwin', 'x64').state === 'unsupported-platform')
{
  // an older malformed release must NOT poison selection of a newer sound one
  const s = selectRelease([rel('v1.2.0-beta.2'), rel('v1.2.0-beta.1', { isPrerelease: false })], installed, 'linux', 'x64')
  check('newest sound release wins despite older malformed sibling', s.state === 'update-available' && s.tag === 'v1.2.0-beta.2')
}

console.log('── §4b the bridge gate\'s previous reader (clean channel ⇒ first release) ──')
{
  const prevOf = (list: Array<{ tagName: string; isDraft: boolean }>, candidate = '1.0.0-beta.4') => selectBridgePrevious(list, candidate)
  check('an empty channel is a FIRST release (nothing to bridge from)', prevOf([]).state === 'first-release')
  check('only the candidate\'s own tag (the paired-trigger rerun) is still a first release', prevOf([{ tagName: 'v1.0.0-beta.4', isDraft: false }]).state === 'first-release')
  check('drafts do not count as shipped readers', prevOf([{ tagName: 'v1.0.0-beta.2', isDraft: true }]).state === 'first-release')
  check('unrelated tags are ignored by name (selectRelease parity)', prevOf([{ tagName: 'bench-corpus-v1', isDraft: false }, { tagName: 'archive/edgar-bugaudit', isDraft: false }]).state === 'first-release')
  const mixed = prevOf([
    { tagName: 'bench-corpus-v1', isDraft: false },
    { tagName: 'v1.0.0-beta.1', isDraft: false },
    { tagName: 'v1.0.0-beta.2', isDraft: false },
    { tagName: 'v1.0.0-beta.4', isDraft: false },
    { tagName: 'v1.0.0-beta.5', isDraft: true },
  ])
  check('the newest convention-valid non-draft release other than the candidate is the previous reader', mixed.state === 'previous' && mixed.tag === 'v1.0.0-beta.2')
  const ordered = prevOf([{ tagName: 'v1.0.0-beta.2', isDraft: false }, { tagName: 'v1.0.0-beta.3', isDraft: false }], '1.0.0-beta.4')
  check('ordering is the channel grammar, not list order', ordered.state === 'previous' && ordered.tag === 'v1.0.0-beta.3')
}

console.log('── §5 checksum manifest parsing ──')
const sums = (lines: string[]) => lines.join('\n') + '\n'
const HEX = 'a'.repeat(64)
check('exact entry found', JSON.stringify(lookupChecksum(sums([`${HEX}  file-a.tar.gz`, `${'b'.repeat(64)}  file-b.zip`]), 'file-a.tar.gz')) === JSON.stringify({ state: 'ok', sha256: HEX }))
check('binary-mode marker accepted', lookupChecksum(sums([`${HEX} *file-a.tar.gz`]), 'file-a.tar.gz').state === 'ok')
check('missing entry distinct', lookupChecksum(sums([`${HEX}  other.tar.gz`]), 'file-a.tar.gz').state === 'missing-entry')
check('duplicate entry distinct', lookupChecksum(sums([`${HEX}  file-a.tar.gz`, `${'c'.repeat(64)}  file-a.tar.gz`]), 'file-a.tar.gz').state === 'duplicate-entry')
check('malformed line refused', lookupChecksum(sums(['not a checksum line']), 'file-a.tar.gz').state === 'malformed')
check('short hash refused', lookupChecksum(sums([`${'a'.repeat(40)}  file-a.tar.gz`]), 'file-a.tar.gz').state === 'malformed')
check('empty manifest refused', lookupChecksum('', 'file-a.tar.gz').state === 'malformed')
check('prefix name does NOT match', lookupChecksum(sums([`${HEX}  file-a.tar.gz.bak`]), 'file-a.tar.gz').state === 'missing-entry')
check('uppercase hex normalized', (lookupChecksum(sums([`${'A'.repeat(64)}  f.tgz`]), 'f.tgz') as { sha256?: string }).sha256 === 'a'.repeat(64))

console.log('── §6 extraction envelope (root + manifest; NEVER a bundle census) ──')
check('single mercury/ root + manifest ok', judgeExtractedLayout(['mercury'], ['mercury.mjs', 'manifest.json', 'vendor']).state === 'ok')
check('the envelope never counts bundle-shaped members', judgeExtractedLayout(['mercury'], ['mercury.mjs', 'other.mjs', 'manifest.json', 'vendor']).state === 'ok')
check('wrong root refused', judgeExtractedLayout(['payload'], ['mercury.mjs', 'manifest.json']).state === 'unexpected-layout')
check('extra top entries refused', judgeExtractedLayout(['mercury', '__MACOSX'], ['mercury.mjs', 'manifest.json']).state === 'unexpected-layout')
check('empty extraction refused', judgeExtractedLayout([], []).state === 'unexpected-layout')
check('missing manifest member refused', judgeExtractedLayout(['mercury'], ['mercury.mjs']).state === 'unexpected-layout')
check('the reader recognises exactly one runtime bundle name', JSON.stringify(BUNDLE_MEMBER_NAMES) === JSON.stringify(['mercury.mjs']))
check('resolveBundleMember names the one runtime bundle (installed-dir census)', resolveBundleMember(['manifest.json', 'mercury.mjs']) === 'mercury.mjs' && resolveBundleMember(['other.mjs', 'manifest.json']) === null && resolveBundleMember(['manifest.json']) === null)

console.log('── §6b the ONE payload contract — describePayload, arm by arm ──')
const WIN_MEMBERS = ['mercury.mjs', 'manifest.json', 'vendor', 'mercury.cmd', 'mercury.ps1', 'splash.mjs', 'splash-core.mjs', 'verify-artifact.mjs', 'install.ps1', 'README-FIRST.md', 'INSTALLING.md', 'UPDATING.md', 'RELEASE-NOTES.md', 'NOTICES.md', 'mercury-vscode.vsix']
const SCHEMA2 = { schema: 2, name: 'mercury', version: '9.9.0-beta.2', bundle: 'mercury.mjs', bundleBytes: 21410918 }
{
  // arm 2 — schema 2 with a declared bundle and no releaseLayout section:
  // the declared bundle is primary.
  const d = describePayload(SCHEMA2, ['mercury.mjs', 'manifest.json', 'vendor', 'mercury'], null)
  check('schema-2 mercury-only accepted (declared primary)', d.state === 'ok' && d.descriptor.generation === 'schema2-single' && d.descriptor.primary === 'mercury.mjs' && d.descriptor.launcher === 'mercury')
  const win = describePayload(SCHEMA2, WIN_MEMBERS, null)
  check('the full windows member set decodes: one primary, no compatibility member, the cmd launcher', win.state === 'ok' && win.descriptor.primary === 'mercury.mjs' && win.descriptor.compatibility.length === 0 && win.descriptor.launcher === 'mercury.cmd')
  const absent = describePayload(SCHEMA2, ['other.mjs', 'manifest.json', 'vendor'], null)
  check('declared-primary-absent refused', absent.state === 'refused' && absent.note.includes('absent'))
  const alien = describePayload({ ...SCHEMA2, bundle: 'other.mjs' }, ['other.mjs', 'manifest.json'], null)
  check('unrecognized declared bundle refused', alien.state === 'refused')
}
{
  // arm 3 — no declaration to trust (version-only manifests): exactly the
  // one recognised bundle, else refuse.
  const mercuryOnly = describePayload({ version: '9.9.0-beta.1' }, ['mercury.mjs', 'manifest.json', 'vendor', 'mercury'], null)
  check('undeclared mercury-only accepted', mercuryOnly.state === 'ok' && mercuryOnly.descriptor.generation === 'legacy' && mercuryOnly.descriptor.primary === 'mercury.mjs')
  const otherOnly = describePayload({ version: '9.9.0-beta.1' }, ['other.mjs', 'manifest.json', 'vendor', 'mercury'], null)
  check('undeclared payload whose only bundle-shaped member is not the recognised name refused', otherOnly.state === 'refused')
  const none = describePayload({ version: '9.9.0-beta.1' }, ['manifest.json', 'vendor'], null)
  check('zero-bundle payload refused naming the one runtime bundle', none.state === 'refused' && none.note.includes('mercury.mjs'))
  const noVersion = describePayload({ schema: 2, bundle: 'mercury.mjs' }, ['mercury.mjs', 'manifest.json'], null)
  check('manifest without a version refused', noVersion.state === 'refused')
  const future = describePayload({ schema: 3, version: '2.0.0-beta.1', bundle: 'mercury.mjs' }, ['mercury.mjs', 'manifest.json'], null)
  check('unknown future schema without releaseLayout refused (shape-bounded decode)', future.state === 'refused')
}
{
  // arm 1 — the packager-declared release layout: declared roles are the
  // authority; a declared compatibility member is verified byte-exactly
  // against its declared sha256 or refuses.
  const rl = (over: object = {}) => ({
    schema: 2,
    version: '9.9.0-beta.3',
    bundle: 'mercury.mjs',
    releaseLayout: { schema: 1, primary: { path: 'mercury.mjs', sha256: 'f'.repeat(64) }, compatibility: [], launcher: 'mercury', ...over },
  })
  const d = describePayload(rl(), ['mercury.mjs', 'manifest.json', 'vendor', 'mercury'], null)
  check('releaseLayout declared primary accepted', d.state === 'ok' && d.descriptor.generation === 'release-layout' && d.descriptor.primary === 'mercury.mjs' && d.descriptor.launcher === 'mercury')
  const COMPAT_BYTES = "import './mercury.mjs'\n"
  const compatSha = createHashHex(COMPAT_BYTES)
  const declaredCompat = { compatibility: [{ path: 'compat.mjs', role: 'forwarder', sha256: compatSha }] }
  const withCompat = describePayload(rl(declaredCompat), ['mercury.mjs', 'compat.mjs', 'manifest.json', 'vendor', 'mercury'], COMPAT_BYTES)
  check('releaseLayout declared compatibility member accepted only byte-exactly', withCompat.state === 'ok' && withCompat.descriptor.primary === 'mercury.mjs' && withCompat.descriptor.compatibility.includes('compat.mjs'))
  const compatMismatch = describePayload(rl(declaredCompat), ['mercury.mjs', 'compat.mjs', 'manifest.json', 'vendor', 'mercury'], 'console.log("a full second runtime")\n')
  check('releaseLayout compatibility sha mismatch refused (a second runtime is never accepted)', compatMismatch.state === 'refused')
  const compatUnread = describePayload(rl(declaredCompat), ['mercury.mjs', 'compat.mjs', 'manifest.json', 'vendor', 'mercury'], null)
  check('releaseLayout compatibility member with no bytes to verify refused (never accepted unverified)', compatUnread.state === 'refused' && compatUnread.note.includes('not provided'))
  const compatBadRole = describePayload(rl({ compatibility: [{ path: 'compat.mjs', role: 'runtime', sha256: compatSha }] }), ['mercury.mjs', 'compat.mjs', 'manifest.json', 'vendor', 'mercury'], COMPAT_BYTES)
  check('releaseLayout compatibility entry without the forwarder role refused', compatBadRole.state === 'refused')
  const declAbsent = describePayload(rl(declaredCompat), ['mercury.mjs', 'manifest.json', 'vendor', 'mercury'], null)
  check('releaseLayout declared-compat-absent refused', declAbsent.state === 'refused')
  const alienPrimary = describePayload(rl({ primary: { path: 'other.mjs', sha256: 'f'.repeat(64) } }), ['other.mjs', 'manifest.json', 'vendor', 'mercury'], null)
  check('releaseLayout declaring an unrecognised primary refused', alienPrimary.state === 'refused')
  const badSchema = describePayload(rl({ schema: 9 }), ['mercury.mjs', 'manifest.json', 'vendor', 'mercury'], null)
  check('unsupported releaseLayout schema refused', badSchema.state === 'refused')
  const primAbsent = describePayload(rl(), ['manifest.json', 'vendor', 'mercury'], null)
  check('releaseLayout declared-primary-absent refused', primAbsent.state === 'refused')
}

console.log('── §7 repository slug derivation ──')
check('https URL', repoSlugFromUrl('https://github.com/Whq02/PreRelease') === 'Whq02/PreRelease')
check('.git suffix stripped', repoSlugFromUrl('https://github.com/Whq02/PreRelease.git') === 'Whq02/PreRelease')
check('trailing slash tolerated', repoSlugFromUrl('https://github.com/Whq02/PreRelease/') === 'Whq02/PreRelease')
check('non-github refused', repoSlugFromUrl('https://gitlab.com/a/b') === null)

console.log('')
if (failures === 0) {
  console.log('PASS prove-channel-core')
  process.exit(0)
}
console.log(`FAIL prove-channel-core (${failures})`)
process.exit(1)
