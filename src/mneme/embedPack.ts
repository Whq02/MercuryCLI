import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { voiceCheckoutRoot, voicePackPlatform, voicePackTreeDigest, voiceSourceTreeDigest } from '../services/voice/voicePack.js'
import { cpuFloorRefusal, probeCpuFloor, whisperCpuFloorWords } from '../services/voice/whisperPack.js'

export const EMBED_PACK_SEGMENTS = ['vendor', 'embed'] as const
export const EMBED_PACK_PATH = 'vendor/embed'
export const EMBED_ADDON_FILE = 'mercury_embed.node'
export const EMBED_PACK_MANIFEST_FILE = '.vendor-manifest.json'
export const EMBED_PACK_NAME = 'mercury-embed'
export const EMBED_NATIVE_PATH = 'native/embed'
export const EMBED_ENGINE_NAME = 'gguf-bert'

export function embedPackDirFor(root: string, platform: string = voicePackPlatform()): string {
  return path.join(root, ...EMBED_PACK_SEGMENTS, platform)
}

export function embedCpuFloorWords(arch: string = process.arch): string {
  return whisperCpuFloorWords(arch)
}

export function embedGpuFor(platform: string, arch: string): 'accelerate' | 'none' {
  return platform === 'darwin' && (arch === 'arm64' || arch === 'x64') ? 'accelerate' : 'none'
}

export interface EmbedPackCrate {
  name: string
  version: string
  license: string
}

export interface EmbedPackManifest {
  name: typeof EMBED_PACK_NAME
  version: string
  platform: string
  addon: string
  addonSha256: string
  sourceTreeDigest: string
  cargo: string
  engine: { name: string; version: string }
  cpuFloor: string
  gpu: string
  crates: EmbedPackCrate[]
  fileCount: number
  treeDigest: string
}

const HEX64 = /^[0-9a-f]{64}$/

export function embedSourceTreeDigest(nativeDir: string): string {
  return voiceSourceTreeDigest(nativeDir)
}

export function embedPackTreeDigest(dir: string): { fileCount: number; treeDigest: string } {
  return voicePackTreeDigest(dir)
}

export function readEmbedPackManifest(dir: string): EmbedPackManifest | null {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path.join(dir, EMBED_PACK_MANIFEST_FILE), 'utf8'))
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const m = raw as Record<string, unknown>
  const engine = m.engine as Record<string, unknown> | undefined
  if (
    m.name !== EMBED_PACK_NAME ||
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
    typeof engine !== 'object' ||
    engine === null ||
    typeof engine.name !== 'string' ||
    typeof engine.version !== 'string' ||
    typeof m.cpuFloor !== 'string' ||
    typeof m.gpu !== 'string' ||
    !Array.isArray(m.crates)
  ) {
    return null
  }
  const crates: EmbedPackCrate[] = []
  for (const c of m.crates as unknown[]) {
    if (typeof c !== 'object' || c === null) return null
    const { name, version, license } = c as Record<string, unknown>
    if (typeof name !== 'string' || typeof version !== 'string' || typeof license !== 'string') return null
    crates.push({ name, version, license })
  }
  return {
    name: EMBED_PACK_NAME,
    version: m.version,
    platform: m.platform,
    addon: m.addon,
    addonSha256: m.addonSha256,
    sourceTreeDigest: m.sourceTreeDigest,
    cargo: typeof m.cargo === 'string' ? m.cargo : '',
    engine: { name: engine.name, version: engine.version },
    cpuFloor: m.cpuFloor,
    gpu: m.gpu,
    crates,
    fileCount: m.fileCount,
    treeDigest: m.treeDigest,
  }
}

export type EmbedPackCheck =
  | { state: 'ok'; addonPath: string; manifest: EmbedPackManifest }
  | { state: 'absent'; note: string }
  | { state: 'mismatch'; note: string }

