#!/usr/bin/env bun
// ============================================================================
//  scripts/vendor/fetch-node.ts — the explicit vendor-preparation command
//  for the pinned Node runtime pack.
//
//  Mirror of fetch-grammars.ts over the official nodejs.org distribution
//  archives, one per platform: the checked-in truth is vendor/node.lock.json
//  (one archive + sha256 per platform, every digest taken from nodejs.org's
//  own SHASUMS256.txt for that version); this reproduces the local cache:
//    vendor/node/archive/<archive>                  sha256-verified archive
//    vendor/node/extracted/<platform>/              the runtime binary
//                                                   (bin/node · node.exe)
//                                                   + LICENSE, cherry-picked
//    vendor/node/extracted/<platform>/.vendor-manifest.json
//
//  Same contract as the other packs: pinned URL only · exact sha256 verified
//  BEFORE extraction · never a substituted release · only the locked members
//  installed (npm, corepack, headers and man pages stay out — the runtime is
//  one static binary) · deterministic treeDigest · licence preserved ·
//  --check = no-network validity (exit 0 valid / 2 stale+remedy). The
//  ordinary build consumes ONLY the host platform's local bytes or produces
//  an honest degraded manifest.
//
//  Platform selection: the HOST platform by default (`bun run setup`);
//  --platform <p> (repeatable) or --all prepares other platforms' caches.
//  A host nodejs.org publishes no archive for is reported and the command
//  exits 0 — the build then says what it lacks.
//
//  Run:  bun run scripts/vendor/fetch-node.ts [--check] [--force]
//        [--platform <darwin-arm64|darwin-x64|linux-x64|linux-arm64|win-x64>]… [--all]
// ============================================================================

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { extractTarGz } from './tarExtract.ts'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { NODE_PACK_PLATFORMS, nodePackPlatform, packMembersFor, runtimeBinaryFor, type NodePackPlatform } from '../../src/services/privateChannel/vendoredRuntime.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const LOCK_PATH = join(ROOT, 'vendor', 'node.lock.json')
const CACHE_DIR = join(ROOT, 'vendor', 'node')
const ARCHIVE_DIR = join(CACHE_DIR, 'archive')
const EXTRACT_ROOT = join(CACHE_DIR, 'extracted')

interface LockPlatform {
  archive: string
  url: string
  sha256: string
}

interface Lock {
  name: string
  version: string
  license: string
  licenseFiles: string[]
  checksums: string
  platforms: Record<string, LockPlatform>
}

interface VendorManifest {
  name: string
  version: string
  platform: string
  archiveSha256: string
  binary: string
  fileCount: number
  treeDigest: string
}

const argv = process.argv.slice(2)
const checkOnly = argv.includes('--check')
const force = argv.includes('--force')
const all = argv.includes('--all')

function fail(msg: string): never {
  console.error(`fetch-node: ${msg}`)
  process.exit(1)
}

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')

function readLock(): Lock {
  if (!existsSync(LOCK_PATH)) fail(`lock file missing: ${LOCK_PATH}`)
  const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8')) as Lock
  for (const key of ['name', 'version', 'license', 'checksums'] as const) {
    if (!lock[key]) fail(`lock is missing '${key}'`)
  }
  if (!Array.isArray(lock.licenseFiles) || lock.licenseFiles.length === 0) fail('lock names no licence files')
  if (typeof lock.platforms !== 'object' || lock.platforms === null) fail('lock names no platforms')
  for (const platform of NODE_PACK_PLATFORMS) {
    const p = lock.platforms[platform]
    if (!p) fail(`lock has no entry for ${platform}`)
    if (!p.archive || !p.url) fail(`lock entry ${platform} lacks archive/url`)
    if (!/^[0-9a-f]{64}$/.test(p.sha256)) fail(`lock entry ${platform} sha256 is not a 64-hex digest`)
    if (!p.url.startsWith('https://nodejs.org/dist/')) fail(`lock entry ${platform} url is not a nodejs.org distribution url`)
  }
  return lock
}

