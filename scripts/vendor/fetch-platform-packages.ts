#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { RELEASE_TARGETS, buildPlatformOf, isReleaseTarget, releaseTargetFor, type ReleaseTarget } from '../../src/services/privateChannel/releaseTarget.ts'
import { integrityOf, lockedPackage, platformPackagesCacheDir, platformPackagesFor, registryTarballUrl, resolvePlatformPackage, type LockedPackage } from './platformPackages.ts'
import { extractTarGz } from './tarExtract.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const LOCK_PATH = join(ROOT, 'bun.lock')

interface PackageRecord {
  version: string
  integrity: string
  fileCount: number
  treeDigest: string
}

interface CacheManifest {
  target: ReleaseTarget
  platform: string
  arch: string
  packages: Record<string, PackageRecord>
}

const argv = process.argv.slice(2)
const checkOnly = argv.includes('--check')
const force = argv.includes('--force')

function fail(msg: string): never {
  console.error(`fetch-platform-packages: ${msg}`)
  process.exit(1)
}

function selectTarget(): ReleaseTarget {
  const at = argv.indexOf('--target')
  if (at !== -1) {
    const value = argv[at + 1]
    if (!value || !isReleaseTarget(value)) fail(`--target wants one of ${RELEASE_TARGETS.join(', ')} (got ${value ?? 'nothing'})`)
    return value
  }
  const host = releaseTargetFor(process.platform, process.arch)
  if (host === null) {
    console.log(`fetch-platform-packages: no release archive is published for ${process.platform}/${process.arch} — nothing to prepare here (a build for this machine reads node_modules)`)
    process.exit(0)
  }
  return host
}

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')

function walkFiles(dir: string, base = dir): Array<{ rel: string; sha256: string }> {
  const out: Array<{ rel: string; sha256: string }> = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(p, base))
    else if (entry.isFile()) out.push({ rel: relative(base, p).split('\\').join('/'), sha256: sha256(readFileSync(p)) })
  }
  return out
}

const treeDigestOf = (files: Array<{ rel: string; sha256: string }>): string => sha256(files.map(f => `${f.rel} ${f.sha256}`).sort().join('\n'))

function readCacheManifest(cacheDir: string): CacheManifest | null {
  const path = join(cacheDir, '.vendor-manifest.json')
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CacheManifest
  } catch {
    return null
  }
}

function cacheInvalidReason(cacheDir: string, manifest: CacheManifest | null, pkg: LockedPackage): string | null {
  const record = manifest?.packages?.[pkg.name]
  if (!record) return 'not in the cache'
  if (record.version !== pkg.version) return `cache is ${record.version}, the lock pins ${pkg.version}`
  if (record.integrity !== pkg.integrity) return 'cache integrity does not match the lock'
  const dir = join(cacheDir, 'node_modules', ...pkg.name.split('/'))
  if (!existsSync(join(dir, 'package.json'))) return 'package directory missing'
  const files = walkFiles(dir)
  if (files.length !== record.fileCount) return `file count drifted: ${files.length} on disk vs ${record.fileCount} in the manifest`
  if (treeDigestOf(files) !== record.treeDigest) return 'treeDigest mismatch (extracted content drifted)'
  return null
}

