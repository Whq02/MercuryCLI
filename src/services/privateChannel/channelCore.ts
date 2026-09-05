import { createHash } from 'node:crypto'
import { RELEASE_TARGETS, archiveNameFor, releaseTargetFor } from './releaseTarget.js'

export interface PrivateVersion {
  major: number
  minor: number
  patch: number
  label: string
  counter: number
}

export function formatPrivateVersion(v: PrivateVersion): string {
  return `${v.major}.${v.minor}.${v.patch}-${v.label}.${v.counter}`
}

const TAG_RE = /^v(\d+)\.(\d+)\.(\d+)-([a-z]+)\.([1-9]\d*)$/
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)-([a-z]+)\.([1-9]\d*)$/

export function parsePrivateTag(tag: string): PrivateVersion | null {
  const m = TAG_RE.exec(tag)
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), label: m[4]!, counter: Number(m[5]) }
}

export function parsePrivateVersion(version: string): PrivateVersion | null {
  const m = VERSION_RE.exec(version)
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), label: m[4]!, counter: Number(m[5]) }
}

export function comparePrivateVersions(a: PrivateVersion, b: PrivateVersion): number {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  if (a.label !== b.label) return a.label < b.label ? -1 : 1
  return a.counter - b.counter
}


export interface ChannelRelease {
  tagName: string
  isDraft: boolean
  isPrerelease: boolean
  assetNames: string[]
  assetUrls?: Record<string, string>
}

interface RawRelease {
  tag_name?: unknown
  draft?: unknown
  prerelease?: unknown
  assets?: unknown
}

export function projectReleases(raw: unknown): ChannelRelease[] | null {
  if (!Array.isArray(raw)) return null
  const releases: ChannelRelease[] = []
  for (const item of raw as RawRelease[]) {
    if (typeof item !== 'object' || item === null) continue
    const assetNames: string[] = []
    const assetUrls: Record<string, string> = {}
    for (const asset of Array.isArray(item.assets) ? (item.assets as Array<{ name?: unknown; browser_download_url?: unknown }>) : []) {
      if (typeof asset !== 'object' || asset === null || typeof asset.name !== 'string' || asset.name.length === 0) continue
      assetNames.push(asset.name)
      if (typeof asset.browser_download_url === 'string' && asset.browser_download_url.length > 0) assetUrls[asset.name] = asset.browser_download_url
    }
    releases.push({
      tagName: typeof item.tag_name === 'string' ? item.tag_name : '',
      isDraft: item.draft === true,
      isPrerelease: item.prerelease === true,
      assetNames,
      ...(Object.keys(assetUrls).length > 0 ? { assetUrls } : {}),
    })
  }
  return releases
}

export type ReleaseSelection =
  | {
      state: 'update-available'
      tag: string
      version: PrivateVersion
      assetName: string
      checksumName: string
      assetUrl: string | null
      checksumUrl: string | null
    }
  | { state: 'current' }
  | { state: 'no-releases' }
  | { state: 'unsupported-platform'; note: string }
  | { state: 'malformed-release'; tag: string; note: string }

export const CHECKSUM_MANIFEST_NAME = 'SHA256SUMS.txt'

export function assetNameFor(version: string, platform: string, arch: string): string | null {
  const target = releaseTargetFor(platform, arch)
  return target === null ? null : archiveNameFor(version, target)
}

export function platformNote(platform: string, arch: string): string {
  return `no release archive is published for ${platform}/${arch} — the archives are ${RELEASE_TARGETS.join(', ')}; build from source (README.md)`
}

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
      note: 'the newest channel tag is not marked prerelease — the release workflow did not publish it; refusing to select it',
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
  return {
    state: 'update-available',
    tag: pick.r.tagName,
    version: pick.v,
    assetName,
    checksumName: CHECKSUM_MANIFEST_NAME,
    assetUrl: pick.r.assetUrls?.[assetName] ?? null,
    checksumUrl: pick.r.assetUrls?.[CHECKSUM_MANIFEST_NAME] ?? null,
  }
}

export type BridgePrevious =
  | { state: 'previous'; tag: string; version: PrivateVersion }
  | { state: 'first-release' }

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


export type ChecksumLookup =
  | { state: 'ok'; sha256: string }
  | { state: 'missing-entry' }
  | { state: 'duplicate-entry'; count: number }
  | { state: 'malformed'; note: string }

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


export const PAYLOAD_ROOT = 'mercury'
export const BUNDLE_MEMBER_NAMES = ['mercury.mjs'] as const
export const REQUIRED_PAYLOAD_MEMBERS = ['manifest.json'] as const

export function resolveBundleMember(members: string[]): string | null {
  for (const name of BUNDLE_MEMBER_NAMES) {
    if (members.includes(name)) return name
  }
  return null
}

export type LayoutVerdict = { state: 'ok' } | { state: 'unexpected-layout'; note: string }

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


export type PayloadGeneration = 'release-layout' | 'schema2-single' | 'legacy'

export interface PayloadDescriptor {
  generation: PayloadGeneration
  version: string
  primary: string
  compatibility: string[]
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

  if (typeof m.schema === 'number' && m.schema > 2) {
    return { state: 'refused', note: `unsupported manifest schema ${m.schema} without a releaseLayout section` }
  }

  if (recognized.length !== 1) {
    return {
      state: 'refused',
      note: `payload must carry exactly one runtime bundle (${BUNDLE_MEMBER_NAMES.join(' | ')}), found: ${recognized.join(', ') || '(none)'}`,
    }
  }
  return { state: 'ok', descriptor: { generation: 'legacy', version, primary: recognized[0]!, compatibility: [], launcher } }
}


export const PUBLIC_HOME_SLUG = 'Whq02/MercuryCLI'

export function repoSlugFromUrl(url: string): string | null {
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url)
  if (!m) return null
  return `${m[1]}/${m[2]}`
}

export interface ChannelRepo {
  slug: string
  source: 'override' | 'packaged' | 'fallback'
}

export function resolveChannelRepo(override: string | undefined, packagedUrl: string | undefined): ChannelRepo {
  const pinned = override?.trim() ?? ''
  if (/^[^/\s]+\/[^/\s]+$/.test(pinned)) return { slug: pinned, source: 'override' }
  const packaged = packagedUrl ? repoSlugFromUrl(packagedUrl) : null
  if (packaged) return { slug: packaged, source: 'packaged' }
  return { slug: PUBLIC_HOME_SLUG, source: 'fallback' }
}


export function rateLimitResetMinutes(
  headers: { rateLimitReset?: string | null; retryAfter?: string | null },
  nowMs: number,
): number | null {
  const reset = Number(headers.rateLimitReset)
  if (headers.rateLimitReset && Number.isFinite(reset) && reset > 0) {
    return Math.max(1, Math.ceil((reset * 1000 - nowMs) / 60_000))
  }
  const retry = Number(headers.retryAfter)
  if (headers.retryAfter && Number.isFinite(retry) && retry >= 0) return Math.max(1, Math.ceil(retry / 60))
  return null
}
