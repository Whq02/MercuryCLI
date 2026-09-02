#!/usr/bin/env bun
// ============================================================================
//  scripts/vendor/fetch-js-debug.ts — the explicit vendor-preparation command
//  for the pinned js-debug DAP server (Node/TypeScript debugging).
//
//  Mirror of fetch-pyright.ts over a GitHub release tarball: the checked-in
//  truth is vendor/js-debug.lock.json; this reproduces the local cache:
//    vendor/js-debug/tarball/<lock.tarball>   sha512-verified release asset
//    vendor/js-debug/extracted/               the js-debug/ contents (tar
//                                             prefix stripped), deterministic
//    vendor/js-debug/extracted/.vendor-manifest.json
//
//  Same contract as debugpy/pyright: pinned URL only · exact sha512 verified
//  BEFORE extraction · never a substituted release · deterministic
//  treeDigest · licence preserved · --check = no-network validity (exit 0
//  valid / 2 stale+remedy). The ordinary build consumes ONLY these local
//  bytes or produces an honest degraded manifest.
//
//  Run:  bun run scripts/vendor/fetch-js-debug.ts [--check] [--force]
// ============================================================================

import { createHash } from 'node:crypto'
import { extractTarGz } from './tarExtract.ts'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const LOCK_PATH = join(ROOT, 'vendor', 'js-debug.lock.json')
const CACHE_DIR = join(ROOT, 'vendor', 'js-debug')
const TARBALL_DIR = join(CACHE_DIR, 'tarball')
const EXTRACT_DIR = join(CACHE_DIR, 'extracted')
const VENDOR_MANIFEST = join(EXTRACT_DIR, '.vendor-manifest.json')

interface Lock {
  name: string
  version: string
  tarball: string
  url: string
  sha512: string
  license: string
  licenseFiles: string[]
  serverEntry: string
}

interface VendorManifest {
  name: string
  version: string
  tarballSha512: string
  fileCount: number
  treeDigest: string
}

const checkOnly = process.argv.includes('--check')
const force = process.argv.includes('--force')

function fail(msg: string): never {
  console.error(`fetch-js-debug: ${msg}`)
  process.exit(1)
}

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')
const sha512 = (b: Buffer): string => createHash('sha512').update(b).digest('hex')

function readLock(): Lock {
  if (!existsSync(LOCK_PATH)) fail(`lock file missing: ${LOCK_PATH}`)
  const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8')) as Lock
  for (const key of ['name', 'version', 'tarball', 'url', 'sha512', 'serverEntry'] as const) {
    if (!lock[key]) fail(`lock is missing '${key}'`)
  }
  if (!/^[0-9a-f]{128}$/.test(lock.sha512)) fail('lock sha512 is not a 128-hex digest')
  return lock
}

function walkFiles(dir: string, base = dir): Array<{ rel: string; sha256: string }> {
  const out: Array<{ rel: string; sha256: string }> = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(p, base))
    else if (entry.isFile()) {
      const rel = relative(base, p)
      if (rel === '.vendor-manifest.json') continue
      out.push({ rel, sha256: sha256(readFileSync(p)) })
    }
  }
  return out
}

function computeTreeDigest(files: Array<{ rel: string; sha256: string }>): string {
  return sha256(files.map(f => `${f.rel} ${f.sha256}`).sort().join('\n'))
}

function cacheInvalidReason(lock: Lock): string | null {
  if (!existsSync(VENDOR_MANIFEST)) return 'no extracted cache (vendor/js-debug/extracted absent)'
  let manifest: VendorManifest
  try {
    manifest = JSON.parse(readFileSync(VENDOR_MANIFEST, 'utf8')) as VendorManifest
  } catch (e) {
    return `vendor manifest unparseable: ${String(e).slice(0, 80)}`
  }
  if (manifest.version !== lock.version) return `cache is ${manifest.version}, lock wants ${lock.version}`
  if (manifest.tarballSha512 !== lock.sha512) return 'cache tarballSha512 does not match the lock'
  if (!existsSync(join(EXTRACT_DIR, lock.serverEntry))) return `server entry missing: ${lock.serverEntry}`
  for (const lf of lock.licenseFiles) {
    if (!existsSync(join(EXTRACT_DIR, lf))) return `licence file missing: ${lf}`
  }
  const files = walkFiles(EXTRACT_DIR)
  if (files.length !== manifest.fileCount) {
    return `file count drifted: ${files.length} on disk vs ${manifest.fileCount} in the manifest`
  }
  if (computeTreeDigest(files) !== manifest.treeDigest) return 'treeDigest mismatch (extracted content drifted)'
  return null
}

