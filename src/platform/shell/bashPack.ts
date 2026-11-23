import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { brushPackTreeDigest } from './brushPack.js'
import { describeArtifactIdentity } from '../product/artifactIdentity.js'
import { passedOver } from '../errors/passedOver.js'
import { packPlatformFor } from '../host-os/programs.js'
import { mercuryInstallUpdateCommand } from '../host-os/words.js'

const BASH_PACK_SEGMENTS = ['vendor', 'bash'] as const
export const BASH_PACK_PATH = BASH_PACK_SEGMENTS.join('/')
export const BASH_PACK_NAME = 'bash'
export const BASH_PACK_BINARY = 'bash'
export const BASH_PACK_MANIFEST_FILE = '.vendor-manifest.json'
const BASH_PACK_PREPARE = 'bun run scripts/vendor/build-bash.ts'
const BASH_WIN_PACK_PREPARE = 'bun run scripts/vendor/fetch-bash-win.ts'

export const BASH_PACK_PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win-x64', 'win-arm64'] as const
export type BashPackPlatform = (typeof BASH_PACK_PLATFORMS)[number]

export function bashPackPlatform(platform: string = process.platform, arch: string = process.arch): BashPackPlatform | null {
  return packPlatformFor(platform, arch)
}

export function bashPackIsFetched(packPlatform: string): boolean {
  return packPlatform.startsWith('win-')
}

export function bashPrepareCommand(packPlatform: string, cross: boolean): string {
  if (bashPackIsFetched(packPlatform)) return `${BASH_WIN_PACK_PREPARE}${cross ? ` --platform ${packPlatform}` : ''} (a download of the pinned MSYS2 packages)`
  return `${BASH_PACK_PREPARE}${cross ? ` --platform ${packPlatform}` : ''} (needs ${packPlatform.startsWith('linux-') ? 'docker' : 'the Xcode command line tools'})`
}

interface BashPackManifestBase {
  name: typeof BASH_PACK_NAME
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
  fileCount: number
  treeDigest: string
}

interface BashTarballManifest extends BashPackManifestBase {
  source: 'gnu-tarball'
  tarballSha256: string
  patchesSha256: string
  configure: string[]
  toolchain: string
  links: string[]
}

interface BashMsys2Package {
  name: string
  version: string
  file: string
  sha256: string
  license: string
  sourceFile: string
  sourceSha256: string
}

export interface BashMsys2Manifest extends BashPackManifestBase {
  source: 'msys2-packages'
  emulated: boolean
  runtime: string
  runtimeVersion: string
  runtimeSha256: string
  programsDir: string
  programs: string[]
  packages: BashMsys2Package[]
  databaseSha256: string
}

export type BashPackManifest = BashTarballManifest | BashMsys2Manifest

const HEX64 = /^[0-9a-f]{64}$/

export function bashPatchesDigest(patches: ReadonlyArray<{ file: string; sha256: string }>): string {
  return createHash('sha256').update(patches.map(patch => `${patch.file} ${patch.sha256}`).join('\n')).digest('hex')
}

export function bashPackTreeDigest(dir: string): { fileCount: number; treeDigest: string } {
  return brushPackTreeDigest(dir)
}

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string')

const isHex = (value: unknown): value is string => typeof value === 'string' && HEX64.test(value)

function msys2Packages(value: unknown): BashMsys2Package[] | null {
  if (!Array.isArray(value)) return null
  const out: BashMsys2Package[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null
    const p = item as Record<string, unknown>
    if (typeof p.name !== 'string' || typeof p.version !== 'string' || typeof p.file !== 'string' || !isHex(p.sha256) || typeof p.license !== 'string' || typeof p.sourceFile !== 'string' || !isHex(p.sourceSha256)) return null
    out.push({ name: p.name, version: p.version, file: p.file, sha256: p.sha256, license: p.license, sourceFile: p.sourceFile, sourceSha256: p.sourceSha256 })
  }
  return out
}

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
    typeof m.version !== 'string' ||
    typeof m.patchLevel !== 'number' ||
    typeof m.bashVersion !== 'string' ||
    typeof m.platform !== 'string' ||
    typeof m.target !== 'string' ||
    typeof m.binary !== 'string' ||
    !isHex(m.binarySha256) ||
    typeof m.license !== 'string' ||
    !isStrings(m.licenseFiles) ||
    typeof m.sourceNote !== 'string' ||
    typeof m.fileCount !== 'number' ||
    !isHex(m.treeDigest)
  ) {
    return null
  }
  const base: BashPackManifestBase = {
    name: BASH_PACK_NAME,
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
    fileCount: m.fileCount,
    treeDigest: m.treeDigest,
  }
  if (m.source === 'gnu-tarball') {
    if (!isHex(m.tarballSha256) || !isHex(m.patchesSha256) || !isStrings(m.configure) || typeof m.toolchain !== 'string' || !isStrings(m.links)) return null
    return { ...base, source: 'gnu-tarball', tarballSha256: m.tarballSha256, patchesSha256: m.patchesSha256, configure: m.configure, toolchain: m.toolchain, links: m.links }
  }
  if (m.source === 'msys2-packages') {
    const packages = msys2Packages(m.packages)
    if (typeof m.emulated !== 'boolean' || typeof m.runtime !== 'string' || typeof m.runtimeVersion !== 'string' || !isHex(m.runtimeSha256) || typeof m.programsDir !== 'string' || !isStrings(m.programs) || packages === null || !isHex(m.databaseSha256)) return null
    return {
      ...base,
      source: 'msys2-packages',
      emulated: m.emulated,
      runtime: m.runtime,
      runtimeVersion: m.runtimeVersion,
      runtimeSha256: m.runtimeSha256,
      programsDir: m.programsDir,
      programs: m.programs,
      packages,
      databaseSha256: m.databaseSha256,
    }
  }
  return null
}

