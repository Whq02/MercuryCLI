// ============================================================================
//  src/services/privateChannel/channelCore.ts — the PURE core of Mercury's
//  private release channel.
//
//  Zero I/O by construction: tag grammar, version ordering, release
//  filtering/selection, platform→asset mapping, SHA256SUMS parsing, and the
//  expected archive layout all live here so scripts/updater/ can prove every
//  decision deterministically. The transports (gh CLI) and the filesystem
//  layout live in ghRelease.ts / installLayout.ts.
//
//  The ONE accepted release grammar is this repository's tag convention:
//      v<major>.<minor>.<patch>-<label>.<n>
//  where <label> is a lowercase prerelease word (beta, rc, …) and <n> counts
//  from 1 (package.json carries the same string without the leading `v`).
//  Anything else — archive/* tags, bench tags, bare semver — is NOT a
//  channel release and is ignored by name.
// ============================================================================
import { createHash } from 'node:crypto'

export interface PrivateVersion {
  major: number
  minor: number
  patch: number
  /** the prerelease label (`beta`, `rc`, …) */
  label: string
  /** the -<label>.<n> prerelease counter (n ≥ 1) */
  counter: number
}

/** Canonical `1.0.0-beta.1` form (no leading v). */
export function formatPrivateVersion(v: PrivateVersion): string {
  return `${v.major}.${v.minor}.${v.patch}-${v.label}.${v.counter}`
}

const TAG_RE = /^v(\d+)\.(\d+)\.(\d+)-([a-z]+)\.([1-9]\d*)$/
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)-([a-z]+)\.([1-9]\d*)$/

/** Parse a release TAG (`v1.0.0-beta.1`). Null = not a channel release. */
export function parsePrivateTag(tag: string): PrivateVersion | null {
  const m = TAG_RE.exec(tag)
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), label: m[4]!, counter: Number(m[5]) }
}

/** Parse a VERSION string (`1.0.0-beta.1`, package.json form). */
export function parsePrivateVersion(version: string): PrivateVersion | null {
  const m = VERSION_RE.exec(version)
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), label: m[4]!, counter: Number(m[5]) }
}

/** Total order: semver triple, then the prerelease label (ASCII order, as
 *  semver orders identifiers: `beta` < `rc`), then the counter. <0 ⇒ a older. */
export function comparePrivateVersions(a: PrivateVersion, b: PrivateVersion): number {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  if (a.label !== b.label) return a.label < b.label ? -1 : 1
  return a.counter - b.counter
}

// ── release selection ───────────────────────────────────────────────────────

/** The shape ghRelease.ts projects from the host's release records. */
export interface ChannelRelease {
  tagName: string
  isDraft: boolean
  isPrerelease: boolean
  assetNames: string[]
}

export type ReleaseSelection =
  | { state: 'update-available'; tag: string; version: PrivateVersion; assetName: string; checksumName: string }
  | { state: 'current' }
  | { state: 'no-releases' }
  | { state: 'unsupported-platform'; note: string }
  | { state: 'malformed-release'; tag: string; note: string }

export const CHECKSUM_MANIFEST_NAME = 'SHA256SUMS.txt'

/** The exactly-one platform asset for this release version, or null when the
 *  platform has no channel asset (named honestly by platformNote). */
export function assetNameFor(version: string, platform: string, arch: string): string | null {
  if (platform === 'linux' && arch === 'x64') return `mercury-v${version}-linux-x64.tar.gz`
  if (platform === 'darwin' && arch === 'arm64') return `mercury-v${version}-macos-arm64.tar.gz`
  if (platform === 'win32' && arch === 'x64') return `mercury-v${version}-windows-x64.zip`
  return null
}

export function platformNote(platform: string, arch: string): string {
  if (platform === 'darwin' && arch === 'x64')
    return 'macOS x64 (Intel) has no channel archive — hosted Intel runners were retired; use the source build'
  return `no private-channel archive is published for ${platform}/${arch}`
}

/**
 * Pick the newest convention-valid, non-draft, prerelease-flagged channel
 * release strictly newer than `installed`. Drafts and unrelated tags are
 * ignored by name; a convention-valid tag whose release record is malformed
 * (not a prerelease, or missing this platform's asset / the checksum
 * manifest) is surfaced as such rather than silently skipped, so a broken
 * publish is loud instead of invisible.
 */
