#!/usr/bin/env bun
// ============================================================================
//  scripts/updater/prove-version-contract.ts — the §5 ONE-authoritative-
//  version-root assertion (`bun run version:check`): package.json is the
//  root; the built artifact, the manifest, the archive/asset grammar, the
//  release-tag grammar, the notices header, the per-release notes record and
//  the workflow's tag≡version step must all agree with it — and the
//  updater's ordering must place the candidate correctly against both the
//  previous release and future counters.
// ============================================================================
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  assetNameFor,
  comparePrivateVersions,
  formatPrivateVersion,
  parsePrivateTag,
  parsePrivateVersion,
  repoSlugFromUrl,
} from '../../src/services/privateChannel/channelCore.js'
import { parseEnginesNode } from '../release/launcherTemplates.mjs'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) failures++
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  version: string
  engines?: { node?: string }
  repository?: { url?: string }
}
const VERSION = pkg.version
console.log(`version root (package.json): ${VERSION}`)

// ── the root itself ─────────────────────────────────────────────────────────
const parsed = parsePrivateVersion(VERSION)
check('root version parses under the private-channel grammar', parsed !== null)
check('tag form v<version> parses as a channel tag', parsePrivateTag(`v${VERSION}`) !== null)
if (parsed) check('grammar round-trips the root', formatPrivateVersion(parsed) === VERSION)

// ── ordering: the compatibility floor + future counters ─────────────────────
const FLOOR = (JSON.parse(readFileSync(join(ROOT, 'scripts', 'release', 'compat-floor.json'), 'utf8')) as { floorVersion: string }).floorVersion
const prev = parsePrivateVersion(FLOOR)
if (parsed && prev) {
  check(`root is at or above the compatibility floor (${FLOOR})`, comparePrivateVersions(prev, parsed) <= 0)
  check('a future counter orders after the root', comparePrivateVersions(parsed, { ...parsed, counter: parsed.counter + 1 }) < 0)
  check('a future patch orders after any counter', comparePrivateVersions({ ...parsed, counter: 99 }, { ...parsed, patch: parsed.patch + 1, counter: 1 }) < 0)
}

// ── engines + repository derive from the same file ──────────────────────────
try {
  const policy = parseEnginesNode(pkg.engines?.node)
  check('engines.node parses for the launcher templates', !!policy.range)
} catch (e) {
  check('engines.node parses for the launcher templates', false, e instanceof Error ? e.message : String(e))
}
check('repository.url yields the channel slug', repoSlugFromUrl((pkg.repository?.url ?? '').replace(/^git\+/, '')) !== null)

// ── built artifact agreement ────────────────────────────────────────────────
const dist = join(ROOT, 'dist', 'mercury.mjs')
const manifestPath = join(ROOT, 'dist', 'manifest.json')
if (existsSync(dist) && existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: string }
  check('dist/manifest.json version equals the root', manifest.version === VERSION, `manifest: ${manifest.version}`)
  const printed = execFileSync('node', [dist, '--version'], { encoding: 'utf8', timeout: 60_000 }).trim()
  check('built --version prints exactly `Mercury <root>`', printed === `Mercury ${VERSION}`, printed)
} else {
  // version:check must still be honest without a build present
  console.log('  [NOTE] dist absent — build agreement not checkable here (the gate prebuilds; run `bun run build.ts`)')
}

// ── archive/asset naming grammar ────────────────────────────────────────────
check('linux asset name matches the packager grammar', assetNameFor(VERSION, 'linux', 'x64') === `mercury-v${VERSION}-linux-x64.tar.gz`)
check('macos asset name matches the packager grammar', assetNameFor(VERSION, 'darwin', 'arm64') === `mercury-v${VERSION}-macos-arm64.tar.gz`)
check('windows asset name matches the packager grammar', assetNameFor(VERSION, 'win32', 'x64') === `mercury-v${VERSION}-windows-x64.zip`)
const packager = readFileSync(join(ROOT, 'scripts', 'release', 'package.mjs'), 'utf8')
check('packager derives NAME from the root', packager.includes('mercury-v${VERSION}-${TARGET}'))

// ── generated/derived consumers are current ─────────────────────────────────
const notices = readFileSync(join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8')
check('THIRD_PARTY_NOTICES header carries the root version', notices.includes(`Mercury ${VERSION}`))
check(
  `the bundled changelog carries the ## ${VERSION} section (the packaged RELEASE-NOTES source)`,
  readFileSync(join(ROOT, 'src', 'constants', 'changelog.ts'), 'utf8').includes(`## ${VERSION}`),
)
const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'private-release.yml'), 'utf8')
check('release workflow verifies tag ≡ version root', workflow.includes('tag equals package.json version'))
check('release workflow publishes the changelog-derived notes', workflow.includes('notesFromChangelog.mjs'))

console.log('')
if (failures === 0) {
  console.log('PASS prove-version-contract')
  process.exit(0)
}
console.log(`FAIL prove-version-contract (${failures})`)
process.exit(1)
