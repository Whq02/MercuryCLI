#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { extractTarGz } from './tarExtract.ts'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import {
  PYTHON_PACK_PLATFORMS,
  pythonBinaryFor,
  pythonPackKeeps,
  pythonPackPlatform,
  pythonPackSelectionFor,
  type PythonPackPlatform,
} from '../../src/services/privateChannel/vendoredPython.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const LOCK_PATH = join(ROOT, 'vendor', 'python.lock.json')
const LICENCE_DIR = join(ROOT, 'vendor', 'python-licences')
const CACHE_DIR = join(ROOT, 'vendor', 'python')
const ARCHIVE_DIR = join(CACHE_DIR, 'archive')
const EXTRACT_ROOT = join(CACHE_DIR, 'extracted')

interface LockPlatform {
  target: string
  archive: string
  url: string
  sha256: string
  sizeBytes: number
}

interface Lock {
  name: string
  version: string
  release: string
  repository: string
  license: string
  licenseFiles: string[]
  licenceTexts: Record<string, string>
  checksums: string
  platforms: Record<string, LockPlatform>
}

interface VendorManifest {
  name: string
  version: string
  release: string
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
  console.error(`fetch-python: ${msg}`)
  process.exit(1)
}

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')

function readLock(): Lock {
  if (!existsSync(LOCK_PATH)) fail(`lock file missing: ${LOCK_PATH}`)
  const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8')) as Lock
  for (const key of ['name', 'version', 'release', 'repository', 'license', 'checksums'] as const) {
    if (!lock[key]) fail(`lock is missing '${key}'`)
  }
  if (!Array.isArray(lock.licenseFiles) || lock.licenseFiles.length === 0) fail('lock names no licence files')
  if (typeof lock.licenceTexts !== 'object' || lock.licenceTexts === null) fail('lock names no licence texts')
  if (typeof lock.platforms !== 'object' || lock.platforms === null) fail('lock names no platforms')
  if (!lock.checksums.startsWith(`${lock.repository}/releases/download/${lock.release}/`)) fail('lock checksums url is not the pinned release\'s asset')
  for (const platform of PYTHON_PACK_PLATFORMS) {
    const p = lock.platforms[platform]
    if (!p) fail(`lock has no entry for ${platform}`)
    if (!p.target || !p.archive || !p.url) fail(`lock entry ${platform} lacks target/archive/url`)
    if (!/^[0-9a-f]{64}$/.test(p.sha256)) fail(`lock entry ${platform} sha256 is not a 64-hex digest`)
    if (!Number.isInteger(p.sizeBytes) || p.sizeBytes <= 0) fail(`lock entry ${platform} sizeBytes is not a byte count`)
    if (!p.url.startsWith(`${lock.repository}/releases/download/${lock.release}/`)) fail(`lock entry ${platform} url is not the pinned release's asset`)
    if (!p.archive.startsWith(`cpython-${lock.version}+${lock.release}-${p.target}-`)) fail(`lock entry ${platform} archive is not the pinned version's asset for ${p.target}`)
  }
  for (const name of lock.licenseFiles) {
    if (name === 'LICENSE.txt') continue
    const base = name.replace(/^licenses\//, '')
    if (!lock.licenceTexts[base]) fail(`lock licence file ${name} has no digest in licenceTexts`)
  }
  return lock
}

function selectPlatforms(): PythonPackPlatform[] {
  if (all) return [...PYTHON_PACK_PLATFORMS]
  const named: PythonPackPlatform[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--platform') continue
    const value = argv[i + 1]
    if (!value || !(PYTHON_PACK_PLATFORMS as readonly string[]).includes(value)) {
      fail(`--platform wants one of ${PYTHON_PACK_PLATFORMS.join(', ')} (got ${value ?? 'nothing'})`)
    }
    named.push(value as PythonPackPlatform)
    i++
  }
  if (named.length > 0) return [...new Set(named)]
  const host = pythonPackPlatform(process.platform, process.arch)
  if (host === null) {
    console.log(
      `fetch-python: python-build-standalone publishes no interpreter archive Mercury vendors for ${process.platform}/${process.arch} — nothing to prepare here; the build ships without a vendored Python and says so (the Python debugger runs on a PATH python3)`,
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

function cacheInvalidReason(lock: Lock, platform: PythonPackPlatform): string | null {
  const extractDir = join(EXTRACT_ROOT, platform)
  const manifestPath = join(extractDir, '.vendor-manifest.json')
  if (!existsSync(manifestPath)) return `no extracted cache (vendor/python/extracted/${platform} absent)`
  let manifest: VendorManifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as VendorManifest
  } catch (e) {
    return `vendor manifest unparseable: ${String(e).slice(0, 80)}`
  }
  const pinned = lock.platforms[platform]!
  if (manifest.version !== lock.version) return `cache is ${manifest.version}, lock wants ${lock.version}`
  if (manifest.release !== lock.release) return `cache is release ${manifest.release}, lock wants ${lock.release}`
  if (manifest.platform !== platform) return `cache is ${manifest.platform}, lock entry is ${platform}`
  if (manifest.archiveSha256 !== pinned.sha256) return 'cache archiveSha256 does not match the lock'
  const binary = pythonBinaryFor(platform)
  if (manifest.binary !== binary) return `cache binary is ${manifest.binary}, the pack law wants ${binary}`
  if (!existsSync(join(extractDir, ...binary.split('/')))) return `interpreter missing: ${binary}`
  for (const lf of lock.licenseFiles) {
    if (!existsSync(join(extractDir, ...lf.split('/')))) return `licence file missing: ${lf}`
  }
  const files = walkFiles(extractDir)
  if (files.length !== manifest.fileCount) {
    return `file count drifted: ${files.length} on disk vs ${manifest.fileCount} in the manifest`
  }
  if (computeTreeDigest(files) !== manifest.treeDigest) return 'treeDigest mismatch (extracted content drifted)'
  return null
}

function copyTree(from: string, to: string, rel: string, keeps: (rel: string) => boolean, count: { files: number }): void {
  const stat = statSync(from)
  if (stat.isDirectory()) {
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue
      const childRel = `${rel}/${entry.name}`
      if (!keeps(childRel)) continue
      copyTree(join(from, entry.name), join(to, entry.name), childRel, keeps, count)
    }
    return
  }
  if (!stat.isFile()) return
  mkdirSync(join(to, '..'), { recursive: true })
  copyFileSync(from, to)
  count.files++
}

function installSelected(lock: Lock, platform: PythonPackPlatform, archivePath: string): void {
  const extractDir = join(EXTRACT_ROOT, platform)
  const tmpUnpack = `${extractDir}.unpack-${process.pid}`
  const tmp = `${extractDir}.tmp-${process.pid}`
  const abandon = (why: string): never => {
    rmSync(tmpUnpack, { recursive: true, force: true })
    rmSync(tmp, { recursive: true, force: true })
    return fail(why)
  }
  rmSync(tmpUnpack, { recursive: true, force: true })
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmpUnpack, { recursive: true })
  mkdirSync(tmp, { recursive: true })
  const tar = extractTarGz({ tarballPath: archivePath, destDir: tmpUnpack, stripComponents: 1 })
  if (!tar.ok) abandon(`tar extraction failed: ${tar.message}`)
  const selection = pythonPackSelectionFor(platform, lock.version)
  const binary = pythonBinaryFor(platform)
  const interpreter = join(tmpUnpack, ...selection.interpreter.split('/'))
  if (!existsSync(interpreter)) abandon(`archive has no ${selection.interpreter} — refusing to install`)
  const count = { files: 0 }
  const binaryTo = join(tmp, ...binary.split('/'))
  mkdirSync(join(binaryTo, '..'), { recursive: true })
  copyFileSync(interpreter, binaryTo)
  count.files++
  for (const root of selection.roots) {
    const from = join(tmpUnpack, ...root.split('/'))
    if (!existsSync(from)) abandon(`archive has no ${root} — refusing to install`)
    copyTree(from, join(tmp, ...root.split('/')), root, rel => pythonPackKeeps(selection, rel), count)
  }
  const licence = join(tmpUnpack, ...selection.licence.split('/'))
  if (!existsSync(licence)) abandon(`archive has no ${selection.licence} — refusing to install`)
  copyFileSync(licence, join(tmp, 'LICENSE.txt'))
  mkdirSync(join(tmp, 'licenses'), { recursive: true })
  for (const [name, digest] of Object.entries(lock.licenceTexts)) {
    const tracked = join(LICENCE_DIR, name)
    if (!existsSync(tracked)) abandon(`tracked licence text missing: vendor/python-licences/${name}`)
    const read = readFileSync(tracked)
    const bytes = [read, Buffer.from(read.toString('latin1').replaceAll('\r\n', '\n'), 'latin1')].find(form => sha256(form) === digest)
    if (bytes === undefined) abandon(`tracked licence text vendor/python-licences/${name} does not match the lock's digest`)
    writeFileSync(join(tmp, 'licenses', name), bytes!)
  }
  for (const lf of lock.licenseFiles) {
    if (!existsSync(join(tmp, ...lf.split('/')))) abandon(`installed tree is missing the licence file ${lf} — refusing to install`)
  }
  rmSync(tmpUnpack, { recursive: true, force: true })
  if (process.platform !== 'win32' && !binary.endsWith('.exe')) chmodSync(binaryTo, 0o755)
  const files = walkFiles(tmp)
  const manifest: VendorManifest = {
    name: lock.name,
    version: lock.version,
    release: lock.release,
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
  const bytes = files.reduce((n, f) => n + statSync(join(extractDir, ...f.rel.split('/'))).size, 0)
  console.log(`fetch-python: installed ${binary} + the standard library + ${lock.licenseFiles.length} licence files → vendor/python/extracted/${platform} (${files.length} files, ${bytes} bytes, treeDigest ${manifest.treeDigest.slice(0, 12)}…)`)
}

async function secureArchive(lock: Lock, platform: PythonPackPlatform): Promise<string> {
  const pinned = lock.platforms[platform]!
  mkdirSync(ARCHIVE_DIR, { recursive: true })
  const archivePath = join(ARCHIVE_DIR, pinned.archive)
  if (existsSync(archivePath) && !force) {
    const local = readFileSync(archivePath)
    if (local.byteLength === pinned.sizeBytes && sha256(local) === pinned.sha256) {
      console.log(`fetch-python: reusing verified local archive (${pinned.archive})`)
      return archivePath
    }
    console.log(`fetch-python: local archive ${pinned.archive} does not match the lock — re-downloading`)
  }
  console.log(`fetch-python: downloading ${pinned.url}`)
  const res = await fetch(pinned.url)
  if (!res.ok) fail(`download failed for ${platform}: HTTP ${res.status} ${res.statusText}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.byteLength !== pinned.sizeBytes) {
    fail(`size mismatch for ${pinned.archive}: got ${buf.byteLength} bytes, lock pins ${pinned.sizeBytes} — refusing (artifact identity changed)`)
  }
  const digest = sha256(buf)
  if (digest !== pinned.sha256) {
    fail(`sha256 mismatch for ${pinned.archive}: got ${digest.slice(0, 24)}…, lock pins ${pinned.sha256.slice(0, 24)}… — refusing (artifact identity changed)`)
  }
  writeFileSync(archivePath, buf)
  console.log(`fetch-python: verified sha256 ${digest.slice(0, 12)}… (${buf.byteLength} bytes)`)
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
        console.log(`fetch-python --check: OK — python ${lock.version} ${platform} cache valid against the lock`)
      } else {
        stale++
        console.error(`fetch-python --check: STALE — ${platform}: ${invalid}`)
      }
    }
    if (stale > 0) {
      console.error('  remedy: bun run scripts/vendor/fetch-python.ts (downloads the pinned archive, verifies sha256, installs the interpreter, its standard library and the licence files)')
      process.exit(2)
    }
    process.exit(0)
  }

  for (const platform of platforms) {
    const invalid = cacheInvalidReason(lock, platform)
    if (invalid === null && !force) {
      console.log(`fetch-python: cache already valid for python ${lock.version} ${platform} — nothing to do (--force re-fetches)`)
      continue
    }
    const archivePath = await secureArchive(lock, platform)
    installSelected(lock, platform, archivePath)
    const post = cacheInvalidReason(lock, platform)
    if (post !== null) fail(`post-extraction validation failed for ${platform}: ${post}`)
    console.log(`fetch-python: DONE — python ${lock.version} ${platform} ready for the build (bun run build.ts)`)
  }
}

void main()