export function selectRelease(
  releases: ChannelRelease[],
  installed: PrivateVersion,
  platform: string,
  arch: string,
): ReleaseSelection {
  const candidates = releases
    .map(r => ({ r, v: parsePrivateTag(r.tagName) }))
    .filter((x): x is { r: ChannelRelease; v: PrivateVersion } => x.v !== null && !x.r.isDraft)
    .sort((a, b) => comparePrivateVersions(b.v, a.v))
  if (candidates.length === 0) return { state: 'no-releases' }

  const newer = candidates.filter(c => comparePrivateVersions(c.v, installed) > 0)
  if (newer.length === 0) return { state: 'current' }

  const pick = newer[0]!
  if (!pick.r.isPrerelease) {
    return {
      state: 'malformed-release',
      tag: pick.r.tagName,
      note: 'the newest channel tag is not marked prerelease — the private-release workflow did not publish it; refusing to select it',
    }
  }
  const version = formatPrivateVersion(pick.v)
  const assetName = assetNameFor(version, platform, arch)
  if (assetName === null) return { state: 'unsupported-platform', note: platformNote(platform, arch) }
  if (!pick.r.assetNames.includes(assetName)) {
    return {
      state: 'malformed-release',
      tag: pick.r.tagName,
      note: `release ${pick.r.tagName} has no ${assetName} asset for this platform`,
    }
  }
  if (!pick.r.assetNames.includes(CHECKSUM_MANIFEST_NAME)) {
    return {
      state: 'malformed-release',
      tag: pick.r.tagName,
      note: `release ${pick.r.tagName} has no ${CHECKSUM_MANIFEST_NAME} — checksums must come from the same release`,
    }
  }
  return { state: 'update-available', tag: pick.r.tagName, version: pick.v, assetName, checksumName: CHECKSUM_MANIFEST_NAME }
}

export type BridgePrevious =
  | { state: 'previous'; tag: string; version: PrivateVersion }
  | { state: 'first-release' }

/**
 * The release-bridge gate's "previous shipped reader": the newest
 * convention-valid, non-draft channel release that is NOT the candidate's own
 * tag (a paired trigger may already have published it). Drafts and unrelated
 * tags are ignored by name, exactly as selectRelease ignores them. A channel
 * with no such release has no shipped reader anywhere in the field that could
 * consume the candidate through `update` — the candidate is the channel's
 * FIRST release (a clean channel: no earlier release exists), and the bridge settles
 * neutral instead of dying on a law that has nothing to bridge. A listing
 * that cannot be obtained is the caller's failure, never this arm.
 */
export function selectBridgePrevious(releases: Array<{ tagName: string; isDraft: boolean }>, candidateVersion: string): BridgePrevious {
  const candidates = releases
    .filter(r => !r.isDraft && r.tagName !== `v${candidateVersion}`)
    .map(r => ({ tag: r.tagName, v: parsePrivateTag(r.tagName) }))
    .filter((x): x is { tag: string; v: PrivateVersion } => x.v !== null)
    .sort((a, b) => comparePrivateVersions(b.v, a.v))
  const pick = candidates[0]
  if (!pick) return { state: 'first-release' }
  return { state: 'previous', tag: pick.tag, version: pick.v }
}

// ── checksum manifest parsing ───────────────────────────────────────────────

export type ChecksumLookup =
  | { state: 'ok'; sha256: string }
  | { state: 'missing-entry' }
  | { state: 'duplicate-entry'; count: number }
  | { state: 'malformed'; note: string }

/**
 * Parse the release's SHA256SUMS.txt (sha256sum(1) format: `<hex> <name>`,
 * binary-mode ` *<name>` accepted) and look up exactly one entry by exact
 * asset filename. Missing, duplicate and malformed entries are distinct
 * refusals — never a fallthrough.
 */
export function lookupChecksum(manifestText: string, assetName: string): ChecksumLookup {
  const lines = manifestText.split(/\r?\n/).filter(l => l.trim().length > 0)
  if (lines.length === 0) return { state: 'malformed', note: 'checksum manifest is empty' }
  const matches: string[] = []
  for (const line of lines) {
    const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line)
    if (!m) return { state: 'malformed', note: `unparseable checksum line: ${line.slice(0, 80)}` }
    if (m[2] === assetName) matches.push(m[1]!.toLowerCase())
  }
  if (matches.length === 0) return { state: 'missing-entry' }
  if (matches.length > 1) return { state: 'duplicate-entry', count: matches.length }
  return { state: 'ok', sha256: matches[0]! }
}

