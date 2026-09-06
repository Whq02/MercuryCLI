#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { extractTarGz } from './tarExtract.ts'
import {
  BRUSH_PACK_MANIFEST_FILE,
  BRUSH_PACK_NAME,
  BRUSH_PACK_PATH,
  BRUSH_PACK_PLATFORMS,
  brushBinaryFor,
  brushPackPlatform,
  brushPackTreeDigest,
  checkBrushPackDir,
  type BrushPackManifest,
  type BrushPackPlatform,
} from '../../src/utils/shell/brushPack.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const LOCK_PATH = join(ROOT, 'vendor', 'brush.lock.json')
const PACK_ROOT = join(ROOT, ...BRUSH_PACK_PATH.split('/'))
const ARCHIVE_DIR = join(PACK_ROOT, 'archive')

interface LockFetchEntry {
  kind?: 'fetch'
  target: string
  archive: string
  url: string
  checksum: string
  sha256: string
}
interface LockBuildEntry {
  kind: 'build'
  target: string
  crate: string
  crateVersion: string
  crateSha256: string | null
}
type LockPlatform = LockFetchEntry | LockBuildEntry
const isBuildEntry = (p: LockPlatform): p is LockBuildEntry => p.kind === 'build'

interface Lock {
  name: string
  version: string
  tag: string
  repository: string
  license: string
  licenseFiles: string[]
  platforms: Record<string, LockPlatform>
}

const argv = process.argv.slice(2)
const checkOnly = argv.includes('--check')
const force = argv.includes('--force')
const all = argv.includes('--all')

function fail(msg: string): never {
  console.error(`fetch-brush: ${msg}`)
  process.exit(1)
}

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

function readLock(): Lock {
  if (!existsSync(LOCK_PATH)) fail(`lock file missing: ${LOCK_PATH}`)
  const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8')) as Lock
  for (const key of ['name', 'version', 'tag', 'license'] as const) {
    if (!lock[key]) fail(`lock is missing '${key}'`)
  }
  if (lock.name !== BRUSH_PACK_NAME) fail(`lock names ${lock.name}, not ${BRUSH_PACK_NAME}`)
  if (!Array.isArray(lock.licenseFiles) || lock.licenseFiles.length === 0) fail('lock names no licence files')
  if (typeof lock.platforms !== 'object' || lock.platforms === null) fail('lock names no platforms')
  for (const [platform, p] of Object.entries(lock.platforms)) {
    if (!(BRUSH_PACK_PLATFORMS as readonly string[]).includes(platform)) fail(`lock entry ${platform} is not a pack platform`)
    if (isBuildEntry(p)) {
      if (!p.target || !p.crate || !p.crateVersion) fail(`lock entry ${platform} (a build entry) lacks target/crate/crateVersion`)
      continue
    }
    if (!p.target || !p.archive || !p.url || !p.checksum) fail(`lock entry ${platform} lacks target/archive/url/checksum`)
    if (!/^[0-9a-f]{64}$/.test(p.sha256)) fail(`lock entry ${platform} sha256 is not a 64-hex digest`)
    const prefix = `${lock.repository}/releases/download/${lock.tag}/`
    if (!p.url.startsWith(prefix)) fail(`lock entry ${platform} url is not an asset of the pinned release ${lock.tag}`)
    if (!p.checksum.startsWith(prefix)) fail(`lock entry ${platform} checksum url is not an asset of the pinned release ${lock.tag}`)
  }
  return lock
}