type BashPackCheck =
  | { state: 'ok'; binaryPath: string; manifest: BashPackManifest }
  | { state: 'absent'; note: string }
  | { state: 'mismatch'; note: string }

export function checkBashPackDir(dir: string, opts: { digest?: boolean; tree?: boolean; platform?: string } = {}): BashPackCheck {
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
  if ((manifest.source === 'msys2-packages') !== bashPackIsFetched(platform)) {
    return { state: 'mismatch', note: `the pack at ${dir} is ${manifest.source}, which is not how the ${platform} pack is made` }
  }
  const binaryPath = path.join(dir, manifest.binary)
  if (!existsSync(binaryPath)) return { state: 'mismatch', note: `the manifest at ${dir} names ${manifest.binary} but the file is absent` }
  for (const file of [...manifest.licenseFiles, manifest.sourceNote, ...(manifest.source === 'msys2-packages' ? [manifest.runtime] : [])]) {
    if (!existsSync(path.join(dir, file))) return { state: 'mismatch', note: `the pack at ${dir} lacks ${file}` }
  }
  if (opts.digest) {
    const actual = createHash('sha256').update(readFileSync(binaryPath)).digest('hex')
    if (actual !== manifest.binarySha256) {
      return { state: 'mismatch', note: `${manifest.binary} does not match the manifest digest (expected ${manifest.binarySha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…)` }
    }
  }
  if (opts.tree) {
    const tree = bashPackTreeDigest(dir)
    if (tree.fileCount !== manifest.fileCount || tree.treeDigest !== manifest.treeDigest) {
      return { state: 'mismatch', note: `the files at ${dir} are not the ones its record counts (${tree.fileCount} files, tree digest ${tree.treeDigest.slice(0, 12)}…; the record says ${manifest.fileCount} and ${manifest.treeDigest.slice(0, 12)}…)` }
    }
  }
  return { state: 'ok', binaryPath, manifest }
}

export function bashPackProgramsDir(dir: string, manifest: BashPackManifest): string | null {
  return manifest.source === 'msys2-packages' ? path.join(dir, manifest.programsDir) : null
}

export interface BashMsys2Lock {
  version: string
  platforms: Record<string, { kind?: string; target: string; binary?: string; runtime?: string; emulated?: boolean }>
  msys2?: {
    bashVersion: string
    runtimeVersion: string
    database: { sha256: string }
    packages: ReadonlyArray<{ file: string; sha256: string; source: { file: string; sha256: string } }>
  }
}

export function bashMsys2LockMismatch(manifest: BashMsys2Manifest, lock: BashMsys2Lock, platform: string): string | null {
  const entry = lock.platforms[platform]
  const block = lock.msys2
  if (entry === undefined || entry.kind !== 'msys2' || block === undefined) return `the lock names no MSYS2 pack for ${platform}`
  if (manifest.version !== lock.version || manifest.bashVersion !== block.bashVersion) return `the pack is bash ${manifest.bashVersion}, the lock pins ${block.bashVersion}`
  if (manifest.runtimeVersion !== block.runtimeVersion) return `the pack's runtime is ${manifest.runtimeVersion}, the lock pins ${block.runtimeVersion}`
  if (manifest.target !== entry.target || manifest.binary !== entry.binary || manifest.runtime !== entry.runtime || manifest.emulated !== (entry.emulated === true)) return `the pack's target, binary or runtime is not the lock's for ${platform}`
  if (manifest.databaseSha256 !== block.database.sha256) return "the pack was laid out from another package database than the lock's"
  const pinned = block.packages.map(entry => `${entry.file} ${entry.sha256} ${entry.source.file} ${entry.source.sha256}`).join('\n')
  const held = manifest.packages.map(entry => `${entry.file} ${entry.sha256} ${entry.sourceFile} ${entry.sourceSha256}`).join('\n')
  return pinned === held ? null : "the pack's packages are not the lock's"
}

export type BashPackResolution =
  | { state: 'ok'; dir: string; binaryPath: string; manifest: BashPackManifest; source: 'vendored' | 'workspace' }
  | { state: 'unavailable'; note: string }

function restoringInstallCommand(): string | null {
  const identity = describeArtifactIdentity('')
  if (identity.distribution !== 'packaged-install' || identity.entry === null) return null
  if (!existsSync(path.join(path.dirname(path.dirname(identity.entry)), 'current.txt'))) return null
  try {
    const manifest = JSON.parse(readFileSync(path.join(path.dirname(identity.entry), 'manifest.json'), 'utf8')) as { bash?: { vendored?: boolean } }
    if (manifest.bash?.vendored === false) return null
  } catch (error) {
    passedOver(error)
  }
  return mercuryInstallUpdateCommand(identity.entry)
}

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
  const reinstall = restoringInstallCommand()
  return {
    state: 'unavailable',
    note: `no bash pack for ${platform}: neither ${BASH_PACK_PATH}/${platform} beside the bundle nor the checkout's own (${reinstall === null ? `prepare it: ${bashPrepareCommand(platform, false)}, then rebuild` : `reinstall Mercury to restore it: ${reinstall}`})`,
  }
}