export function checkEmbedPackDir(dir: string, opts: { digest?: boolean; platform?: string } = {}): EmbedPackCheck {
  const manifest = readEmbedPackManifest(dir)
  if (manifest === null) {
    return { state: 'absent', note: existsSync(dir) ? `${dir} carries no readable ${EMBED_PACK_MANIFEST_FILE}` : `${dir} is absent` }
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

export type EmbedPackResolution =
  | { state: 'ok'; dir: string; addonPath: string; manifest: EmbedPackManifest; source: 'override' | 'vendored' | 'workspace' }
  | { state: 'unavailable'; note: string }

export function embedPackAbsentNote(checkoutRoot: string | null = voiceCheckoutRoot()): string {
  return checkoutRoot !== null
    ? 'absent on this checkout — bun run scripts/vendor/build-embed.ts builds it (cargo)'
    : 'absent — this build shipped without it'
}

let seededPackDir: string | null = null

export function seedEmbedPackDirForTest(dir: string | null): void {
  seededPackDir = dir
  loaded = null
}

export function resolveEmbedPackDir(): EmbedPackResolution {
  if (seededPackDir !== null) {
    const check = checkEmbedPackDir(seededPackDir)
    if (check.state === 'ok') return { state: 'ok', dir: seededPackDir, addonPath: check.addonPath, manifest: check.manifest, source: 'override' }
    return { state: 'unavailable', note: `embed pack override set to ${seededPackDir} but ${check.note} — the pin names itself, no silent fallback` }
  }
  const moduleDir = path.dirname(fileURLToPath(import.meta.url))
  const platform = voicePackPlatform()
  const vendored = embedPackDirFor(moduleDir, platform)
  const vendoredCheck = checkEmbedPackDir(vendored)
  if (vendoredCheck.state === 'ok') {
    return { state: 'ok', dir: vendored, addonPath: vendoredCheck.addonPath, manifest: vendoredCheck.manifest, source: 'vendored' }
  }
  let dir = moduleDir
  for (let i = 0; i < 6; i++) {
    const candidate = embedPackDirFor(dir, platform)
    const check = checkEmbedPackDir(candidate)
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
    note: `no on-device embedding pack for ${platform}: neither ${EMBED_PACK_PATH}/${platform} beside the bundle nor the checkout's own`,
  }
}

export interface EmbedModelInfo {
  name: string
  architecture: string
  dimension: number
  layers: number
  pooling: string
}

export interface EmbedAddon {
  packVersion(): string
  engineVersion(): string
  systemInfo(): string
  cpuFloor(): { arch: string; floor: string; met: boolean; missing: string[] }
  loadModel(path: string): number
  modelInfo(handle: number): EmbedModelInfo
  embed(handle: number, text: string, isQuery?: boolean): number[]
  embedBatch(handle: number, texts: string[], isQuery?: boolean): number[][]
  unloadModel(handle: number): void
}

export const EMBED_ADDON_EXPORTS = ['packVersion', 'engineVersion', 'systemInfo', 'cpuFloor', 'loadModel', 'modelInfo', 'embed', 'embedBatch', 'unloadModel'] as const

export type EmbedAddonLoad =
  | { state: 'ok'; addon: EmbedAddon; dir: string; manifest: EmbedPackManifest; source: 'override' | 'vendored' | 'workspace' }
  | { state: 'unavailable'; note: string }

let loaded: EmbedAddonLoad | null = null

const REBUILD = 'rebuild it: bun run scripts/vendor/build-embed.ts'

export function loadEmbedAddon(): EmbedAddonLoad {
  if (loaded !== null) return loaded
  const resolution = resolveEmbedPackDir()
  if (resolution.state === 'unavailable') return resolution
  const floor = probeCpuFloor({ addonPath: resolution.addonPath })
  if (floor.state !== 'met') {
    loaded = { state: 'unavailable', note: `${cpuFloorRefusal(floor)}; word match serves` }
    return loaded
  }
  try {
    const req = createRequire(resolution.addonPath)
    const target: string = resolution.addonPath
    const raw = req(target) as Partial<EmbedAddon>
    for (const fn of EMBED_ADDON_EXPORTS) {
      if (typeof raw[fn] !== 'function') {
        loaded = { state: 'unavailable', note: `the on-device embedding addon at ${resolution.addonPath} exports no ${fn}() — ${REBUILD}` }
        return loaded
      }
    }
    loaded = { state: 'ok', addon: raw as EmbedAddon, dir: resolution.dir, manifest: resolution.manifest, source: resolution.source }
  } catch (error) {
    loaded = {
      state: 'unavailable',
      note: `the on-device embedding addon at ${resolution.addonPath} failed to load: ${error instanceof Error ? error.message : String(error)} — ${REBUILD}`,
    }
  }
  return loaded
}

export function resetEmbedAddonForTest(): void {
  loaded = null
  seededPackDir = null
}
