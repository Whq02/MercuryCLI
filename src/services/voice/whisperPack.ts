import { spawnSync } from 'node:child_process'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
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


export type CpuFloorRoad = 'architecture' | 'flags' | 'helper'

export type CpuFloorProbe =
  | { state: 'met'; via: CpuFloorRoad }
  | { state: 'unmet'; via: CpuFloorRoad; missing: string[]; faulted?: boolean }
  | { state: 'unknown'; via: CpuFloorRoad; note: string }

export function cpuFloorRefusal(probe: Exclude<CpuFloorProbe, { state: 'met' }>, arch: string = process.arch): string {
  const floor = whisperCpuFloorWords(arch)
  if (probe.state === 'unknown') return `the on-device transcriber is held back: ${probe.note} — it needs ${floor}, and whether this CPU has that could not be read`
  if (probe.faulted) return `this CPU cannot run the on-device transcriber: loading it in a helper process faulted — it needs ${floor}`
  return `this CPU lacks ${probe.missing.map(f => f.toUpperCase()).join(', ')} — the on-device transcriber needs ${floor}`
}

export function cpuFloorRoadWords(probe: CpuFloorProbe, arch: string = process.arch): string {
  const floor = whisperCpuFloorWords(arch)
  if (probe.state !== 'met') return cpuFloorRefusal(probe, arch)
  if (probe.via === 'architecture') return `${floor} — met by the architecture`
  if (probe.via === 'flags') return `${floor} — met, from the operating system's flag list`
  return `${floor} — met, checked by loading the pack once in a helper process at the first read`
}

function reportedCpuFlags(platform: string): Set<string> | null {
  try {
    if (platform === 'linux') {
      const info = readFileSync('/proc/cpuinfo', 'utf8')
      const line = info.split('\n').find(l => /^flags\s*:/.test(l))
      if (line === undefined) return null
      return new Set(line.replace(/^flags\s*:/, '').trim().toLowerCase().split(/\s+/))
    }
    if (platform === 'darwin') {
      const res = spawnSync('sysctl', ['-n', 'machdep.cpu.features', 'machdep.cpu.leaf7_features'], { encoding: 'utf8', timeout: 5_000, windowsHide: true, env: subprocessEnv() })
      if (res.status !== 0) return null
      return new Set(res.stdout.toLowerCase().split(/\s+/).filter(f => f !== ''))
    }
  } catch {
  }
  return null
}

const FLOOR_MARK = 'MERCURY_WHISPER_FLOOR '
const FLOOR_ERROR_MARK = 'MERCURY_WHISPER_FLOOR_ERROR '
const ILLEGAL_INSTRUCTION_STATUS = 0xc000001d
export const CPU_FLOOR_HELPER_TIMEOUT_MS = 10_000

export interface CpuFloorHelperOptions {
  exe?: string
  timeoutMs?: number
}

