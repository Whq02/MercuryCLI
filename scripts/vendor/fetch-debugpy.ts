#!/usr/bin/env bun
// ============================================================================
//  scripts/vendor/fetch-debugpy.ts — the explicit vendor-preparation command
//  for the pinned debugpy distribution.
//
//  The checked-in truth is vendor/debugpy.lock.json; this command reproduces
//  the local cache from it:
//    vendor/debugpy/wheel/<lock.wheel>        the hash-verified wheel bytes
//    vendor/debugpy/extracted/                deterministic extracted tree
//    vendor/debugpy/extracted/.vendor-manifest.json
//                                             {name, version, wheelSha256,
//                                              fileCount, treeDigest}
//
//  Contract:
//    · downloads ONLY the pinned URL; the exact SHA-256 + byte size are
//      verified BEFORE extraction — any mismatch (a redirect or metadata
//      swap that changes artifact identity) hard-fails and installs nothing;
//    · never substitutes a different debugpy release: everything derives
//      from the lock;
//    · extraction is deterministic: the manifest's treeDigest is the sha256
//      of the sorted `<relpath> <file-sha256>` lines, so two extractions of
//      the same wheel are byte-provably identical;
//    · licence + notice files are asserted present post-extraction;
//    · --check is the no-network mode: exit 0 when the cache is valid and
//      current against the lock, exit 2 (with the remedy) when absent/stale.
//
//  The ordinary artifact build (build.ts) consumes ONLY these known local
//  bytes — it never touches the network. No cache ⇒ an honest degraded
//  manifest (`degraded: ['python-debugger']`), never a silent fetch.
//
//  Run:  bun run scripts/vendor/fetch-debugpy.ts [--check] [--force]
// ============================================================================

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const LOCK_PATH = join(ROOT, 'vendor', 'debugpy.lock.json')
const CACHE_DIR = join(ROOT, 'vendor', 'debugpy')
const WHEEL_DIR = join(CACHE_DIR, 'wheel')
const EXTRACT_DIR = join(CACHE_DIR, 'extracted')
const VENDOR_MANIFEST = join(EXTRACT_DIR, '.vendor-manifest.json')

interface Lock {
  name: string
  version: string
  wheel: string
  url: string
  sha256: string
  sizeBytes: number
  license: string
  licenseFiles: string[]
  adapterEntry: string
}

interface VendorManifest {
  name: string
  version: string
  wheelSha256: string
  fileCount: number
  treeDigest: string
}

const checkOnly = process.argv.includes('--check')
const force = process.argv.includes('--force')

function fail(msg: string): never {
  console.error(`fetch-debugpy: ${msg}`)
  process.exit(1)
}

function sha256Of(buf: Buffer | Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex')
}

function readLock(): Lock {
  if (!existsSync(LOCK_PATH)) fail(`lock file missing: ${LOCK_PATH}`)
  const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8')) as Lock
  for (const key of ['name', 'version', 'wheel', 'url', 'sha256', 'sizeBytes', 'adapterEntry'] as const) {
    if (!lock[key]) fail(`lock is missing '${key}'`)
  }
  if (!/^[0-9a-f]{64}$/.test(lock.sha256)) fail(`lock sha256 is not a 64-hex digest`)
  return lock
}

/** Walk the extracted tree (sorted, deterministic) → per-file digests. */
function walkFiles(dir: string, base = dir): Array<{ rel: string; sha256: string }> {
  const out: Array<{ rel: string; sha256: string }> = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(p, base))
    else if (entry.isFile()) {
      const rel = relative(base, p)
      if (rel === '.vendor-manifest.json') continue
      out.push({ rel, sha256: sha256Of(readFileSync(p)) })
    }
  }
  return out
}

function computeTreeDigest(files: Array<{ rel: string; sha256: string }>): string {
  const lines = files
    .map(f => `${f.rel} ${f.sha256}`)
    .sort()
    .join('\n')
  return sha256Of(Buffer.from(lines, 'utf8'))
}

/** Validate the extracted cache against the lock. Returns a reason or null. */
function cacheInvalidReason(lock: Lock): string | null {
  if (!existsSync(VENDOR_MANIFEST)) return 'no extracted cache (vendor/debugpy/extracted absent)'
  let manifest: VendorManifest
  try {
    manifest = JSON.parse(readFileSync(VENDOR_MANIFEST, 'utf8')) as VendorManifest
  } catch (e) {
    return `vendor manifest unparseable: ${String(e).slice(0, 80)}`
  }
  if (manifest.version !== lock.version) return `cache is ${manifest.version}, lock wants ${lock.version}`
  if (manifest.wheelSha256 !== lock.sha256) return 'cache wheelSha256 does not match the lock'
  const entry = join(EXTRACT_DIR, lock.adapterEntry, '__main__.py')
  if (!existsSync(entry)) return `adapter entry missing: ${lock.adapterEntry}/__main__.py`
  for (const lf of lock.licenseFiles) {
    if (!existsSync(join(EXTRACT_DIR, lf))) return `licence file missing: ${lf}`
  }
  const files = walkFiles(EXTRACT_DIR)
  if (files.length !== manifest.fileCount) {
    return `file count drifted: ${files.length} on disk vs ${manifest.fileCount} in the manifest`
  }
  const digest = computeTreeDigest(files)
  if (digest !== manifest.treeDigest) return 'treeDigest mismatch (extracted content drifted)'
  return null
}

/** The zip extractor candidates, in order. `unzip`/`python3` first (the
 *  historic pair, every POSIX host); then the names a STOCK Windows host
 *  actually has — `tar.exe` (bsdtar, ships on Win10 1803+, reads zip),
 *  `python`, `py -3`. All five produce the same BYTES (determinism is
 *  content, proven by treeDigest); the explicit vendor-preparation command
 *  may depend on host tools — the BUILD never does. */
