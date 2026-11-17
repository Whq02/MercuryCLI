import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { brushPackTreeDigest } from './brushPack.js'

const BASH_PACK_SEGMENTS = ['vendor', 'bash'] as const
export const BASH_PACK_PATH = BASH_PACK_SEGMENTS.join('/')
export const BASH_PACK_NAME = 'bash'
export const BASH_PACK_BINARY = 'bash'
export const BASH_PACK_MANIFEST_FILE = '.vendor-manifest.json'
const BASH_PACK_PREPARE = 'bun run scripts/vendor/build-bash.ts'

export const BASH_PACK_PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'] as const
export type BashPackPlatform = (typeof BASH_PACK_PLATFORMS)[number]

export function bashPackPlatform(platform: string = process.platform, arch: string = process.arch): BashPackPlatform | null {
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64'
  if (platform === 'darwin' && arch === 'x64') return 'darwin-x64'
  if (platform === 'linux' && arch === 'x64') return 'linux-x64'
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64'
  return null
}

export function bashPrepareCommand(packPlatform: string, cross: boolean): string {
  return `${BASH_PACK_PREPARE}${cross ? ` --platform ${packPlatform}` : ''} (needs ${packPlatform.startsWith('linux-') ? 'docker' : 'the Xcode command line tools'})`
}

export interface BashPackManifest {
  name: typeof BASH_PACK_NAME
  source: 'gnu-tarball'
  version: string
  patchLevel: number
  bashVersion: string
  platform: string
  target: string
  binary: string
  binarySha256: string
  license: string
  licenseFiles: string[]
  sourceNote: string
  tarballSha256: string
  patchesSha256: string
  configure: string[]
  toolchain: string
  links: string[]
  fileCount: number
  treeDigest: string
}

const HEX64 = /^[0-9a-f]{64}$/

export function bashPatchesDigest(patches: ReadonlyArray<{ file: string; sha256: string }>): string {
  return createHash('sha256').update(patches.map(patch => `${patch.file} ${patch.sha256}`).join('\n')).digest('hex')
}

export function bashPackTreeDigest(dir: string): { fileCount: number; treeDigest: string } {
  return brushPackTreeDigest(dir)
}

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string')

export function readBashPackManifest(dir: string): BashPackManifest | null {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path.join(dir, BASH_PACK_MANIFEST_FILE), 'utf8'))
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR'))) return null
    throw error
  }
  if (typeof raw !== 'object' || raw === null) return null
  const m = raw as Record<string, unknown>
  if (
    m.name !== BASH_PACK_NAME ||
    m.source !== 'gnu-tarball' ||
    typeof m.version !== 'string' ||
    typeof m.patchLevel !== 'number' ||
    typeof m.bashVersion !== 'string' ||
    typeof m.platform !== 'string' ||
    typeof m.target !== 'string' ||
    typeof m.binary !== 'string' ||
    typeof m.binarySha256 !== 'string' ||
    !HEX64.test(m.binarySha256) ||
    typeof m.license !== 'string' ||
    !isStrings(m.licenseFiles) ||
    typeof m.sourceNote !== 'string' ||
    typeof m.tarballSha256 !== 'string' ||
    !HEX64.test(m.tarballSha256) ||
    typeof m.patchesSha256 !== 'string' ||
    !HEX64.test(m.patchesSha256) ||
    !isStrings(m.configure) ||
    typeof m.toolchain !== 'string' ||
    !isStrings(m.links) ||
    typeof m.fileCount !== 'number' ||
    typeof m.treeDigest !== 'string' ||
    !HEX64.test(m.treeDigest)
  ) {
    return null
  }
  return {
    name: BASH_PACK_NAME,
    source: 'gnu-tarball',
    version: m.version,
    patchLevel: m.patchLevel,
    bashVersion: m.bashVersion,
    platform: m.platform,
    target: m.target,
    binary: m.binary,
    binarySha256: m.binarySha256,
    license: m.license,
    licenseFiles: m.licenseFiles,
    sourceNote: m.sourceNote,
    tarballSha256: m.tarballSha256,
    patchesSha256: m.patchesSha256,
    configure: m.configure,
    toolchain: m.toolchain,
    links: m.links,
    fileCount: m.fileCount,
    treeDigest: m.treeDigest,
  }
}

type BashPackCheck =
  | { state: 'ok'; binaryPath: string; manifest: BashPackManifest }
  | { state: 'absent'; note: string }
  | { state: 'mismatch'; note: string }

export function checkBashPackDir(dir: string, opts: { digest?: boolean; platform?: string } = {}): BashPackCheck {
  const manifest = readBashPackManifest(dir)
  if (manifest === null) {
    return { state: 'absent', note: existsSync(dir) ? `${dir} carries no readable ${BASH_PACK_MANIFEST_FILE}` : `${dir} is absent` }
  }
  const platform = opts.platform ?? bashPackPlatform()
  if (platform === null) {
    return { state: 'mismatch', note: `no bash pack layout exists for ${process.platform}/${process.arch}` }
  }
  if (manifest.platform !== platform) {
    return { state: 'mismatch', note: `the pack at ${dir} was built for ${manifest.platform}, this host is ${platform}` }
  }
  const binaryPath = path.join(dir, manifest.binary)
  if (!existsSync(binaryPath)) return { state: 'mismatch', note: `the manifest at ${dir} names ${manifest.binary} but the file is absent` }
  for (const file of [...manifest.licenseFiles, manifest.sourceNote]) {
    if (!existsSync(path.join(dir, file))) return { state: 'mismatch', note: `the pack at ${dir} lacks ${file}` }
  }
  if (opts.digest) {
    const actual = createHash('sha256').update(readFileSync(binaryPath)).digest('hex')
    if (actual !== manifest.binarySha256) {
      return { state: 'mismatch', note: `${manifest.binary} does not match the manifest digest (expected ${manifest.binarySha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…)` }
    }
  }
  return { state: 'ok', binaryPath, manifest }
}

export type BashPackResolution =
  | { state: 'ok'; dir: string; binaryPath: string; manifest: BashPackManifest; source: 'vendored' | 'workspace' }
  | { state: 'unavailable'; note: string }

export function resolveBashPackDir(moduleDir: string = path.dirname(fileURLToPath(import.meta.url))): BashPackResolution {
  const platform = bashPackPlatform()
  if (platform === null) {
    return { state: 'unavailable', note: `no bash pack exists for ${process.platform}/${process.arch}` }
  }
  const vendored = path.join(moduleDir, ...BASH_PACK_SEGMENTS, platform)
  const vendoredCheck = checkBashPackDir(vendored, { platform })
  if (vendoredCheck.state === 'ok') {
    return { state: 'ok', dir: vendored, binaryPath: vendoredCheck.binaryPath, manifest: vendoredCheck.manifest, source: 'vendored' }
  }
  let dir = moduleDir
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, ...BASH_PACK_SEGMENTS, platform)
    const check = checkBashPackDir(candidate, { platform })
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
    note: `no bash pack for ${platform}: neither ${BASH_PACK_PATH}/${platform} beside the bundle nor the checkout's own (prepare it: ${bashPrepareCommand(platform, false)}, then rebuild)`,
  }
}
