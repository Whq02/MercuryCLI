#!/usr/bin/env bun
// ============================================================================
//  scripts/vendor/fetch-grammars.ts — the explicit vendor-preparation command
//  for the pinned tree-sitter grammar-pack EXTENSION.
//
//  Mirror of fetch-pyright.ts over the tree-sitter-wasms npm tarball, with
//  one difference: only the LOCKED grammar wasms are installed (cherry-pick,
//  never the whole 51.8 MB pack), each verified against its own pinned
//  sha256. The checked-in truth is vendor/grammars.lock.json; this
//  reproduces the local cache from it:
//    vendor/grammars/tarball/<lock.tarball>   sha512-verified npm tarball
//    vendor/grammars/extracted/               the selected out/*.wasm files
//                                             + the pack LICENSE
//    vendor/grammars/extracted/.vendor-manifest.json
//
//  Same contract as debugpy/pyright: pinned URL only · exact sha512 verified
//  BEFORE extraction · per-file sha256 verified BEFORE install · never a
//  substituted release · deterministic treeDigest · --check = no-network
//  validity (exit 0 valid / 2 stale+remedy). The ordinary build consumes
//  ONLY these local bytes or produces an honest degraded manifest.
//
//  Per-grammar source override: a lock entry carrying `sourceUrl` takes its
//  wasm from THAT pinned https artifact (sha256-verified, cached beside the
//  tarball) instead of the pack tarball — the road for a grammar whose pack
//  build is defective while upstream publishes a healthy one (swift: the
//  pack's 0.4-era build fatally OOMs V8's optimizing wasm compiler; the
//  upstream 0.7.3 release wasm passes the audition). `sourceProvenance`
//  names the why; the same per-file sha256 law verifies the bytes.
//
//  Run:  bun run scripts/vendor/fetch-grammars.ts [--check] [--force]
// ============================================================================

import { createHash } from 'node:crypto'
import { extractTarGz } from './tarExtract.ts'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const LOCK_PATH = join(ROOT, 'vendor', 'grammars.lock.json')
const CACHE_DIR = join(ROOT, 'vendor', 'grammars')
const TARBALL_DIR = join(CACHE_DIR, 'tarball')
const EXTRACT_DIR = join(CACHE_DIR, 'extracted')
const VENDOR_MANIFEST = join(EXTRACT_DIR, '.vendor-manifest.json')

interface LockGrammar {
  wasm: string
  sha256: string
  bytes: number
  /** Pinned https artifact that supplies this wasm INSTEAD of the pack
   *  tarball (per-grammar override; sha256 above still verifies the bytes). */
  sourceUrl?: string
  /** Why this grammar rides an override — provenance for the human record. */
  sourceProvenance?: string
  upstream: { package: string; builtFromRange: string; license: string; repository: string }
}

interface Lock {
  name: string
  version: string
  tarball: string
  url: string
  sha512: string
  licenseFiles: string[]
  grammars: LockGrammar[]
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
  console.error(`fetch-grammars: ${msg}`)
  process.exit(1)
}

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')
const sha512 = (b: Buffer): string => createHash('sha512').update(b).digest('hex')