/** The platforms this invocation prepares: --all, every --platform, else the host. */
function selectPlatforms(): NodePackPlatform[] {
  if (all) return [...NODE_PACK_PLATFORMS]
  const named: NodePackPlatform[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--platform') continue
    const value = argv[i + 1]
    if (!value || !(NODE_PACK_PLATFORMS as readonly string[]).includes(value)) {
      fail(`--platform wants one of ${NODE_PACK_PLATFORMS.join(', ')} (got ${value ?? 'nothing'})`)
    }
    named.push(value as NodePackPlatform)
    i++
  }
  if (named.length > 0) return [...new Set(named)]
  const host = nodePackPlatform(process.platform, process.arch)
  if (host === null) {
    console.log(
      `fetch-node: nodejs.org publishes no runtime archive Mercury vendors for ${process.platform}/${process.arch} — nothing to prepare here; the build ships without a vendored runtime and says so (the launchers fall back to MERCURY_NODE or a PATH node)`,
    )
    process.exit(0)
  }
  return [host]
}

function walkFiles(dir: string, base = dir): Array<{ rel: string; sha256: string }> {
  const out: Array<{ rel: string; sha256: string }> = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(p, base))
    else if (entry.isFile()) {
      const rel = relative(base, p).split('\\').join('/')
      if (rel === '.vendor-manifest.json') continue
      out.push({ rel, sha256: sha256(readFileSync(p)) })
    }
  }
  return out
}

function computeTreeDigest(files: Array<{ rel: string; sha256: string }>): string {
  return sha256(files.map(f => `${f.rel} ${f.sha256}`).sort().join('\n'))
}

function cacheInvalidReason(lock: Lock, platform: NodePackPlatform): string | null {
  const extractDir = join(EXTRACT_ROOT, platform)
  const manifestPath = join(extractDir, '.vendor-manifest.json')
  if (!existsSync(manifestPath)) return `no extracted cache (vendor/node/extracted/${platform} absent)`
  let manifest: VendorManifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as VendorManifest
  } catch (e) {
    return `vendor manifest unparseable: ${String(e).slice(0, 80)}`
  }
  const pinned = lock.platforms[platform]!
  if (manifest.version !== lock.version) return `cache is ${manifest.version}, lock wants ${lock.version}`
  if (manifest.platform !== platform) return `cache is ${manifest.platform}, lock entry is ${platform}`
  if (manifest.archiveSha256 !== pinned.sha256) return 'cache archiveSha256 does not match the lock'
  const binary = runtimeBinaryFor(platform)
  if (manifest.binary !== binary) return `cache binary is ${manifest.binary}, the pack law wants ${binary}`
  if (!existsSync(join(extractDir, ...binary.split('/')))) return `runtime binary missing: ${binary}`
  for (const lf of lock.licenseFiles) {
    if (!existsSync(join(extractDir, lf))) return `licence file missing: ${lf}`
  }
  const files = walkFiles(extractDir)
  if (files.length !== manifest.fileCount) {
    return `file count drifted: ${files.length} on disk vs ${manifest.fileCount} in the manifest`
  }
  if (computeTreeDigest(files) !== manifest.treeDigest) return 'treeDigest mismatch (extracted content drifted)'
  return null
}

/** The zip extractor candidates, in order — the debugpy wheel's ladder: the
 *  historic POSIX pair first, then the names a stock Windows host has
 *  (`tar.exe` is bsdtar and reads zip), then plain `tar` (bsdtar on macOS;
 *  GNU tar refuses a zip and the ladder moves on). Determinism is content,
 *  proven by treeDigest; the explicit vendor-preparation command may depend
 *  on host tools — the BUILD never does. */
