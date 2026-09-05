import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { flagEnv } from '../../substrate/flagRegistry.js'

export const VOICE_PACK_PATH = 'vendor/voice'
export const VOICE_ADDON_FILE = 'mercury_voice.node'
export const VOICE_PACK_MANIFEST_FILE = '.vendor-manifest.json'
export const VOICE_PACK_NAME = 'mercury-voice'

export function voicePackPlatform(platform: string = process.platform, arch: string = process.arch): string {
  return `${platform}-${arch}`
}

export function voiceCargoTriple(packPlatform: string): string | null {
  switch (packPlatform) {
    case 'darwin-arm64':
      return 'aarch64-apple-darwin'
    case 'darwin-x64':
      return 'x86_64-apple-darwin'
    case 'linux-x64':
      return 'x86_64-unknown-linux-gnu'
    case 'linux-arm64':
      return 'aarch64-unknown-linux-gnu'
    case 'win32-x64':
      return 'x86_64-pc-windows-msvc'
    default:
      return null
  }
}

export interface VoicePackCrate {
  name: string
  version: string
  license: string
}

export interface VoicePackManifest {
  name: typeof VOICE_PACK_NAME
  version: string
  platform: string
  addon: string
  addonSha256: string
  sourceTreeDigest: string
  cargo: string
  crates: VoicePackCrate[]
  fileCount: number
  treeDigest: string
}

const HEX64 = /^[0-9a-f]{64}$/

export const VOICE_NATIVE_PATH = 'native/voice'

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

export function voiceSourceTreeDigest(nativeDir: string): string {
  const lines = walkDigests(nativeDir, nativeDir, rel => rel === 'target' || rel.startsWith('target/') || rel === '.gitignore')
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}

export function voicePackTreeDigest(dir: string): { fileCount: number; treeDigest: string } {
  const lines = walkDigests(dir, dir, rel => rel === VOICE_PACK_MANIFEST_FILE)
  return { fileCount: lines.length, treeDigest: createHash('sha256').update(lines.join('\n')).digest('hex') }
}

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

export function voiceCheckoutRoot(moduleDir: string = path.dirname(fileURLToPath(import.meta.url))): string | null {
  let dir = moduleDir
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(dir, 'package.json')) || existsSync(path.join(dir, '.git'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

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

export interface ProcessGroupAnswer {
  pgid?: number | null
  reason?: string | null
}

export interface TerminalReclaimAnswer {
  reclaimed: boolean
  before?: number | null
  after?: number | null
  reason?: string | null
}

export interface VoiceAddon {
  packVersion(): string
  listInputDevices(): string[]
  defaultInputDevice(): string | null
  startCapture(): number
  stopCapture(handle: number): Buffer
  cancelCapture(handle: number): void
  ttyForegroundGroup(fd: number): ProcessGroupAnswer
  ownProcessGroup(): ProcessGroupAnswer
  reclaimTerminal(fd: number): TerminalReclaimAnswer
}

export const VOICE_ADDON_EXPORTS = [
  'packVersion',
  'listInputDevices',
  'defaultInputDevice',
  'startCapture',
  'stopCapture',
  'cancelCapture',
  'ttyForegroundGroup',
  'ownProcessGroup',
  'reclaimTerminal',
] as const

export type VoiceAddonLoad =
  | { state: 'ok'; addon: VoiceAddon; dir: string; manifest: VoicePackManifest; source: 'override' | 'vendored' | 'workspace' }
  | { state: 'unavailable'; note: string }

let loaded: VoiceAddonLoad | null = null

export function loadVoiceAddon(): VoiceAddonLoad {
  if (loaded !== null) return loaded
  const resolution = resolveVoicePackDir()
  if (resolution.state === 'unavailable') {
    return resolution
  }
  try {
    const req = createRequire(resolution.addonPath)
    const target: string = resolution.addonPath
    const raw = req(target) as Partial<VoiceAddon>
    for (const fn of VOICE_ADDON_EXPORTS) {
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

export function resetVoiceAddonForTest(): void {
  loaded = null
}