function selectPlatforms(lock: Lock): BrushPackPlatform[] {
  const fetched = Object.entries(lock.platforms).filter(([, p]) => !isBuildEntry(p)).map(([k]) => k) as BrushPackPlatform[]
  if (all) return fetched
  const named: BrushPackPlatform[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--platform') continue
    const value = argv[i + 1]
    if (!value || !(fetched as readonly string[]).includes(value)) {
      const entry = value ? lock.platforms[value] : undefined
      if (entry && isBuildEntry(entry)) fail(`--platform ${value} is a build entry — that pack is compiled from the published crate by bun run scripts/vendor/build-brush.ts, never fetched`)
      fail(`--platform wants one of ${fetched.join(', ')} (got ${value ?? 'nothing'})`)
    }
    named.push(value as BrushPackPlatform)
    i++
  }
  if (named.length > 0) return [...new Set(named)]
  const host = brushPackPlatform(process.platform, process.arch)
  const entry = host === null ? undefined : lock.platforms[host]
  if (host === null || entry === undefined || isBuildEntry(entry)) {
    console.log(
      `fetch-brush: the lock pins no upstream release binary for ${process.platform}/${process.arch}${host ? ` (${host})` : ''} — nothing to fetch here; ` +
        'the build ships without the vendored shell engine and says so (degraded: shell-engine; the system bash stays the Bash tool\'s engine). ' +
        (entry && isBuildEntry(entry)
          ? `That platform's pack is BUILT from the published crate: bun run scripts/vendor/build-brush.ts (cargo).`
          : "That platform's pack is prepared on its own road."),
    )
    process.exit(0)
  }
  return [host]
}

function packDirFor(platform: string): string {
  return join(PACK_ROOT, platform)
}

function cacheInvalidReason(lock: Lock, platform: BrushPackPlatform): string | null {
  const dir = packDirFor(platform)
  const check = checkBrushPackDir(dir, { digest: true, platform })
  if (check.state !== 'ok') return check.note
  const pinned = lock.platforms[platform]!
  if (isBuildEntry(pinned)) return "the lock builds this platform's pack (bun run scripts/vendor/build-brush.ts), the fetch never prepares it"
  const manifest = check.manifest
  if (manifest.source !== 'release-archive') return 'the cache was built from the crate with cargo, not fetched from the pinned release'
  if (manifest.version !== lock.version) return `cache is ${manifest.version}, lock wants ${lock.version}`
  if (manifest.archiveSha256 !== pinned.sha256) return 'cache archiveSha256 does not match the lock'
  if (manifest.target !== pinned.target) return `cache target ${manifest.target} is not the lock's ${pinned.target}`
  for (const file of lock.licenseFiles) {
    if (!manifest.licenseFiles.includes(file) || !existsSync(join(dir, file))) return `licence file missing: ${file}`
  }
  const tree = brushPackTreeDigest(dir)
  if (tree.fileCount !== manifest.fileCount) return `file count drifted: ${tree.fileCount} on disk vs ${manifest.fileCount} in the manifest`
  if (tree.treeDigest !== manifest.treeDigest) return 'treeDigest mismatch (pack content drifted)'
  return null
}

