// ============================================================================
//  services/voice/voicePack — the ONE owner of the vendored voice capture
//  pack's shape.
//
//  The pack is a native addon (a Node-API module built from native/voice)
//  that lists input devices and captures 16 kHz mono PCM from the default
//  one. Node-API is ABI-stable, so the same file loads on the vendored Node
//  and a PATH Node alike. This module spells the shape once — the fixed
//  directory beside the bundle, the platform key, the addon file name, the
//  manifest record and the resolution ladder — for every consumer: the
//  vendor build (scripts/vendor/build-voice.ts), the build (build.ts), the
//  capture owner, the doctor row and the pack prover. Node builtins only.
//
//  Resolution ladder (the grammar engine's shape): an explicit
//  MERCURY_VOICE_PACK_DIR pin names itself when broken (no silent
//  fallback); else the bundle-sibling dist/vendor/voice/<platform>; else a
//  source run walks up to the checkout's own vendor/voice/<platform>,
//  stopping at the first project boundary.
// ============================================================================
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { flagEnv } from '../../substrate/flagRegistry.js'

/** The fixed directory beside the bundle: `<payload>/vendor/voice/<platform>`. */
export const VOICE_PACK_PATH = 'vendor/voice'
export const VOICE_ADDON_FILE = 'mercury_voice.node'
export const VOICE_PACK_MANIFEST_FILE = '.vendor-manifest.json'
export const VOICE_PACK_NAME = 'mercury-voice'

/** The pack platform key: `<process.platform>-<process.arch>`. */
export function voicePackPlatform(platform: string = process.platform, arch: string = process.arch): string {
  return `${platform}-${arch}`
}

export interface VoicePackCrate {
  name: string
  version: string
  license: string
}

/** The manifest the vendor build writes beside the addon. */
export interface VoicePackManifest {
  name: typeof VOICE_PACK_NAME
  /** The crate version (native/voice/Cargo.toml). */
  version: string
  platform: string
  addon: string
  addonSha256: string
  /** Digest of the Rust source tree the addon was built from. */
  sourceTreeDigest: string
  /** `cargo --version` at build time. */
  cargo: string
  /** Every crate linked into the addon, with its licence — the notices. */
  crates: VoicePackCrate[]
  fileCount: number
  treeDigest: string
}

const HEX64 = /^[0-9a-f]{64}$/

/** The Rust source tree the pack is built from, relative to a checkout. */
export const VOICE_NATIVE_PATH = 'native/voice'

/** Byte-order sorted `<rel> <sha256>` lines over a directory's files. */
function walkDigests(dir: string, base: string, skip: (rel: string) => boolean): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const full = path.join(dir, entry.name)
    const rel = path.relative(base, full).split(path.sep).join('/')
    if (skip(rel)) continue
    if (entry.isDirectory()) out.push(...walkDigests(full, base, skip))
    else if (entry.isFile()) out.push(`${rel} ${createHash('sha256').update(readFileSync(full)).digest('hex')}`)
  }
  return out
}

/** The digest of the Rust sources an addon is built from (Cargo.toml,
 *  Cargo.lock, build.rs, src/**) — the pack manifest records it, and a
 *  build refuses a pack older than its sources (the vendor-staleness law). */
export function voiceSourceTreeDigest(nativeDir: string): string {
  const lines = walkDigests(nativeDir, nativeDir, rel => rel === 'target' || rel.startsWith('target/') || rel === '.gitignore')
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}

/** The digest of a pack directory's files, the manifest itself excluded. */
export function voicePackTreeDigest(dir: string): { fileCount: number; treeDigest: string } {
  const lines = walkDigests(dir, dir, rel => rel === VOICE_PACK_MANIFEST_FILE)
  return { fileCount: lines.length, treeDigest: createHash('sha256').update(lines.join('\n')).digest('hex') }
}

/** Decode a pack manifest — null when absent, unreadable, or half a claim. */
export function readVoicePackManifest(dir: string): VoicePackManifest | null {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path.join(dir, VOICE_PACK_MANIFEST_FILE), 'utf8'))
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const m = raw as Record<string, unknown>
  if (
    m.name !== VOICE_PACK_NAME ||
    typeof m.version !== 'string' ||
    typeof m.platform !== 'string' ||
    typeof m.addon !== 'string' ||
    typeof m.addonSha256 !== 'string' ||
    !HEX64.test(m.addonSha256) ||
    typeof m.sourceTreeDigest !== 'string' ||
    !HEX64.test(m.sourceTreeDigest) ||
    typeof m.treeDigest !== 'string' ||
    !HEX64.test(m.treeDigest) ||
    typeof m.fileCount !== 'number' ||
    !Array.isArray(m.crates)
  ) {
    return null
  }
  const crates: VoicePackCrate[] = []
  for (const c of m.crates as unknown[]) {
    if (typeof c !== 'object' || c === null) return null
    const { name, version, license } = c as Record<string, unknown>
    if (typeof name !== 'string' || typeof version !== 'string' || typeof license !== 'string') return null
    crates.push({ name, version, license })
  }
  return {
    name: VOICE_PACK_NAME,
    version: m.version,
    platform: m.platform,
    addon: m.addon,
    addonSha256: m.addonSha256,
    sourceTreeDigest: m.sourceTreeDigest,
    cargo: typeof m.cargo === 'string' ? m.cargo : '',
    crates,
    fileCount: m.fileCount,
    treeDigest: m.treeDigest,
  }
}

export type VoicePackCheck =
  | { state: 'ok'; addonPath: string; manifest: VoicePackManifest }
  | { state: 'absent'; note: string }
  | { state: 'mismatch'; note: string }

/** Check a pack directory: the manifest, the addon file, and (on request)
 *  the addon's digest against the manifest. */