export function probeCpuFloorByLoad(addonPath: string, opts: CpuFloorHelperOptions = {}): CpuFloorProbe {
  const exe = opts.exe ?? process.execPath
  const timeout = opts.timeoutMs ?? CPU_FLOOR_HELPER_TIMEOUT_MS
  const say = (mark: string, expr: string): string => `process.stdout.write(${JSON.stringify(mark)} + ${expr} + "\\n")`
  const firstLine = 'String(e && e.message || e).split("\\n")[0]'
  const script = [
    'let a',
    `try { a = require(${JSON.stringify(addonPath)}) } catch (e) { ${say(FLOOR_ERROR_MARK, firstLine)}; process.exit(2) }`,
    `if (typeof a.cpuFloor !== "function") { ${say(FLOOR_ERROR_MARK, '"the addon exports no cpuFloor()"')}; process.exit(2) }`,
    `try { ${say(FLOOR_MARK, 'JSON.stringify(a.cpuFloor())')} } catch (e) { ${say(FLOOR_ERROR_MARK, firstLine)}; process.exit(2) }`,
  ].join('; ')
  let res: ReturnType<typeof spawnSync>
  try {
    res = spawnSync(exe, ['-e', script], { encoding: 'utf8', timeout, windowsHide: true, env: subprocessEnv() })
  } catch (error) {
    return { state: 'unknown', via: 'helper', note: `the helper process could not start: ${error instanceof Error ? error.message : String(error)}` }
  }
  const out = String(res.stdout ?? '').split('\n').reverse()
  const line = out.find(l => l.startsWith(FLOOR_MARK))
  if (line !== undefined) {
    try {
      const answer = JSON.parse(line.slice(FLOOR_MARK.length)) as { met?: unknown; missing?: unknown }
      if (typeof answer.met === 'boolean' && Array.isArray(answer.missing)) {
        return answer.met ? { state: 'met', via: 'helper' } : { state: 'unmet', via: 'helper', missing: answer.missing.map(String) }
      }
    } catch {
    }
  }
  const said = out.find(l => l.startsWith(FLOOR_ERROR_MARK))
  if (said !== undefined) return { state: 'unknown', via: 'helper', note: `the helper process could not load the addon: ${said.slice(FLOOR_ERROR_MARK.length).slice(0, 200)}` }
  const stderr = String(res.stderr ?? '')
  if (
    res.signal === 'SIGILL' ||
    res.status === ILLEGAL_INSTRUCTION_STATUS ||
    res.status === ILLEGAL_INSTRUCTION_STATUS - 2 ** 32 ||
    (res.signal !== null && /illegal instruction/i.test(stderr))
  ) {
    return { state: 'unmet', via: 'helper', missing: [], faulted: true }
  }
  const code = (res.error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ETIMEDOUT') return { state: 'unknown', via: 'helper', note: `the helper process gave no answer within ${Math.round(timeout / 1000)}s` }
  if (res.error) return { state: 'unknown', via: 'helper', note: `the helper process could not start: ${res.error.message}` }
  const why = res.signal ? `signal ${res.signal}` : `exit ${String(res.status)}`
  const lines = stderr.split('\n').map(l => l.trim()).filter(l => l !== '' && !/^Node\.js v\d/.test(l))
  const lastErr = lines.find(l => /\berror\b/i.test(l)) ?? lines.slice(-1)[0] ?? ''
  return { state: 'unknown', via: 'helper', note: `the helper process ended with ${why} before answering${lastErr ? ` (${lastErr.slice(0, 160)})` : ''}` }
}

let floorProbe: { addonPath: string | null; probe: CpuFloorProbe } | null = null
let seededProbe: CpuFloorProbe | null = null

export function probeCpuFloor(opts: { addonPath?: string | null; arch?: string; platform?: string; helper?: CpuFloorHelperOptions } = {}): CpuFloorProbe {
  if (seededProbe !== null) return seededProbe
  const arch = opts.arch ?? process.arch
  const platform = opts.platform ?? process.platform
  const addonPath = opts.addonPath ?? null
  const live = arch === process.arch && platform === process.platform && opts.helper === undefined
  if (live && floorProbe !== null && floorProbe.addonPath === addonPath) return floorProbe.probe
  let probe: CpuFloorProbe
  if (arch !== 'x64') probe = { state: 'met', via: 'architecture' }
  else {
    const flags = platform === 'win32' ? null : reportedCpuFlags(platform)
    if (flags !== null) {
      const missing = WHISPER_CPU_FLOOR_X64.filter(f => !flags.has(f))
      probe = missing.length === 0 ? { state: 'met', via: 'flags' } : { state: 'unmet', via: 'flags', missing: [...missing] }
    } else if (addonPath !== null) {
      probe = probeCpuFloorByLoad(addonPath, opts.helper ?? {})
    } else {
      probe = { state: 'unknown', via: 'flags', note: platform === 'win32' ? 'Windows keeps no instruction-set list and no pack was given to load' : `${platform} reported no instruction-set flags and no pack was given to load` }
    }
  }
  if (live) floorProbe = { addonPath, probe }
  return probe
}

export function seedCpuFloorProbeForTest(probe: CpuFloorProbe | null): void {
  seededProbe = probe
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
  const floor = probeCpuFloor({ addonPath: resolution.addonPath })
  if (floor.state !== 'met') {
    loaded = { state: 'unavailable', note: `${cpuFloorRefusal(floor)}; the cloud road serves` }
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
  seededProbe = null
}