// ── archive layout expectation ──────────────────────────────────────────────

/** Every channel archive extracts to exactly one `mercury/` payload root
 *  carrying the runtime + manifest. WHICH member is the runtime is decided by
 *  describePayload below (the declared-roles contract), never by counting
 *  filenames. The reader recognises exactly one runtime bundle name. */
export const PAYLOAD_ROOT = 'mercury'
export const BUNDLE_MEMBER_NAMES = ['mercury.mjs'] as const
export const REQUIRED_PAYLOAD_MEMBERS = ['manifest.json'] as const

/** The payload's runtime bundle member when present, or null. This is the
 *  resolution for payloads whose manifest declares nothing (hand-built
 *  fixture dirs) and for reading installed version dirs; every
 *  archive-acceptance decision goes through describePayload. */
export function resolveBundleMember(members: string[]): string | null {
  for (const name of BUNDLE_MEMBER_NAMES) {
    if (members.includes(name)) return name
  }
  return null
}

export type LayoutVerdict = { state: 'ok' } | { state: 'unexpected-layout'; note: string }

/** Judge the extraction ENVELOPE of a channel archive: exactly one
 *  `mercury/` root carrying a manifest. Runtime-bundle adjudication is
 *  describePayload's job — the envelope never counts bundle names. */
export function judgeExtractedLayout(topLevelEntries: string[], payloadMembers: string[]): LayoutVerdict {
  if (topLevelEntries.length !== 1 || topLevelEntries[0] !== PAYLOAD_ROOT) {
    return {
      state: 'unexpected-layout',
      note: `expected a single '${PAYLOAD_ROOT}/' root, found: ${topLevelEntries.slice(0, 5).join(', ') || '(nothing)'}`,
    }
  }
  for (const required of REQUIRED_PAYLOAD_MEMBERS) {
    if (!payloadMembers.includes(required)) {
      return { state: 'unexpected-layout', note: `payload is missing ${required}` }
    }
  }
  return { state: 'ok' }
}

// ── the ONE payload contract (descriptor minting) ───────────────────────────

/** Which decoder arm understood the payload — shape-bounded, so each
 *  manifest shape is decoded by ITS contract and nothing else. */
export type PayloadGeneration = 'release-layout' | 'schema2-single' | 'legacy'

export interface PayloadDescriptor {
  generation: PayloadGeneration
  version: string
  /** the ONE runtime bundle member every downstream stage consumes */
  primary: string
  /** accepted declared-role compatibility members (never a second primary) */
  compatibility: string[]
  /** the launcher member present beside the bundle, if any */
  launcher: string | null
}

export type PayloadDescription = { state: 'ok'; descriptor: PayloadDescriptor } | { state: 'refused'; note: string }

interface ReleaseLayoutSection {
  schema?: number
  primary?: { path?: string; sha256?: string }
  compatibility?: Array<{ path?: string; role?: string; sha256?: string }>
  launcher?: string
}

const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex')

const detectLauncher = (members: string[]): string | null =>
  members.includes('mercury') ? 'mercury' : members.includes('mercury.cmd') ? 'mercury.cmd' : null

/**
 * Mint the payload descriptor — the ONE authority every downstream stage
 * (validate, staged smoke, install identity, post-switch smoke) consumes.
 * Pure by construction: the core does no I/O, so a declared compatibility
 * member's sha256 can only be verified against bytes the caller read
 * (`compatMemberBytes`); with none provided, such a declaration refuses.
 * Shape-bounded decoder arms:
 *
 *   1. `releaseLayout` present: the packager's declared primary + declared
 *      compatibility members are authority; any undeclared recognized name
 *      refuses.
 *   2. schema 2 with a declared bundle and no releaseLayout: the declared
 *      bundle is primary; any other recognized name refuses.
 *   3. no declaration (version-only manifests, hand-built fixture dirs):
 *      exactly the one recognized bundle, else refuse.
 */