const ZIP_EXTRACTORS: ReadonlyArray<{ name: string; argv: (zip: string, dest: string) => string[] }> = [
  { name: 'unzip', argv: (zip, dest) => ['-q', '-o', zip, '-d', dest] },
  { name: 'python3', argv: (zip, dest) => ['-m', 'zipfile', '-e', zip, dest] },
  { name: 'tar.exe', argv: (zip, dest) => ['-x', '-f', zip, '-C', dest] },
  { name: 'tar', argv: (zip, dest) => ['-x', '-f', zip, '-C', dest] },
  { name: 'python', argv: (zip, dest) => ['-m', 'zipfile', '-e', zip, dest] },
  { name: 'py', argv: (zip, dest) => ['-3', '-m', 'zipfile', '-e', zip, dest] },
]

/** Unpack the archive's single top-level directory into `dest` (the
 *  nodejs.org layout: node-v<ver>-<platform>/…). */
function unpackArchive(archivePath: string, dest: string): void {
  if (archivePath.endsWith('.tar.gz')) {
    // The shared invocation is dialect-proof (GNU tar host:path parsing);
    // tar preserves the binary's executable bit.
    const tar = extractTarGz({ tarballPath: archivePath, destDir: dest, stripComponents: 1 })
    if (!tar.ok) fail(`tar extraction failed: ${tar.message}`)
    return
  }
  const raw = `${dest}.zip-${process.pid}`
  rmSync(raw, { recursive: true, force: true })
  mkdirSync(raw, { recursive: true })
  const attempts: string[] = []
  let extracted = false
  for (const candidate of ZIP_EXTRACTORS) {
    // env passed explicitly: bun's spawnSync otherwise resolves the
    // executable against the PROCESS-START PATH.
    const res = spawnSync(candidate.name, candidate.argv(archivePath, raw), { encoding: 'utf8', env: process.env })
    if (res.status === 0) {
      extracted = true
      break
    }
    attempts.push(`${candidate.name}: ${res.error ? String(res.error) : `exit ${String(res.status)}`}`)
    // A partial extraction from a failed tool must not leak into the next
    // attempt's tree.
    rmSync(raw, { recursive: true, force: true })
    mkdirSync(raw, { recursive: true })
  }
  if (!extracted) {
    rmSync(raw, { recursive: true, force: true })
    fail(`cannot extract the zip — none of the candidate extractors worked (tried, in order: ${ZIP_EXTRACTORS.map(c => `'${c.name}'`).join(', ')}). ${attempts.join('; ')}`)
  }
  const tops = readdirSync(raw, { withFileTypes: true }).filter(e => e.isDirectory())
  if (tops.length !== 1) {
    rmSync(raw, { recursive: true, force: true })
    fail(`the zip does not unpack to exactly one top-level directory (found ${tops.map(t => t.name).join(', ') || 'nothing'}) — refusing to install`)
  }
  rmSync(dest, { recursive: true, force: true })
  renameSync(join(raw, tops[0]!.name), dest)
  rmSync(raw, { recursive: true, force: true })
}

