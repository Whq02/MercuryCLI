import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const BRUSH_PACK_PATH = 'vendor/brush'
export const BRUSH_PACK_NAME = 'brush'
export const BRUSH_PACK_MANIFEST_FILE = '.vendor-manifest.json'

export const BRUSH_PACK_PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win-x64'] as const
export type BrushPackPlatform = (typeof BRUSH_PACK_PLATFORMS)[number]

export function brushPackPlatform(platform: string = process.platform, arch: string = process.arch): BrushPackPlatform | null {
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64'
  if (platform === 'darwin' && arch === 'x64') return 'darwin-x64'
  if (platform === 'linux' && arch === 'x64') return 'linux-x64'
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64'
  if (platform === 'win32' && arch === 'x64') return 'win-x64'
  return null
}

export function brushBinaryFor(packPlatform: string): string {
  return packPlatform === 'win-x64' ? 'brush.exe' : 'brush'
}

export interface BrushPackManifest {
  name: typeof BRUSH_PACK_NAME
  version: string
  platform: string
  target: string
  archive: string
  archiveSha256: string
  binary: string
  binarySha256: string
  license: string
  licenseFiles: string[]
  fileCount: number
  treeDigest: string
}

const HEX64 = /^[0-9a-f]{64}$/

function walkDigests(dir: string, base: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const full = path.join(dir, entry.name)
    const rel = path.relative(base, full).split(path.sep).join('/')
    if (rel === BRUSH_PACK_MANIFEST_FILE) continue
    if (entry.isDirectory()) out.push(...walkDigests(full, base))
    else if (entry.isFile()) out.push(`${rel} ${createHash('sha256').update(readFileSync(full)).digest('hex')}`)
  }
  return out
}

export function brushPackTreeDigest(dir: string): { fileCount: number; treeDigest: string } {
  const lines = walkDigests(dir, dir)
  return { fileCount: lines.length, treeDigest: createHash('sha256').update(lines.join('\n')).digest('hex') }
}

export function readBrushPackManifest(dir: string): BrushPackManifest | null {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path.join(dir, BRUSH_PACK_MANIFEST_FILE), 'utf8'))
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const m = raw as Record<string, unknown>
  if (
    m.name !== BRUSH_PACK_NAME ||
    typeof m.version !== 'string' ||
    typeof m.platform !== 'string' ||
    typeof m.target !== 'string' ||
    typeof m.archive !== 'string' ||
    typeof m.archiveSha256 !== 'string' ||
    !HEX64.test(m.archiveSha256) ||
    typeof m.binary !== 'string' ||
    typeof m.binarySha256 !== 'string' ||
    !HEX64.test(m.binarySha256) ||
    typeof m.license !== 'string' ||
    !Array.isArray(m.licenseFiles) ||
    !(m.licenseFiles as unknown[]).every(f => typeof f === 'string') ||
    typeof m.fileCount !== 'number' ||
    typeof m.treeDigest !== 'string' ||
    !HEX64.test(m.treeDigest)
  ) {
    return null
  }
  return {
    name: BRUSH_PACK_NAME,
    version: m.version,
    platform: m.platform,
    target: m.target,
    archive: m.archive,
    archiveSha256: m.archiveSha256,
    binary: m.binary,
    binarySha256: m.binarySha256,
    license: m.license,
    licenseFiles: m.licenseFiles as string[],
    fileCount: m.fileCount,
    treeDigest: m.treeDigest,
  }
}

export type BrushPackCheck =
  | { state: 'ok'; binaryPath: string; manifest: BrushPackManifest }
  | { state: 'absent'; note: string }
  | { state: 'mismatch'; note: string }

export function checkBrushPackDir(dir: string, opts: { digest?: boolean; platform?: string } = {}): BrushPackCheck {
  const manifest = readBrushPackManifest(dir)
  if (manifest === null) {
    return { state: 'absent', note: existsSync(dir) ? `${dir} carries no readable ${BRUSH_PACK_MANIFEST_FILE}` : `${dir} is absent` }
  }
  const platform = opts.platform ?? brushPackPlatform()
  if (platform === null) {
    return { state: 'mismatch', note: `no shell-engine pack layout exists for ${process.platform}/${process.arch}` }
  }
  if (manifest.platform !== platform) {
    return { state: 'mismatch', note: `the pack at ${dir} was fetched for ${manifest.platform}, this host is ${platform}` }
  }
  const binaryPath = path.join(dir, manifest.binary)
  if (!existsSync(binaryPath)) return { state: 'mismatch', note: `the manifest at ${dir} names ${manifest.binary} but the file is absent` }
  for (const file of manifest.licenseFiles) {
    if (!existsSync(path.join(dir, file))) return { state: 'mismatch', note: `the pack at ${dir} lacks its licence file ${file}` }
  }
  if (opts.digest) {
    const actual = createHash('sha256').update(readFileSync(binaryPath)).digest('hex')
    if (actual !== manifest.binarySha256) {
      return { state: 'mismatch', note: `${manifest.binary} does not match the manifest digest (expected ${manifest.binarySha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…)` }
    }
  }
  return { state: 'ok', binaryPath, manifest }
}

export type BrushPackResolution =
  | { state: 'ok'; dir: string; binaryPath: string; manifest: BrushPackManifest; source: 'vendored' | 'workspace' }
  | { state: 'unavailable'; note: string }

export function resolveBrushPackDir(moduleDir: string = path.dirname(fileURLToPath(import.meta.url))): BrushPackResolution {
  const platform = brushPackPlatform()
  if (platform === null) {
    return { state: 'unavailable', note: `no shell-engine pack exists for ${process.platform}/${process.arch}` }
  }
  const vendored = path.join(moduleDir, ...BRUSH_PACK_PATH.split('/'), platform)
  const vendoredCheck = checkBrushPackDir(vendored, { platform })
  if (vendoredCheck.state === 'ok') {
    return { state: 'ok', dir: vendored, binaryPath: vendoredCheck.binaryPath, manifest: vendoredCheck.manifest, source: 'vendored' }
  }
  let dir = moduleDir
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, ...BRUSH_PACK_PATH.split('/'), platform)
    const check = checkBrushPackDir(candidate, { platform })
    if (check.state === 'ok') return { state: 'ok', dir: candidate, binaryPath: check.binaryPath, manifest: check.manifest, source: 'workspace' }
    if (check.state === 'mismatch') return { state: 'unavailable', note: check.note }
    if (existsSync(path.join(dir, 'package.json')) || existsSync(path.join(dir, '.git'))) break
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  if (vendoredCheck.state === 'mismatch') return { state: 'unavailable', note: vendoredCheck.note }
  return {
    state: 'unavailable',
    note: `no shell-engine pack for ${platform}: neither ${BRUSH_PACK_PATH}/${platform} beside the bundle nor the checkout's own (prepare it: bun run scripts/vendor/fetch-brush.ts, then rebuild)`,
  }
}
