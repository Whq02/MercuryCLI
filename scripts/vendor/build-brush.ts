#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  BRUSH_PACK_MANIFEST_FILE,
  BRUSH_PACK_NAME,
  BRUSH_PACK_PATH,
  brushBinaryFor,
  brushPackPlatform,
  brushPackTreeDigest,
  checkBrushPackDir,
  type BrushCargoBuildManifest,
} from '../../src/utils/shell/brushPack.ts'
import { RELEASE_TARGETS, buildPlatformOf, isReleaseTarget } from '../../src/services/privateChannel/releaseTarget.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const LOCK_PATH = join(ROOT, 'vendor', 'brush.lock.json')
const PACK_ROOT = join(ROOT, ...BRUSH_PACK_PATH.split('/'))
const CARGO_TARGET_DIR = join(PACK_ROOT, '.cargo-target')

interface LockBuildEntry {
  kind: 'build'
  target: string
  crate: string
  crateVersion: string
  crateSha256: string | null
}
interface LockFetchEntry {
  kind?: 'fetch'
  target: string
  archive: string
  url: string
  checksum: string
  sha256: string
}
interface Lock {
  name: string
  version: string
  license: string
  platforms: Record<string, LockBuildEntry | LockFetchEntry>
}
const isBuildEntry = (p: LockBuildEntry | LockFetchEntry): p is LockBuildEntry => p.kind === 'build'

const argv = process.argv.slice(2)
const checkOnly = argv.includes('--check')
const force = argv.includes('--force')

function fail(msg: string): never {
  console.error(`build-brush: ${msg}`)
  process.exit(1)
}

const targetAt = argv.indexOf('--target')
const TARGET_ARG = targetAt === -1 ? null : (argv[targetAt + 1] ?? '')
if (TARGET_ARG !== null && !isReleaseTarget(TARGET_ARG)) fail(`--target wants one of ${RELEASE_TARGETS.join(', ')} (got ${TARGET_ARG || 'nothing'})`)
const SHIP = TARGET_ARG === null ? { platform: process.platform, arch: process.arch } : buildPlatformOf(TARGET_ARG)
const PLATFORM = brushPackPlatform(SHIP.platform, SHIP.arch)
const CROSS = PLATFORM !== brushPackPlatform()
const OUT_DIR = PLATFORM === null ? null : join(PACK_ROOT, PLATFORM)
const RERUN = `bun run scripts/vendor/build-brush.ts${TARGET_ARG ? ` --target ${TARGET_ARG}` : ''}`

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')

function readLock(): Lock {
  if (!existsSync(LOCK_PATH)) fail(`lock file missing: ${LOCK_PATH}`)
  const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8')) as Lock
  if (lock.name !== BRUSH_PACK_NAME) fail(`lock names ${String(lock.name)}, not ${BRUSH_PACK_NAME}`)
  if (!lock.version || !lock.license) fail("lock is missing 'version' or 'license'")
  if (typeof lock.platforms !== 'object' || lock.platforms === null) fail('lock names no platforms')
  for (const [platform, p] of Object.entries(lock.platforms)) {
    if (!isBuildEntry(p)) continue
    if (!p.target || !p.crate || !p.crateVersion) fail(`lock entry ${platform} (a build entry) lacks target/crate/crateVersion`)
    if (p.crateSha256 !== null && !/^[0-9a-f]{64}$/.test(p.crateSha256)) fail(`lock entry ${platform} crateSha256 is neither null nor a 64-hex digest`)
  }
  return lock
}

function run(cmd: string, args: string[], opts: { capture?: boolean; cwd?: string } = {}): { status: number | null; stdout: string; stderr: string; error?: Error } {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    env: { ...process.env, CARGO_TERM_COLOR: 'never' },
    encoding: 'utf8',
    stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', ...(res.error ? { error: res.error } : {}) }
}

function cargoVersion(): string | null {
  const res = run('cargo', ['--version'], { capture: true })
  if (res.error || res.status !== 0) return null
  return res.stdout.trim()
}

function cargoHome(): string {
  return process.env.CARGO_HOME ?? join(homedir(), '.cargo')
}

