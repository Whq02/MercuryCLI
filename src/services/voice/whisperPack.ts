import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { release } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { voiceCheckoutRoot, voicePackPlatform, voicePackTreeDigest, voiceSourceTreeDigest } from './voicePack.js'

export const WHISPER_PACK_SEGMENTS = ['vendor', 'whisper'] as const
export const WHISPER_PACK_PATH = 'vendor/whisper'
export const WHISPER_ADDON_FILE = 'mercury_whisper.node'
export const WHISPER_PACK_MANIFEST_FILE = '.vendor-manifest.json'
export const WHISPER_PACK_NAME = 'mercury-whisper'
export const WHISPER_NATIVE_PATH = 'native/whisper'
export const WHISPER_ENGINE_NAME = 'whisper.cpp'

export function whisperPackDirFor(root: string, platform: string = voicePackPlatform()): string {
  return path.join(root, ...WHISPER_PACK_SEGMENTS, platform)
}

export const WHISPER_CPU_FLOOR_X64 = ['avx2', 'fma', 'f16c'] as const

export function whisperCpuFloorWords(arch: string = process.arch): string {
  if (arch === 'x64') return 'x86-64 with AVX2, FMA and F16C'
  if (arch === 'arm64') return 'arm64 (NEON)'
  return `${arch} baseline`
}

export function whisperGpuFor(platform: string, arch: string): 'metal' | 'none' {
  return platform === 'darwin' && arch === 'arm64' ? 'metal' : 'none'
}

export interface WhisperPackCrate {
  name: string
  version: string
  license: string
}

export interface WhisperPackManifest {
  name: typeof WHISPER_PACK_NAME
  version: string
  platform: string
  addon: string
  addonSha256: string
  sourceTreeDigest: string
  cargo: string
  engine: { name: string; version: string }
  cpuFloor: string
  gpu: string
  crates: WhisperPackCrate[]
  fileCount: number
  treeDigest: string
}

const HEX64 = /^[0-9a-f]{64}$/

export function whisperSourceTreeDigest(nativeDir: string): string {
  return voiceSourceTreeDigest(nativeDir)
}

export function whisperPackTreeDigest(dir: string): { fileCount: number; treeDigest: string } {
  return voicePackTreeDigest(dir)
}