async function secureTarball(pkg: LockedPackage): Promise<Buffer> {
  const url = registryTarballUrl(pkg)
  console.log(`fetch-platform-packages: downloading ${url}`)
  const res = await fetch(url)
  if (!res.ok) fail(`download failed for ${pkg.name}: HTTP ${res.status} ${res.statusText}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const got = integrityOf(buf)
  if (got !== pkg.integrity) fail(`integrity mismatch for ${pkg.name}@${pkg.version}: got ${got.slice(0, 24)}…, the lock pins ${pkg.integrity.slice(0, 24)}… — refusing (artifact identity changed)`)
  console.log(`fetch-platform-packages: verified ${pkg.integrity.slice(0, 20)}… (${buf.byteLength} bytes)`)
  return buf
}

function installPackage(cacheDir: string, pkg: LockedPackage, tarball: Buffer): PackageRecord {
  const dest = join(cacheDir, 'node_modules', ...pkg.name.split('/'))
  const tmp = `${dest}.tmp-${process.pid}`
  const archive = `${dest}.tgz-${process.pid}`
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  writeFileSync(archive, tarball)
  const tar = extractTarGz({ tarballPath: archive, destDir: tmp, stripComponents: 1 })
  rmSync(archive, { force: true })
  if (!tar.ok) {
    rmSync(tmp, { recursive: true, force: true })
    fail(`tar extraction failed for ${pkg.name}: ${tar.message}`)
  }
  if (!existsSync(join(tmp, 'package.json'))) {
    rmSync(tmp, { recursive: true, force: true })
    fail(`${pkg.name} tarball carries no package.json — refusing to install`)
  }
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(join(dest, '..'), { recursive: true })
  renameSync(tmp, dest)
  const files = walkFiles(dest)
  return { version: pkg.version, integrity: pkg.integrity, fileCount: files.length, treeDigest: treeDigestOf(files) }
}

async function main(): Promise<void> {
  const target = selectTarget()
  const { platform, arch } = buildPlatformOf(target)
  if (!existsSync(LOCK_PATH)) fail(`lock file missing: ${LOCK_PATH}`)
  const lockText = readFileSync(LOCK_PATH, 'utf8')
  const names = platformPackagesFor(platform, arch)
  const locked = names.map(name => {
    const pkg = lockedPackage(lockText, name)
    if (!pkg) fail(`bun.lock pins no version for ${name} — the lock is the one owner of platform-package versions; run bun install and commit the lock`)
    return pkg
  })
  const cacheDir = platformPackagesCacheDir(ROOT, platform, arch)
  const manifest = readCacheManifest(cacheDir)

  if (checkOnly) {
    let stale = 0
    for (const pkg of locked) {
      const inModules = resolvePlatformPackage(ROOT, platform, arch, pkg.name)?.source === 'node_modules'
      const invalid = inModules ? null : cacheInvalidReason(cacheDir, manifest, pkg)
      if (invalid === null) {
        console.log(`fetch-platform-packages --check: OK — ${pkg.name}@${pkg.version} (${inModules ? 'node_modules carries it' : `vendor cache valid for ${target}`})`)
      } else {
        stale++
        console.error(`fetch-platform-packages --check: STALE — ${pkg.name} for ${target}: ${invalid}`)
      }
    }
    if (stale > 0) {
      console.error(`  remedy: bun run scripts/vendor/fetch-platform-packages.ts --target ${target} (downloads the lock-pinned tarballs, verifies their integrity, installs them under vendor/platform-packages)`)
      process.exit(2)
    }
    process.exit(0)
  }

  const records: Record<string, PackageRecord> = { ...(manifest?.target === target ? manifest.packages : {}) }
  let prepared = 0
  for (const pkg of locked) {
    if (resolvePlatformPackage(ROOT, platform, arch, pkg.name)?.source === 'node_modules') {
      console.log(`fetch-platform-packages: ${pkg.name} is carried by node_modules (the host's install) — nothing to prepare`)
      continue
    }
    const invalid = cacheInvalidReason(cacheDir, manifest, pkg)
    if (invalid === null && !force) {
      console.log(`fetch-platform-packages: cache already valid for ${pkg.name}@${pkg.version} (${target}) — nothing to do (--force re-fetches)`)
      continue
    }
    const tarball = await secureTarball(pkg)
    records[pkg.name] = installPackage(cacheDir, pkg, tarball)
    const written: CacheManifest = { target, platform, arch, packages: records }
    writeFileSync(join(cacheDir, '.vendor-manifest.json'), JSON.stringify(written, null, 2) + '\n')
    const post = cacheInvalidReason(cacheDir, written, pkg)
    if (post !== null) fail(`post-extraction validation failed for ${pkg.name}: ${post}`)
    console.log(`fetch-platform-packages: installed ${pkg.name}@${pkg.version} → vendor/platform-packages/${platform}-${arch}/node_modules/${pkg.name} (treeDigest ${records[pkg.name]!.treeDigest.slice(0, 12)}…)`)
    prepared++
  }
  console.log(`fetch-platform-packages: DONE — ${target}: ${prepared} package(s) prepared, ${locked.length} pinned by bun.lock (bun run build.ts --target ${target})`)
}

void main()