function readLock(): Lock {
  if (!existsSync(LOCK_PATH)) fail(`lock file missing: ${LOCK_PATH}`)
  const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8')) as Lock
  for (const key of ['name', 'version', 'tarball', 'url', 'sha512'] as const) {
    if (!lock[key]) fail(`lock is missing '${key}'`)
  }
  if (!/^[0-9a-f]{128}$/.test(lock.sha512)) fail('lock sha512 is not a 128-hex digest')
  if (!Array.isArray(lock.grammars) || lock.grammars.length === 0) fail('lock names no grammars')
  for (const g of lock.grammars) {
    if (!g.wasm || !/^[0-9a-f]{64}$/.test(g.sha256)) fail(`grammar entry invalid: ${JSON.stringify(g).slice(0, 80)}`)
    if (!g.upstream?.package || !g.upstream?.license) fail(`grammar ${g.wasm} lacks upstream licence metadata`)
    if (g.sourceUrl !== undefined) {
      if (!/^https:\/\//.test(g.sourceUrl)) fail(`grammar ${g.wasm} sourceUrl is not https`)
      if (!g.sourceProvenance) fail(`grammar ${g.wasm} carries a sourceUrl but no sourceProvenance`)
    }
  }
  return lock
}

/**
 * Secure every per-grammar override artifact: reuse the cached copy beside
 * the tarball when its sha256 matches the lock, otherwise download from the
 * pinned URL and verify BEFORE caching — the same never-a-substituted-release
 * law the tarball rides. Returns wasm name → verified bytes.
 */
async function ensureOverrideArtifacts(lock: Lock): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>()
  for (const g of lock.grammars) {
    if (!g.sourceUrl) continue
    const cachePath = join(TARBALL_DIR, g.wasm)
    if (existsSync(cachePath) && !force) {
      const local = readFileSync(cachePath)
      if (sha256(local) === g.sha256) {
        out.set(g.wasm, local)
        console.log(`fetch-grammars: reusing verified override artifact (${g.wasm})`)
        continue
      }
      console.log(`fetch-grammars: cached override ${g.wasm} does not match the lock — re-downloading`)
    }
    console.log(`fetch-grammars: downloading ${g.sourceUrl}`)
    const res = await fetch(g.sourceUrl)
    if (!res.ok) fail(`override download failed for ${g.wasm}: HTTP ${res.status} ${res.statusText}`)
    const buf = Buffer.from(await res.arrayBuffer())
    const digest = sha256(buf)
    if (digest !== g.sha256) {
      fail(`override sha256 mismatch for ${g.wasm}: got ${digest.slice(0, 16)}…, lock pins ${g.sha256.slice(0, 16)}… — refusing (artifact identity changed)`)
    }
    writeFileSync(cachePath, buf)
    out.set(g.wasm, buf)
    console.log(`fetch-grammars: verified override sha256 ${digest.slice(0, 12)}… (${buf.byteLength} bytes)`)
  }
  return out
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
  if (!existsSync(VENDOR_MANIFEST)) return 'no extracted cache (vendor/grammars/extracted absent)'
  let manifest: VendorManifest
  try {
    manifest = JSON.parse(readFileSync(VENDOR_MANIFEST, 'utf8')) as VendorManifest
  } catch (e) {
    return `vendor manifest unparseable: ${String(e).slice(0, 80)}`
  }
  if (manifest.version !== lock.version) return `cache is ${manifest.version}, lock wants ${lock.version}`
  if (manifest.tarballSha512 !== lock.sha512) return 'cache tarballSha512 does not match the lock'
  for (const g of lock.grammars) {
    const p = join(EXTRACT_DIR, g.wasm)
    if (!existsSync(p)) return `grammar missing: ${g.wasm}`
    if (sha256(readFileSync(p)) !== g.sha256) return `grammar sha256 drifted: ${g.wasm}`
  }
  for (const lf of lock.licenseFiles ?? []) {
    if (!existsSync(join(EXTRACT_DIR, lf))) return `licence file missing: ${lf}`
  }
  const files = walkFiles(EXTRACT_DIR)
  if (files.length !== manifest.fileCount) {
    return `file count drifted: ${files.length} on disk vs ${manifest.fileCount} in the manifest`
  }
  if (computeTreeDigest(files) !== manifest.treeDigest) return 'treeDigest mismatch (extracted content drifted)'
  return null
}