export function checkVoicePackDir(dir: string, opts: { digest?: boolean; platform?: string } = {}): VoicePackCheck {
  const manifest = readVoicePackManifest(dir)
  if (manifest === null) {
    return { state: 'absent', note: existsSync(dir) ? `${dir} carries no readable ${VOICE_PACK_MANIFEST_FILE}` : `${dir} is absent` }
  }
  const platform = opts.platform ?? voicePackPlatform()
  if (manifest.platform !== platform) {
    return { state: 'mismatch', note: `the pack at ${dir} was built for ${manifest.platform}, this host is ${platform}` }
  }
  const addonPath = path.join(dir, manifest.addon)
  if (!existsSync(addonPath)) return { state: 'mismatch', note: `the manifest at ${dir} names ${manifest.addon} but the file is absent` }
  if (opts.digest) {
    const actual = createHash('sha256').update(readFileSync(addonPath)).digest('hex')
    if (actual !== manifest.addonSha256) {
      return { state: 'mismatch', note: `${manifest.addon} does not match the manifest digest (expected ${manifest.addonSha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…)` }
    }
  }
  return { state: 'ok', addonPath, manifest }
}

export type VoicePackResolution =
  | { state: 'ok'; dir: string; addonPath: string; manifest: VoicePackManifest; source: 'override' | 'vendored' | 'workspace' }
  | { state: 'unavailable'; note: string }

/** Resolve the pack directory through the ladder (no loading). */
export function resolveVoicePackDir(): VoicePackResolution {
  const override = flagEnv('MERCURY_VOICE_PACK_DIR')
  if (override !== undefined && override.trim() !== '') {
    const check = checkVoicePackDir(override)
    if (check.state === 'ok') return { state: 'ok', dir: override, addonPath: check.addonPath, manifest: check.manifest, source: 'override' }
    return { state: 'unavailable', note: `MERCURY_VOICE_PACK_DIR set but ${check.note} — the pin names itself, no silent fallback` }
  }
  const moduleDir = path.dirname(fileURLToPath(import.meta.url))
  const platform = voicePackPlatform()
  const vendored = path.join(moduleDir, ...VOICE_PACK_PATH.split('/'), platform)
  const vendoredCheck = checkVoicePackDir(vendored)
  if (vendoredCheck.state === 'ok') {
    return { state: 'ok', dir: vendored, addonPath: vendoredCheck.addonPath, manifest: vendoredCheck.manifest, source: 'vendored' }
  }
  // Source runs: walk UP from this module toward the checkout's own
  // vendor/voice, stopping at the first project boundary — a fixed-hop path
  // would probe above the repo in a bundle context.
  let dir = moduleDir
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, ...VOICE_PACK_PATH.split('/'), platform)
    const check = checkVoicePackDir(candidate)
    if (check.state === 'ok') return { state: 'ok', dir: candidate, addonPath: check.addonPath, manifest: check.manifest, source: 'workspace' }
    if (check.state === 'mismatch') return { state: 'unavailable', note: check.note }
    if (existsSync(path.join(dir, 'package.json')) || existsSync(path.join(dir, '.git'))) break
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  if (vendoredCheck.state === 'mismatch') return { state: 'unavailable', note: vendoredCheck.note }
  return {
    state: 'unavailable',
    note: `no voice pack for ${platform}: neither ${VOICE_PACK_PATH}/${platform} beside the bundle nor the checkout's own`,
  }
}

/** The addon's Node-API surface (native/voice/src/lib.rs). */
export interface VoiceAddon {
  packVersion(): string
  listInputDevices(): string[]
  defaultInputDevice(): string | null
  /** Start a capture on the default input; answers the capture handle. */
  startCapture(): number
  /** Stop a capture: the whole take as s16le 16 kHz mono bytes. */
  stopCapture(handle: number): Buffer
  /** Drop a capture without its bytes. */
  cancelCapture(handle: number): void
}

export type VoiceAddonLoad =
  | { state: 'ok'; addon: VoiceAddon; dir: string; manifest: VoicePackManifest; source: 'override' | 'vendored' | 'workspace' }
  | { state: 'unavailable'; note: string }

let loaded: VoiceAddonLoad | null = null

/** Load the addon once (memoised for the process). */
export function loadVoiceAddon(): VoiceAddonLoad {
  if (loaded !== null) return loaded
  const resolution = resolveVoicePackDir()
  if (resolution.state === 'unavailable') {
    // Not memoised: a pack built later in the same process must be found.
    return resolution
  }
  try {
    const req = createRequire(resolution.addonPath)
    // Variable indirection — the bundler must never try to inline the addon.
    const target: string = resolution.addonPath
    const raw = req(target) as Partial<VoiceAddon>
    for (const fn of ['packVersion', 'listInputDevices', 'defaultInputDevice', 'startCapture', 'stopCapture', 'cancelCapture'] as const) {
      if (typeof raw[fn] !== 'function') {
        loaded = { state: 'unavailable', note: `the voice addon at ${resolution.addonPath} exports no ${fn}() — rebuild it: bun run scripts/vendor/build-voice.ts` }
        return loaded
      }
    }
    loaded = { state: 'ok', addon: raw as VoiceAddon, dir: resolution.dir, manifest: resolution.manifest, source: resolution.source }
  } catch (error) {
    loaded = {
      state: 'unavailable',
      note: `the voice addon at ${resolution.addonPath} failed to load: ${error instanceof Error ? error.message : String(error)} — rebuild it: bun run scripts/vendor/build-voice.ts`,
    }
  }
  return loaded
}

/** Proof seam: forget the loaded addon (a prover that swaps packs). */
export function resetVoiceAddonForTest(): void {
  loaded = null
}