export function readWhisperPackManifest(dir: string): WhisperPackManifest | null {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path.join(dir, WHISPER_PACK_MANIFEST_FILE), 'utf8'))
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const m = raw as Record<string, unknown>
  const engine = m.engine as Record<string, unknown> | undefined
  if (
    m.name !== WHISPER_PACK_NAME ||
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
  const crates: WhisperPackCrate[] = []
  for (const c of m.crates as unknown[]) {
    if (typeof c !== 'object' || c === null) return null
    const { name, version, license } = c as Record<string, unknown>
    if (typeof name !== 'string' || typeof version !== 'string' || typeof license !== 'string') return null
    crates.push({ name, version, license })
  }
  return {
    name: WHISPER_PACK_NAME,
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

export type WhisperPackCheck =
  | { state: 'ok'; addonPath: string; manifest: WhisperPackManifest }
  | { state: 'absent'; note: string }
  | { state: 'mismatch'; note: string }

export function checkWhisperPackDir(dir: string, opts: { digest?: boolean; platform?: string } = {}): WhisperPackCheck {
  const manifest = readWhisperPackManifest(dir)
  if (manifest === null) {
    return { state: 'absent', note: existsSync(dir) ? `${dir} carries no readable ${WHISPER_PACK_MANIFEST_FILE}` : `${dir} is absent` }
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

export type WhisperPackResolution =
  | { state: 'ok'; dir: string; addonPath: string; manifest: WhisperPackManifest; source: 'override' | 'vendored' | 'workspace' }
  | { state: 'unavailable'; note: string }

export function whisperPackAbsentNote(checkoutRoot: string | null = voiceCheckoutRoot()): string {
  return checkoutRoot !== null
    ? 'absent on this checkout — bun run scripts/vendor/build-whisper.ts builds it (cargo and cmake)'
    : 'absent — this build shipped without it'
}

export function resolveWhisperPackDir(): WhisperPackResolution {
  const override = flagEnv('MERCURY_WHISPER_PACK_DIR')
  if (override !== undefined && override.trim() !== '') {
    const check = checkWhisperPackDir(override)
    if (check.state === 'ok') return { state: 'ok', dir: override, addonPath: check.addonPath, manifest: check.manifest, source: 'override' }
    return { state: 'unavailable', note: `MERCURY_WHISPER_PACK_DIR set but ${check.note} — the pin names itself, no silent fallback` }
  }
  const moduleDir = path.dirname(fileURLToPath(import.meta.url))
  const platform = voicePackPlatform()
  const vendored = whisperPackDirFor(moduleDir, platform)
  const vendoredCheck = checkWhisperPackDir(vendored)
  if (vendoredCheck.state === 'ok') {
    return { state: 'ok', dir: vendored, addonPath: vendoredCheck.addonPath, manifest: vendoredCheck.manifest, source: 'vendored' }
  }
  let dir = moduleDir
  for (let i = 0; i < 6; i++) {
    const candidate = whisperPackDirFor(dir, platform)
    const check = checkWhisperPackDir(candidate)
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
    note: `no on-device transcriber pack for ${platform}: neither ${WHISPER_PACK_PATH}/${platform} beside the bundle nor the checkout's own`,
  }
}


export type CpuFloorProbe =
  | { state: 'met' }
  | { state: 'unmet'; missing: string[] }
  | { state: 'unknown'; note: string }

function reportedCpuFlags(platform: string): Set<string> | null {
  try {
    if (platform === 'linux') {
      const info = readFileSync('/proc/cpuinfo', 'utf8')
      const line = info.split('\n').find(l => /^flags\s*:/.test(l))
      if (line === undefined) return null
      return new Set(line.replace(/^flags\s*:/, '').trim().toLowerCase().split(/\s+/))
    }
    if (platform === 'darwin') {
      const res = spawnSync('sysctl', ['-n', 'machdep.cpu.features', 'machdep.cpu.leaf7_features'], { encoding: 'utf8', timeout: 5_000 })
      if (res.status !== 0) return null
      return new Set(res.stdout.toLowerCase().split(/\s+/).filter(f => f !== ''))
    }
  } catch {
  }
  return null
}

function windowsAvx2(): boolean | null {
  try {
    const script =
      "Add-Type -Namespace MercuryProbe -Name Cpu -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern bool IsProcessorFeaturePresent(int feature);'; [MercuryProbe.Cpu]::IsProcessorFeaturePresent(40)"
    const res = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 20_000, windowsHide: true })
    if (res.status !== 0) return null
    const answer = res.stdout.trim().toLowerCase()
    if (answer === 'true') return true
    if (answer !== 'false') return null
    const build = Number(release().split('.')[2] ?? '0')
    return build >= 17763 ? false : null
  } catch {
    return null
  }
}

let floorProbe: CpuFloorProbe | null = null

export function probeCpuFloor(arch: string = process.arch, platform: string = process.platform): CpuFloorProbe {
  if (arch === process.arch && platform === process.platform && floorProbe !== null) return floorProbe
  let probe: CpuFloorProbe
  if (arch !== 'x64') {
    probe = { state: 'met' }
  } else if (platform === 'win32') {
    const avx2 = windowsAvx2()
    probe = avx2 === null ? { state: 'unknown', note: 'Windows reported no instruction-set answer' } : avx2 ? { state: 'met' } : { state: 'unmet', missing: ['avx2'] }
  } else {
    const flags = reportedCpuFlags(platform)
    if (flags === null) probe = { state: 'unknown', note: `${platform} reported no instruction-set flags` }
    else {
      const missing = WHISPER_CPU_FLOOR_X64.filter(f => !flags.has(f))
      probe = missing.length === 0 ? { state: 'met' } : { state: 'unmet', missing: [...missing] }
    }
  }
  if (arch === process.arch && platform === process.platform) floorProbe = probe
  return probe
}


export interface WhisperTranscribeOptions {
  language?: string
  threads?: number
  prompt?: string
}

export interface WhisperTranscriptAnswer {
  text: string
  ms: number
  language: string
  segments: number
}

export interface WhisperAddon {
  packVersion(): string
  engineVersion(): string
  systemInfo(): string
  cpuFloor(): { arch: string; floor: string; met: boolean; missing: string[] }
  loadModel(path: string, useGpu?: boolean): number
  modelInfo(handle: number): { multilingual: boolean; kind: string }
  transcribe(handle: number, pcm: Buffer, options?: WhisperTranscribeOptions): Promise<WhisperTranscriptAnswer>
  unloadModel(handle: number): void
}

export const WHISPER_ADDON_EXPORTS = ['packVersion', 'engineVersion', 'systemInfo', 'cpuFloor', 'loadModel', 'modelInfo', 'transcribe', 'unloadModel'] as const

export type WhisperAddonLoad =
  | { state: 'ok'; addon: WhisperAddon; dir: string; manifest: WhisperPackManifest; source: 'override' | 'vendored' | 'workspace' }
  | { state: 'unavailable'; note: string }

let loaded: WhisperAddonLoad | null = null

const REBUILD = 'rebuild it: bun run scripts/vendor/build-whisper.ts'

export function loadWhisperAddon(): WhisperAddonLoad {
  if (loaded !== null) return loaded
  const resolution = resolveWhisperPackDir()
  if (resolution.state === 'unavailable') {
    return resolution
  }
  const floor = probeCpuFloor()
  if (floor.state === 'unmet') {
    loaded = {
      state: 'unavailable',
      note: `this CPU lacks ${floor.missing.map(f => f.toUpperCase()).join(', ')} — the on-device transcriber needs ${whisperCpuFloorWords()}; the cloud road serves`,
    }
    return loaded
  }
  try {
    const req = createRequire(resolution.addonPath)
    const target: string = resolution.addonPath
    const raw = req(target) as Partial<WhisperAddon>
    for (const fn of WHISPER_ADDON_EXPORTS) {
      if (typeof raw[fn] !== 'function') {
        loaded = { state: 'unavailable', note: `the on-device transcriber addon at ${resolution.addonPath} exports no ${fn}() — ${REBUILD}` }
        return loaded
      }
    }
    loaded = { state: 'ok', addon: raw as WhisperAddon, dir: resolution.dir, manifest: resolution.manifest, source: resolution.source }
  } catch (error) {
    loaded = {
      state: 'unavailable',
      note: `the on-device transcriber addon at ${resolution.addonPath} failed to load: ${error instanceof Error ? error.message : String(error)} — ${REBUILD}`,
    }
  }
  return loaded
}

export function resetWhisperAddonForTest(): void {
  loaded = null
  floorProbe = null
}