function extractSelected(lock: Lock, tarballPath: string, overrides: Map<string, Buffer>): void {
  const tmpTar = `${EXTRACT_DIR}.tar-${process.pid}`
  const tmp = `${EXTRACT_DIR}.tmp-${process.pid}`
  rmSync(tmpTar, { recursive: true, force: true })
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmpTar, { recursive: true })
  mkdirSync(tmp, { recursive: true })
  // npm tarballs root everything under package/ — strip it on extraction.
  // The shared invocation is dialect-proof (GNU tar host:path parsing).
  const tar = extractTarGz({ tarballPath, destDir: tmpTar, stripComponents: 1 })
  if (!tar.ok) {
    rmSync(tmpTar, { recursive: true, force: true })
    rmSync(tmp, { recursive: true, force: true })
    fail(`tar extraction failed: ${tar.message}`)
  }
  for (const g of lock.grammars) {
    // An override grammar installs its pinned artifact's bytes; the pack
    // tarball's own copy of that wasm (if any) is deliberately NOT taken.
    let bytes: Buffer
    if (g.sourceUrl) {
      const held = overrides.get(g.wasm)
      if (!held) {
        rmSync(tmpTar, { recursive: true, force: true })
        rmSync(tmp, { recursive: true, force: true })
        fail(`override artifact for ${g.wasm} was not secured — refusing to install`)
      }
      bytes = held
    } else {
      const from = join(tmpTar, 'out', g.wasm)
      if (!existsSync(from)) {
        rmSync(tmpTar, { recursive: true, force: true })
        rmSync(tmp, { recursive: true, force: true })
        fail(`tarball has no out/${g.wasm} — refusing to install`)
      }
      bytes = readFileSync(from)
    }
    const digest = sha256(bytes)
    if (digest !== g.sha256) {
      rmSync(tmpTar, { recursive: true, force: true })
      rmSync(tmp, { recursive: true, force: true })
      fail(`per-file sha256 mismatch for ${g.wasm}: got ${digest.slice(0, 16)}…, lock pins ${g.sha256.slice(0, 16)}…`)
    }
    writeFileSync(join(tmp, g.wasm), bytes)
  }
  for (const lf of lock.licenseFiles ?? []) {
    const from = join(tmpTar, lf)
    if (!existsSync(from)) {
      rmSync(tmpTar, { recursive: true, force: true })
      rmSync(tmp, { recursive: true, force: true })
      fail(`tarball has no ${lf} — refusing to install`)
    }
    writeFileSync(join(tmp, lf), readFileSync(from))
  }
  rmSync(tmpTar, { recursive: true, force: true })
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
    `fetch-grammars: installed ${lock.grammars.length} grammar wasms → vendor/grammars/extracted (treeDigest ${manifest.treeDigest.slice(0, 12)}…)`,
  )
}

async function main(): Promise<void> {
  const lock = readLock()
  const invalid = cacheInvalidReason(lock)

  if (checkOnly) {
    if (invalid === null) {
      console.log(`fetch-grammars --check: OK — ${lock.name} ${lock.version} cache valid against the lock`)
      process.exit(0)
    }
    console.error(`fetch-grammars --check: STALE — ${invalid}`)
    console.error('  remedy: bun run scripts/vendor/fetch-grammars.ts (downloads the pinned tarball, verifies sha512 + per-file sha256, installs)')
    process.exit(2)
  }

  if (invalid === null && !force) {
    console.log(`fetch-grammars: cache already valid for ${lock.name} ${lock.version} — nothing to do (--force re-fetches)`)
    process.exit(0)
  }

  mkdirSync(TARBALL_DIR, { recursive: true })
  const tarballPath = join(TARBALL_DIR, lock.tarball)
  let bytes: Buffer | null = null
  if (existsSync(tarballPath) && !force) {
    const local = readFileSync(tarballPath)
    if (sha512(local) === lock.sha512) {
      bytes = local
      console.log(`fetch-grammars: reusing verified local tarball (${lock.tarball})`)
    } else {
      console.log('fetch-grammars: local tarball does not match the lock — re-downloading')
    }
  }
  if (!bytes) {
    console.log(`fetch-grammars: downloading ${lock.url}`)
    const res = await fetch(lock.url)
    if (!res.ok) fail(`download failed: HTTP ${res.status} ${res.statusText}`)
    const buf = Buffer.from(await res.arrayBuffer())
    const digest = sha512(buf)
    if (digest !== lock.sha512) {
      fail(`sha512 mismatch: got ${digest.slice(0, 24)}…, lock pins ${lock.sha512.slice(0, 24)}… — refusing (artifact identity changed)`)
    }
    writeFileSync(tarballPath, buf)
    bytes = buf
    console.log(`fetch-grammars: verified sha512 ${digest.slice(0, 12)}… (${buf.byteLength} bytes)`)
  }

  const overrides = await ensureOverrideArtifacts(lock)
  extractSelected(lock, tarballPath, overrides)

  const post = cacheInvalidReason(lock)
  if (post !== null) fail(`post-extraction validation failed: ${post}`)
  console.log(`fetch-grammars: DONE — ${lock.grammars.length} grammars ready for the build (bun run build.ts)`)
}

void main()