function installSelected(lock: Lock, platform: BrushPackPlatform, archivePath: string): void {
  const dir = packDirFor(platform)
  const tmpUnpack = `${dir}.unpack-${process.pid}`
  const tmp = `${dir}.tmp-${process.pid}`
  rmSync(tmpUnpack, { recursive: true, force: true })
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmpUnpack, { recursive: true })
  mkdirSync(tmp, { recursive: true })
  const tar = extractTarGz({ tarballPath: archivePath, destDir: tmpUnpack, stripComponents: 0 })
  if (!tar.ok) {
    rmSync(tmpUnpack, { recursive: true, force: true })
    rmSync(tmp, { recursive: true, force: true })
    fail(`tar extraction failed: ${tar.message}`)
  }
  const binary = brushBinaryFor(platform)
  for (const member of [binary, ...lock.licenseFiles]) {
    const from = join(tmpUnpack, member)
    if (!existsSync(from)) {
      rmSync(tmpUnpack, { recursive: true, force: true })
      rmSync(tmp, { recursive: true, force: true })
      fail(`archive has no ${member} — refusing to install`)
    }
    copyFileSync(from, join(tmp, member))
  }
  rmSync(tmpUnpack, { recursive: true, force: true })
  if (process.platform !== 'win32' && !binary.endsWith('.exe')) chmodSync(join(tmp, binary), 0o755)
  const pinned = lock.platforms[platform]!
  if (isBuildEntry(pinned)) fail(`${platform} is a build entry — never fetched`)
  const tree = brushPackTreeDigest(tmp)
  const manifest: BrushPackManifest = {
    name: BRUSH_PACK_NAME,
    source: 'release-archive',
    version: lock.version,
    platform,
    target: pinned.target,
    archive: pinned.archive,
    archiveSha256: pinned.sha256,
    binary,
    binarySha256: sha256(readFileSync(join(tmp, binary))),
    license: lock.license,
    licenseFiles: [...lock.licenseFiles],
    fileCount: tree.fileCount,
    treeDigest: tree.treeDigest,
  }
  writeFileSync(join(tmp, BRUSH_PACK_MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(PACK_ROOT, { recursive: true })
  renameSync(tmp, dir)
  console.log(`fetch-brush: installed ${binary} + ${lock.licenseFiles.join(', ')} → ${BRUSH_PACK_PATH}/${platform} (treeDigest ${manifest.treeDigest.slice(0, 12)}…)`)
}

async function secureArchive(lock: Lock, platform: BrushPackPlatform): Promise<string> {
  const pinned = lock.platforms[platform]!
  if (isBuildEntry(pinned)) fail(`${platform} is a build entry — never fetched`)
  mkdirSync(ARCHIVE_DIR, { recursive: true })
  const archivePath = join(ARCHIVE_DIR, pinned.archive)
  if (existsSync(archivePath) && !force) {
    const local = readFileSync(archivePath)
    if (sha256(local) === pinned.sha256) {
      console.log(`fetch-brush: reusing verified local archive (${pinned.archive})`)
      return archivePath
    }
    console.log(`fetch-brush: local archive ${pinned.archive} does not match the lock — re-downloading`)
  }
  console.log(`fetch-brush: downloading ${pinned.url}`)
  const res = await fetch(pinned.url)
  if (!res.ok) fail(`download failed for ${platform}: HTTP ${res.status} ${res.statusText}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const digest = sha256(buf)
  if (digest !== pinned.sha256) {
    fail(`sha256 mismatch for ${pinned.archive}: got ${digest.slice(0, 24)}…, lock pins ${pinned.sha256.slice(0, 24)}… — refusing (artifact identity changed)`)
  }
  writeFileSync(archivePath, buf)
  console.log(`fetch-brush: verified sha256 ${digest.slice(0, 12)}… (${buf.byteLength} bytes)`)
  return archivePath
}

async function main(): Promise<void> {
  const lock = readLock()
  const platforms = selectPlatforms(lock)

  if (checkOnly) {
    let stale = 0
    for (const platform of platforms) {
      const invalid = cacheInvalidReason(lock, platform)
      if (invalid === null) {
        console.log(`fetch-brush --check: OK — ${BRUSH_PACK_NAME} ${lock.version} ${platform} pack valid against the lock`)
      } else {
        stale++
        console.error(`fetch-brush --check: STALE — ${platform}: ${invalid}`)
      }
    }
    if (stale > 0) {
      console.error('  remedy: bun run scripts/vendor/fetch-brush.ts (downloads the pinned archive, verifies sha256, installs the binary + licence files)')
      process.exit(2)
    }
    process.exit(0)
  }

  for (const platform of platforms) {
    const invalid = cacheInvalidReason(lock, platform)
    if (invalid === null && !force) {
      console.log(`fetch-brush: pack already valid for ${BRUSH_PACK_NAME} ${lock.version} ${platform} — nothing to do (--force re-fetches)`)
      continue
    }
    const archivePath = await secureArchive(lock, platform)
    installSelected(lock, platform, archivePath)
    const post = cacheInvalidReason(lock, platform)
    if (post !== null) fail(`post-extraction validation failed for ${platform}: ${post}`)
    const size = statSync(join(packDirFor(platform), brushBinaryFor(platform))).size
    console.log(`fetch-brush: DONE — ${BRUSH_PACK_NAME} ${lock.version} ${platform} ready for the build (${size} bytes; bun run build.ts)`)
  }
}

void main()