function registryFind(sub: 'src' | 'cache', leaf: string): string | null {
  const base = join(cargoHome(), 'registry', sub)
  if (!existsSync(base)) return null
  for (const index of readdirSync(base)) {
    const candidate = join(base, index, leaf)
    if (existsSync(candidate)) return candidate
  }
  return null
}

function packInvalidReason(lock: Lock, entry: LockBuildEntry, dir: string, platform: string): string | null {
  const check = checkBrushPackDir(dir, { digest: true, platform })
  if (check.state !== 'ok') return check.note
  const m = check.manifest
  if (m.source !== 'cargo-build') return "the pack was fetched from a release archive, not built — not this lock entry's pack"
  if (m.version !== lock.version) return `cache is ${m.version}, lock wants ${lock.version}`
  if (m.crate !== entry.crate || m.crateVersion !== entry.crateVersion) return `cache was built from ${m.crate} ${m.crateVersion}, the lock pins ${entry.crate} ${entry.crateVersion}`
  if (m.target !== entry.target) return `cache target ${m.target} is not the lock's ${entry.target}`
  if (entry.crateSha256 !== null && m.crateSha256 !== entry.crateSha256) return 'cache crateSha256 does not match the lock'
  const tree = brushPackTreeDigest(dir)
  if (tree.fileCount !== m.fileCount) return `file count drifted: ${tree.fileCount} on disk vs ${m.fileCount} in the manifest`
  if (tree.treeDigest !== m.treeDigest) return 'treeDigest mismatch (pack content drifted)'
  if (!existsSync(join(dir, 'NOTICES.json'))) return 'NOTICES.json missing'
  const licenses = join(dir, 'licenses')
  if (!existsSync(licenses) || readdirSync(licenses).length === 0) return 'licenses/ missing or empty'
  return null
}

interface CargoPackage {
  id: string
  name: string
  version: string
  license: string | null
  license_file: string | null
  manifest_path: string
  repository: string | null
}