export function describePayload(
  manifestJson: unknown,
  memberNames: string[],
  compatMemberBytes?: string | null,
): PayloadDescription {
  if (typeof manifestJson !== 'object' || manifestJson === null) {
    return { state: 'refused', note: 'manifest.json is not an object' }
  }
  const m = manifestJson as { schema?: unknown; version?: unknown; bundle?: unknown; releaseLayout?: unknown }
  const version = typeof m.version === 'string' ? m.version : ''
  if (!version) return { state: 'refused', note: 'manifest.json carries no version' }
  const recognized = BUNDLE_MEMBER_NAMES.filter(n => memberNames.includes(n))
  const launcher = detectLauncher(memberNames)

  // arm 1 — the packager-declared release layout (one contract, both sides)
  if (typeof m.releaseLayout === 'object' && m.releaseLayout !== null) {
    const rl = m.releaseLayout as ReleaseLayoutSection
    if (rl.schema !== 1) {
      return { state: 'refused', note: `unsupported releaseLayout schema ${String(rl.schema)} — this reader decodes schema 1` }
    }
    const primary = typeof rl.primary?.path === 'string' ? rl.primary.path : ''
    if (!(BUNDLE_MEMBER_NAMES as readonly string[]).includes(primary)) {
      return { state: 'refused', note: `releaseLayout declares an unrecognized primary "${primary}"` }
    }
    if (!memberNames.includes(primary)) {
      return { state: 'refused', note: `declared primary ${primary} is absent from the payload` }
    }
    const declaredCompat = (rl.compatibility ?? []).map(c => c.path).filter((p): p is string => typeof p === 'string')
    for (const c of rl.compatibility ?? []) {
      if (typeof c.path !== 'string' || c.role !== 'forwarder') {
        return { state: 'refused', note: 'releaseLayout compatibility entries must declare path + role "forwarder"' }
      }
      if (!memberNames.includes(c.path)) {
        return { state: 'refused', note: `declared compatibility member ${c.path} is absent from the payload` }
      }
      if (typeof c.sha256 === 'string' && c.sha256.length === 64) {
        if (typeof compatMemberBytes !== 'string') {
          return { state: 'refused', note: `compatibility member ${c.path} content was not provided for verification` }
        }
        if (sha256Hex(compatMemberBytes) !== c.sha256.toLowerCase()) {
          return { state: 'refused', note: `compatibility member ${c.path} does not match its declared sha256 — refusing an undeclared second runtime` }
        }
      }
    }
    const undeclared = recognized.filter(n => n !== primary && !declaredCompat.includes(n))
    if (undeclared.length > 0) {
      return { state: 'refused', note: `payload carries undeclared recognized member(s): ${undeclared.join(', ')}` }
    }
    return {
      state: 'ok',
      descriptor: {
        generation: 'release-layout',
        version,
        primary,
        compatibility: declaredCompat,
        launcher: typeof rl.launcher === 'string' ? rl.launcher : launcher,
      },
    }
  }

  // arm 2 — schema 2 with a declared bundle and no releaseLayout section
  if (m.schema === 2 && typeof m.bundle === 'string') {
    const primary = m.bundle
    if (!(BUNDLE_MEMBER_NAMES as readonly string[]).includes(primary)) {
      return { state: 'refused', note: `manifest declares an unrecognized bundle "${primary}"` }
    }
    if (!memberNames.includes(primary)) {
      return { state: 'refused', note: `declared primary ${primary} is absent from the payload` }
    }
    const others = recognized.filter(n => n !== primary)
    if (others.length > 0) {
      return { state: 'refused', note: `payload carries undeclared recognized member(s): ${others.join(', ')}` }
    }
    return { state: 'ok', descriptor: { generation: 'schema2-single', version, primary, compatibility: [], launcher } }
  }

  // unknown FUTURE generation: refuse rather than guess (a schema-3+ manifest
  // must carry releaseLayout to be decodable by this reader)
  if (typeof m.schema === 'number' && m.schema > 2) {
    return { state: 'refused', note: `unsupported manifest schema ${m.schema} without a releaseLayout section` }
  }

  // arm 3 — no declaration to trust: exactly the one recognized bundle, else refuse
  if (recognized.length !== 1) {
    return {
      state: 'refused',
      note: `payload must carry exactly one runtime bundle (${BUNDLE_MEMBER_NAMES.join(' | ')}), found: ${recognized.join(', ') || '(none)'}`,
    }
  }
  return { state: 'ok', descriptor: { generation: 'legacy', version, primary: recognized[0]!, compatibility: [], launcher } }
}

// ── channel repository ──────────────────────────────────────────────────────

/** Derive the `owner/repo` slug from the packaged repository URL
 *  (MACRO.PACKAGE_URL — one root: package.json repository.url). */
export function repoSlugFromUrl(url: string): string | null {
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url)
  if (!m) return null
  return `${m[1]}/${m[2]}`
}