function installSelected(lock: Lock, platform: NodePackPlatform, archivePath: string): void {
  const extractDir = join(EXTRACT_ROOT, platform)
  const tmpUnpack = `${extractDir}.unpack-${process.pid}`
  const tmp = `${extractDir}.tmp-${process.pid}`
  rmSync(tmpUnpack, { recursive: true, force: true })
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmpUnpack, { recursive: true })
  mkdirSync(tmp, { recursive: true })
  unpackArchive(archivePath, tmpUnpack)
  const binary = runtimeBinaryFor(platform)
  for (const member of packMembersFor(platform)) {
    const from = join(tmpUnpack, ...member.split('/'))
    if (!existsSync(from)) {
      rmSync(tmpUnpack, { recursive: true, force: true })
      rmSync(tmp, { recursive: true, force: true })
      fail(`archive has no ${member} — refusing to install`)
    }
    const to = join(tmp, ...member.split('/'))
    mkdirSync(join(to, '..'), { recursive: true })
    copyFileSync(from, to)
  }
  for (const lf of lock.licenseFiles) {
    if (!existsSync(join(tmp, lf))) {
      rmSync(tmpUnpack, { recursive: true, force: true })
      rmSync(tmp, { recursive: true, force: true })
      fail(`extracted tree is missing the licence file ${lf} — refusing to install`)
    }
  }
  rmSync(tmpUnpack, { recursive: true, force: true })
  if (process.platform !== 'win32' && !binary.endsWith('.exe')) chmodSync(join(tmp, ...binary.split('/')), 0o755)
  const files = walkFiles(tmp)
  const manifest: VendorManifest = {
    name: lock.name,
    version: lock.version,
    platform,
    archiveSha256: lock.platforms[platform]!.sha256,
    binary,
    fileCount: files.length,
    treeDigest: computeTreeDigest(files),
  }
  writeFileSync(join(tmp, '.vendor-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  rmSync(extractDir, { recursive: true, force: true })
  mkdirSync(EXTRACT_ROOT, { recursive: true })
  renameSync(tmp, extractDir)
  console.log(`fetch-node: installed ${binary} + ${lock.licenseFiles.join(', ')} → vendor/node/extracted/${platform} (treeDigest ${manifest.treeDigest.slice(0, 12)}…)`)
}

async function secureArchive(lock: Lock, platform: NodePackPlatform): Promise<string> {
  const pinned = lock.platforms[platform]!
  mkdirSync(ARCHIVE_DIR, { recursive: true })
  const archivePath = join(ARCHIVE_DIR, pinned.archive)
  if (existsSync(archivePath) && !force) {
    const local = readFileSync(archivePath)
    if (sha256(local) === pinned.sha256) {
      console.log(`fetch-node: reusing verified local archive (${pinned.archive})`)
      return archivePath
    }
    console.log(`fetch-node: local archive ${pinned.archive} does not match the lock — re-downloading`)
  }
  console.log(`fetch-node: downloading ${pinned.url}`)
  const res = await fetch(pinned.url)
  if (!res.ok) fail(`download failed for ${platform}: HTTP ${res.status} ${res.statusText}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const digest = sha256(buf)
  if (digest !== pinned.sha256) {
    fail(`sha256 mismatch for ${pinned.archive}: got ${digest.slice(0, 24)}…, lock pins ${pinned.sha256.slice(0, 24)}… — refusing (artifact identity changed)`)
  }
  writeFileSync(archivePath, buf)
  console.log(`fetch-node: verified sha256 ${digest.slice(0, 12)}… (${buf.byteLength} bytes)`)
  return archivePath
}

async function main(): Promise<void> {
  const lock = readLock()
  const platforms = selectPlatforms()

  if (checkOnly) {
    let stale = 0
    for (const platform of platforms) {
      const invalid = cacheInvalidReason(lock, platform)
      if (invalid === null) {
        console.log(`fetch-node --check: OK — node ${lock.version} ${platform} cache valid against the lock`)
      } else {
        stale++
        console.error(`fetch-node --check: STALE — ${platform}: ${invalid}`)
      }
    }
    if (stale > 0) {
      console.error('  remedy: bun run scripts/vendor/fetch-node.ts (downloads the pinned archive, verifies sha256, installs the runtime binary + licence)')
      process.exit(2)
    }
    process.exit(0)
  }

  for (const platform of platforms) {
    const invalid = cacheInvalidReason(lock, platform)
    if (invalid === null && !force) {
      console.log(`fetch-node: cache already valid for node ${lock.version} ${platform} — nothing to do (--force re-fetches)`)
      continue
    }
    const archivePath = await secureArchive(lock, platform)
    installSelected(lock, platform, archivePath)
    const post = cacheInvalidReason(lock, platform)
    if (post !== null) fail(`post-extraction validation failed for ${platform}: ${post}`)
    const size = statSync(join(EXTRACT_ROOT, platform, ...runtimeBinaryFor(platform).split('/'))).size
    console.log(`fetch-node: DONE — node ${lock.version} ${platform} ready for the build (${size} bytes; bun run build.ts)`)
  }
}

void main()