const EXTRACT_CANDIDATES: ReadonlyArray<{ name: string; argv: (wheel: string, dest: string) => string[] }> = [
  { name: 'unzip', argv: (wheel, dest) => ['-q', '-o', wheel, '-d', dest] },
  { name: 'python3', argv: (wheel, dest) => ['-m', 'zipfile', '-e', wheel, dest] },
  { name: 'tar.exe', argv: (wheel, dest) => ['-x', '-f', wheel, '-C', dest] },
  { name: 'python', argv: (wheel, dest) => ['-m', 'zipfile', '-e', wheel, dest] },
  { name: 'py', argv: (wheel, dest) => ['-3', '-m', 'zipfile', '-e', wheel, dest] },
]

function extractWheel(lock: Lock, wheelPath: string): void {
  const tmp = `${EXTRACT_DIR}.tmp-${process.pid}`
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  const attempts: string[] = []
  let extracted = false
  for (const candidate of EXTRACT_CANDIDATES) {
    const res = spawnSync(candidate.name, candidate.argv(wheelPath, tmp), { encoding: 'utf8' })
    if (res.status === 0) {
      extracted = true
      break
    }
    attempts.push(`${candidate.name}: ${res.error ? String(res.error) : `exit ${res.status}`}`)
    // A partial extraction from a failed tool must not leak into the next
    // attempt's tree (or the digest law would certify a merged tree).
    rmSync(tmp, { recursive: true, force: true })
    mkdirSync(tmp, { recursive: true })
  }
  if (!extracted) {
    rmSync(tmp, { recursive: true, force: true })
    fail(
      `cannot extract the wheel — none of the candidate extractors worked ` +
        `(tried, in order: ${EXTRACT_CANDIDATES.map(c => `'${c.name}'`).join(', ')}). ` +
        attempts.join('; '),
    )
  }
  const entry = join(tmp, lock.adapterEntry, '__main__.py')
  if (!existsSync(entry)) {
    rmSync(tmp, { recursive: true, force: true })
    fail(`extracted tree has no ${lock.adapterEntry}/__main__.py — refusing to install`)
  }
  for (const lf of lock.licenseFiles) {
    if (!existsSync(join(tmp, lf))) {
      rmSync(tmp, { recursive: true, force: true })
      fail(`extracted tree is missing the licence/notice file ${lf} — refusing to install`)
    }
  }
  const files = walkFiles(tmp)
  const manifest: VendorManifest = {
    name: lock.name,
    version: lock.version,
    wheelSha256: lock.sha256,
    fileCount: files.length,
    treeDigest: computeTreeDigest(files),
  }
  writeFileSync(join(tmp, '.vendor-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  rmSync(EXTRACT_DIR, { recursive: true, force: true })
  renameSync(tmp, EXTRACT_DIR)
  console.log(
    `fetch-debugpy: extracted ${files.length} files → vendor/debugpy/extracted (treeDigest ${manifest.treeDigest.slice(0, 12)}…)`,
  )
}

async function main(): Promise<void> {
  const lock = readLock()
  const invalid = cacheInvalidReason(lock)

  if (checkOnly) {
    if (invalid === null) {
      console.log(`fetch-debugpy --check: OK — debugpy ${lock.version} cache valid against the lock`)
      process.exit(0)
    }
    console.error(`fetch-debugpy --check: STALE — ${invalid}`)
    console.error(`  remedy: bun run scripts/vendor/fetch-debugpy.ts (downloads the pinned wheel, verifies sha256, extracts)`)
    process.exit(2)
  }

  if (invalid === null && !force) {
    console.log(`fetch-debugpy: cache already valid for debugpy ${lock.version} — nothing to do (--force re-fetches)`)
    process.exit(0)
  }

  // The wheel: reuse verified local bytes when present, else download the
  // pinned URL. Identity = exact byte size + exact SHA-256, always re-verified.
  mkdirSync(WHEEL_DIR, { recursive: true })
  const wheelPath = join(WHEEL_DIR, lock.wheel)
  let wheelBytes: Buffer | null = null
  if (existsSync(wheelPath) && !force) {
    const local = readFileSync(wheelPath)
    if (local.byteLength === lock.sizeBytes && sha256Of(local) === lock.sha256) {
      wheelBytes = local
      console.log(`fetch-debugpy: reusing verified local wheel (${lock.wheel})`)
    } else {
      console.log('fetch-debugpy: local wheel does not match the lock — re-downloading')
    }
  }
  if (!wheelBytes) {
    console.log(`fetch-debugpy: downloading ${lock.url}`)
    const res = await fetch(lock.url)
    if (!res.ok) fail(`download failed: HTTP ${res.status} ${res.statusText}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength !== lock.sizeBytes) {
      fail(`size mismatch: got ${buf.byteLength} bytes, lock pins ${lock.sizeBytes} — refusing (artifact identity changed)`)
    }
    const digest = sha256Of(buf)
    if (digest !== lock.sha256) {
      fail(`sha256 mismatch: got ${digest}, lock pins ${lock.sha256} — refusing (artifact identity changed)`)
    }
    writeFileSync(wheelPath, buf)
    wheelBytes = buf
    console.log(`fetch-debugpy: verified sha256 ${digest.slice(0, 12)}… (${buf.byteLength} bytes)`)
  }

  extractWheel(lock, wheelPath)

  const post = cacheInvalidReason(lock)
  if (post !== null) fail(`post-extraction validation failed: ${post}`)
  console.log(`fetch-debugpy: DONE — debugpy ${lock.version} ready for the build (bun run build.ts)`)
}

void main()