function extractTarball(lock: Lock, tarballPath: string): void {
  const tmp = `${EXTRACT_DIR}.tmp-${process.pid}`
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  // The release tarball roots everything under js-debug/ — strip it on
  // extraction (the npm package/ idiom, same as pyright). The shared
  // invocation is dialect-proof (GNU tar host:path parsing).
  const tar = extractTarGz({ tarballPath, destDir: tmp, stripComponents: 1 })
  if (!tar.ok) {
    rmSync(tmp, { recursive: true, force: true })
    fail(`tar extraction failed: ${tar.message}`)
  }
  if (!existsSync(join(tmp, lock.serverEntry))) {
    rmSync(tmp, { recursive: true, force: true })
    fail(`extracted tree has no ${lock.serverEntry} — refusing to install`)
  }
  for (const lf of lock.licenseFiles) {
    if (!existsSync(join(tmp, lf))) {
      rmSync(tmp, { recursive: true, force: true })
      fail(`extracted tree is missing the licence file ${lf} — refusing to install`)
    }
  }
  const files = walkFiles(tmp)
  const manifest: VendorManifest = {
    name: lock.name,
    version: lock.version,
    tarballSha512: lock.sha512,
    fileCount: files.length,
    treeDigest: computeTreeDigest(files),
  }
  writeFileSync(join(tmp, '.vendor-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  rmSync(EXTRACT_DIR, { recursive: true, force: true })
  renameSync(tmp, EXTRACT_DIR)
  console.log(
    `fetch-js-debug: extracted ${files.length} files → vendor/js-debug/extracted (treeDigest ${manifest.treeDigest.slice(0, 12)}…)`,
  )
}

async function main(): Promise<void> {
  const lock = readLock()
  const invalid = cacheInvalidReason(lock)

  if (checkOnly) {
    if (invalid === null) {
      console.log(`fetch-js-debug --check: OK — js-debug ${lock.version} cache valid against the lock`)
      process.exit(0)
    }
    console.error(`fetch-js-debug --check: STALE — ${invalid}`)
    console.error('  remedy: bun run scripts/vendor/fetch-js-debug.ts (downloads the pinned release asset, verifies sha512, extracts)')
    process.exit(2)
  }

  if (invalid === null && !force) {
    console.log(`fetch-js-debug: cache already valid for js-debug ${lock.version} — nothing to do (--force re-fetches)`)
    process.exit(0)
  }

  mkdirSync(TARBALL_DIR, { recursive: true })
  const tarballPath = join(TARBALL_DIR, lock.tarball)
  let bytes: Buffer | null = null
  if (existsSync(tarballPath) && !force) {
    const local = readFileSync(tarballPath)
    if (sha512(local) === lock.sha512) {
      bytes = local
      console.log(`fetch-js-debug: reusing verified local tarball (${lock.tarball})`)
    } else {
      console.log('fetch-js-debug: local tarball does not match the lock — re-downloading')
    }
  }
  if (!bytes) {
    console.log(`fetch-js-debug: downloading ${lock.url}`)
    const res = await fetch(lock.url)
    if (!res.ok) fail(`download failed: HTTP ${res.status} ${res.statusText}`)
    const buf = Buffer.from(await res.arrayBuffer())
    const digest = sha512(buf)
    if (digest !== lock.sha512) {
      fail(`sha512 mismatch: got ${digest.slice(0, 24)}…, lock pins ${lock.sha512.slice(0, 24)}… — refusing (artifact identity changed)`)
    }
    writeFileSync(tarballPath, buf)
    bytes = buf
    console.log(`fetch-js-debug: verified sha512 ${digest.slice(0, 12)}… (${buf.byteLength} bytes)`)
  }

  extractTarball(lock, tarballPath)

  const post = cacheInvalidReason(lock)
  if (post !== null) fail(`post-extraction validation failed: ${post}`)
  console.log(`fetch-js-debug: DONE — js-debug ${lock.version} ready for the build (bun run build.ts)`)
}

void main()