function linkedCrates(manifestPath: string, triple: string): CargoPackage[] {
  const res = run('cargo', ['metadata', '--format-version', '1', '--locked', '--manifest-path', manifestPath, '--filter-platform', triple], { capture: true, cwd: dirname(manifestPath) })
  if (res.status !== 0) fail(`cargo metadata failed: ${res.stderr.trim().slice(-400)}`)
  const meta = JSON.parse(res.stdout) as { packages: CargoPackage[]; resolve: { nodes: Array<{ id: string }> } | null }
  const resolved = new Set((meta.resolve?.nodes ?? []).map(n => n.id))
  const byId = new Map(meta.packages.map(p => [p.id, p]))
  const out: CargoPackage[] = []
  for (const id of resolved) {
    const pkg = byId.get(id)
    if (pkg) out.push(pkg)
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
}

const LICENSE_FILE = /^(LICENSE|LICENCE|COPYING|NOTICE)([-._].*)?$/i

function installPack(cargo: string, lock: Lock, entry: LockBuildEntry, installRoot: string, crateSha256: string | null, outDir: string, platform: string): void {
  const binary = brushBinaryFor(platform)
  const built = join(installRoot, 'bin', binary)
  if (!existsSync(built)) fail(`cargo reported success but ${built} is absent`)
  const srcDir = registryFind('src', `${entry.crate}-${entry.crateVersion}`)
  if (srcDir === null) fail(`cargo's registry under ${cargoHome()} holds no unpacked source for ${entry.crate} ${entry.crateVersion} — the licence inventory cannot be laid, so the pack is not installed`)
  const tmp = `${outDir}.tmp-${process.pid}`
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(join(tmp, 'licenses'), { recursive: true })
  copyFileSync(built, join(tmp, binary))
  if (process.platform !== 'win32' && !binary.endsWith('.exe')) chmodSync(join(tmp, binary), 0o755)
  const notices: Array<{ name: string; version: string; license: string; repository: string | null; licenseFiles: string[] }> = []
  const ownLicenseFiles: string[] = []
  for (const pkg of linkedCrates(join(srcDir, 'Cargo.toml'), entry.target)) {
    const license = pkg.license ?? (pkg.license_file ? `see ${pkg.license_file}` : 'UNKNOWN')
    const crateDir = dirname(pkg.manifest_path)
    const dest = join(tmp, 'licenses', `${pkg.name}-${pkg.version}`)
    mkdirSync(dest, { recursive: true })
    const files: string[] = []
    for (const name of readdirSync(crateDir)) {
      if (!LICENSE_FILE.test(name)) continue
      const full = join(crateDir, name)
      if (!statSync(full).isFile()) continue
      copyFileSync(full, join(dest, name))
      files.push(name)
    }
    if (files.length === 0) {
      rmSync(dest, { recursive: true, force: true })
      writeFileSync(join(tmp, 'licenses', `${pkg.name}-${pkg.version}.txt`), `${pkg.name} ${pkg.version}: ${license} (no licence file in the crate; see ${pkg.repository ?? 'the crate registry'})\n`)
    }
    if (pkg.name === entry.crate && pkg.version === entry.crateVersion) ownLicenseFiles.push(...files.map(f => `licenses/${pkg.name}-${pkg.version}/${f}`))
    notices.push({ name: pkg.name, version: pkg.version, license, repository: pkg.repository, licenseFiles: files })
  }
  writeFileSync(join(tmp, 'NOTICES.json'), JSON.stringify({ pack: BRUSH_PACK_NAME, source: 'cargo-build', platform, crate: entry.crate, crateVersion: entry.crateVersion, crates: notices }, null, 2) + '\n')
  const tree = brushPackTreeDigest(tmp)
  const manifest: BrushCargoBuildManifest = {
    name: BRUSH_PACK_NAME,
    source: 'cargo-build',
    version: lock.version,
    platform,
    target: entry.target,
    crate: entry.crate,
    crateVersion: entry.crateVersion,
    crateSha256,
    cargo,
    binary,
    binarySha256: sha256(readFileSync(join(tmp, binary))),
    license: lock.license,
    licenseFiles: ['NOTICES.json', ...ownLicenseFiles],
    fileCount: tree.fileCount,
    treeDigest: tree.treeDigest,
  }
  writeFileSync(join(tmp, BRUSH_PACK_MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n')
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(PACK_ROOT, { recursive: true })
  renameSync(tmp, outDir)
  console.log(`build-brush: installed ${binary} + ${notices.length} crate licences → ${BRUSH_PACK_PATH}/${platform} (treeDigest ${manifest.treeDigest.slice(0, 12)}…)`)
}

function main(): void {
  const lock = readLock()
  if (PLATFORM === null || OUT_DIR === null) {
    console.log(`build-brush: no shell-engine pack layout exists for ${SHIP.platform}/${SHIP.arch} — nothing to build`)
    process.exit(0)
  }
  const entry = lock.platforms[PLATFORM]
  const builds = Object.entries(lock.platforms).filter(([, p]) => isBuildEntry(p)).map(([k]) => k)
  if (entry === undefined || !isBuildEntry(entry)) {
    console.log(
      `build-brush: SKIPPED — the lock ${entry ? 'FETCHES' : 'pins nothing for'} the ${PLATFORM} pack${entry ? ` (bun run scripts/vendor/fetch-brush.ts${CROSS ? ` --platform ${PLATFORM}` : ''} prepares upstream's release binary)` : ''}; ` +
        `this command builds only the platforms the lock marks kind build (${builds.join(', ') || 'none'}).`,
    )
    process.exit(0)
  }
  if (checkOnly) {
    const invalid = packInvalidReason(lock, entry, OUT_DIR, PLATFORM)
    if (invalid === null) {
      console.log(`build-brush --check: OK — ${BRUSH_PACK_NAME} ${lock.version} ${PLATFORM} pack valid against the lock's build entry`)
      process.exit(0)
    }
    console.error(`build-brush --check: STALE — ${PLATFORM}: ${invalid}`)
    console.error(`  remedy: ${RERUN} (cargo install --locked, then the pack install)`)
    process.exit(2)
  }
  const invalid = packInvalidReason(lock, entry, OUT_DIR, PLATFORM)
  if (invalid === null && !force) {
    console.log(`build-brush: pack already valid for ${BRUSH_PACK_NAME} ${lock.version} ${PLATFORM} — nothing to do (--force rebuilds)`)
    process.exit(0)
  }
  const cargo = cargoVersion()
  if (cargo === null) {
    console.log(
      `build-brush: SKIPPED — no cargo on PATH, so the shell engine pack is not built for ${PLATFORM}. ` +
        `The build ships without the vendored shell engine (degraded: shell-engine; the Bash tool keeps the system shell) and the doctor says so; install a Rust toolchain (https://rustup.rs) and re-run ${RERUN}.`,
    )
    process.exit(0)
  }
  if (CROSS) {
    const installed = run('rustup', ['target', 'list', '--installed'], { capture: true })
    const present = installed.status === 0 && installed.stdout.split('\n').map(l => l.trim()).includes(entry.target)
    if (!present) {
      console.log(
        `build-brush: SKIPPED — the rustup target ${entry.target} is not installed on this machine, so the shell engine pack is not cross-compiled for ${PLATFORM}. ` +
          `The build ships without the vendored shell engine (degraded: shell-engine) and the doctor says so; install it (rustup target add ${entry.target}) and re-run ${RERUN}.`,
      )
      process.exit(0)
    }
  }
  if (invalid !== null && existsSync(OUT_DIR)) console.log(`build-brush: rebuilding — ${invalid}`)
  const installRoot = join(PACK_ROOT, `.install-${process.pid}`)
  rmSync(installRoot, { recursive: true, force: true })
  mkdirSync(installRoot, { recursive: true })
  console.log(`build-brush: ${cargo} — cargo install --locked ${entry.crate} --version ${entry.crateVersion}${CROSS ? ` --target ${entry.target}` : ''} (${PLATFORM})`)
  const build = run('cargo', ['install', '--locked', entry.crate, '--version', entry.crateVersion, '--root', installRoot, '--target-dir', CARGO_TARGET_DIR, ...(CROSS ? ['--target', entry.target] : [])])
  if (build.error) fail(`cargo could not be started: ${build.error.message}`)
  if (build.status !== 0) {
    rmSync(installRoot, { recursive: true, force: true })
    fail(`cargo install failed (exit ${String(build.status)}) — the shell engine pack is not installed; the build ships without the vendored shell engine (degraded: shell-engine). Fix the reported error and re-run ${RERUN}`)
  }
  const crateFile = registryFind('cache', `${entry.crate}-${entry.crateVersion}.crate`)
  const crateSha256 = crateFile === null ? null : sha256(readFileSync(crateFile))
  if (entry.crateSha256 !== null && crateSha256 !== null && crateSha256 !== entry.crateSha256) {
    rmSync(installRoot, { recursive: true, force: true })
    fail(`crate archive sha256 mismatch for ${entry.crate} ${entry.crateVersion}: got ${crateSha256.slice(0, 24)}…, lock pins ${entry.crateSha256.slice(0, 24)}… — refusing (artifact identity changed)`)
  }
  if (entry.crateSha256 === null) {
    console.log(crateSha256 === null
      ? `build-brush: cargo kept no ${entry.crate}-${entry.crateVersion}.crate in its registry cache — crateSha256 stays null in the manifest`
      : `build-brush: the crate archive's sha256 is ${crateSha256} — pin it as the lock's ${PLATFORM} crateSha256 so the next build verifies it`)
  }
  installPack(cargo, lock, entry, installRoot, crateSha256, OUT_DIR, PLATFORM)
  rmSync(installRoot, { recursive: true, force: true })
  const post = packInvalidReason(lock, entry, OUT_DIR, PLATFORM)
  if (post !== null) fail(`post-install validation failed for ${PLATFORM}: ${post}`)
  const size = statSync(join(OUT_DIR, brushBinaryFor(PLATFORM))).size
  console.log(`build-brush: DONE — ${BRUSH_PACK_NAME} ${lock.version} ${PLATFORM} ready for the build (${size} bytes; bun run build.ts)`)
}

main()
