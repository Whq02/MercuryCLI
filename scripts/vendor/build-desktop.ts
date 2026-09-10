#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { voiceCargoTriple, voicePackPlatform } from '../../src/services/voice/voicePack.ts'
import {
  DESKTOP_ADDON_FILE,
  DESKTOP_BUILD_COMMAND,
  DESKTOP_NATIVE_PATH,
  DESKTOP_PACK_MANIFEST_FILE,
  DESKTOP_PACK_NAME,
  DESKTOP_PACK_PATH,
  checkDesktopPackDir,
  desktopPackDirFor,
  desktopPackTreeDigest,
  desktopSourceTreeDigest,
  readDesktopPackManifest,
  type DesktopPackCrate,
  type DesktopPackManifest,
} from '../../src/services/desktop/pack.ts'
import { RELEASE_TARGETS, buildPlatformOf, isReleaseTarget } from '../../src/services/privateChannel/releaseTarget.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const NATIVE_DIR = join(ROOT, ...DESKTOP_NATIVE_PATH.split('/'))
const MANIFEST_PATH = join(NATIVE_DIR, 'Cargo.toml')
const TARGET_DIR = join(NATIVE_DIR, 'target')
const DEGRADED = 'degraded: desktop-driver'

const argv = process.argv.slice(2)
const checkOnly = argv.includes('--check')
const force = argv.includes('--force')

function fail(msg: string): never {
  console.error(`build-desktop: ${msg}`)
  process.exit(1)
}

const targetAt = argv.indexOf('--target')
const TARGET_ARG = targetAt === -1 ? null : (argv[targetAt + 1] ?? '')
if (TARGET_ARG !== null && !isReleaseTarget(TARGET_ARG)) fail(`--target wants one of ${RELEASE_TARGETS.join(', ')} (got ${TARGET_ARG || 'nothing'})`)
const SHIP = TARGET_ARG === null ? { platform: process.platform, arch: process.arch } : buildPlatformOf(TARGET_ARG)
const PLATFORM = voicePackPlatform(SHIP.platform, SHIP.arch)
const CROSS = PLATFORM !== voicePackPlatform()
const TRIPLE = voiceCargoTriple(PLATFORM)
const OUT_DIR = desktopPackDirFor(ROOT, PLATFORM)

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')

function cargoArtifactName(): string {
  if (SHIP.platform === 'win32') return 'mercury_desktop.dll'
  if (SHIP.platform === 'darwin') return 'libmercury_desktop.dylib'
  return 'libmercury_desktop.so'
}

function run(cmd: string, args: string[], opts: { capture?: boolean } = {}): { status: number | null; stdout: string; stderr: string; error?: Error } {
  const res = spawnSync(cmd, args, {
    cwd: NATIVE_DIR,
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

function packInvalidReason(): string | null {
  const check = checkDesktopPackDir(OUT_DIR, { digest: true, platform: PLATFORM })
  if (check.state !== 'ok') return check.note
  const manifest = check.manifest
  if (!existsSync(NATIVE_DIR)) return `${DESKTOP_NATIVE_PATH} is absent — nothing to compare the pack against`
  const sourceDigest = desktopSourceTreeDigest(NATIVE_DIR)
  if (manifest.sourceTreeDigest !== sourceDigest) return `the pack was built from another source tree (${manifest.sourceTreeDigest.slice(0, 12)}…, sources now ${sourceDigest.slice(0, 12)}…)`
  const tree = desktopPackTreeDigest(OUT_DIR)
  if (tree.fileCount !== manifest.fileCount) return `file count drifted: ${tree.fileCount} on disk vs ${manifest.fileCount} in the manifest`
  if (tree.treeDigest !== manifest.treeDigest) return 'treeDigest mismatch (pack content drifted)'
  if (!existsSync(join(OUT_DIR, 'NOTICES.json'))) return 'NOTICES.json missing'
  for (const crate of manifest.crates) {
    if (crate.name === DESKTOP_PACK_NAME.replace('-', '_')) continue
    const stem = join(OUT_DIR, 'licenses', `${crate.name}-${crate.version}`)
    if (!existsSync(stem) && !existsSync(`${stem}.txt`)) return `licence record missing for ${crate.name} ${crate.version}`
  }
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

function linkedCrates(): CargoPackage[] {
  const host = run('rustc', ['-vV'], { capture: true })
  const triple = CROSS ? (TRIPLE ?? undefined) : /host:\s*(\S+)/.exec(host.stdout)?.[1]
  const args = ['metadata', '--format-version', '1', '--manifest-path', MANIFEST_PATH, ...(triple ? ['--filter-platform', triple] : [])]
  const res = run('cargo', args, { capture: true })
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

function installPack(cargo: string): void {
  const artifact = join(TARGET_DIR, ...(CROSS && TRIPLE ? [TRIPLE] : []), 'release', cargoArtifactName())
  if (!existsSync(artifact)) fail(`cargo reported success but ${artifact} is absent`)
  const tmp = `${OUT_DIR}.tmp-${process.pid}`
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(join(tmp, 'licenses'), { recursive: true })
  copyFileSync(artifact, join(tmp, DESKTOP_ADDON_FILE))
  const crates: DesktopPackCrate[] = []
  const notices: Array<{ name: string; version: string; license: string; repository: string | null; licenseFiles: string[] }> = []
  for (const pkg of linkedCrates()) {
    const own = pkg.name === 'mercury_desktop'
    const license = own ? 'Mercury (see LICENSE.md at the repository root)' : (pkg.license ?? (pkg.license_file ? `see ${pkg.license_file}` : 'UNKNOWN'))
    crates.push({ name: pkg.name, version: pkg.version, license })
    const files: string[] = []
    if (!own) {
      const crateDir = dirname(pkg.manifest_path)
      const dest = join(tmp, 'licenses', `${pkg.name}-${pkg.version}`)
      mkdirSync(dest, { recursive: true })
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
    }
    notices.push({ name: pkg.name, version: pkg.version, license, repository: pkg.repository, licenseFiles: files })
  }
  writeFileSync(join(tmp, 'NOTICES.json'), JSON.stringify({ pack: DESKTOP_PACK_NAME, platform: PLATFORM, crates: notices }, null, 2) + '\n')
  const crateVersion = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(MANIFEST_PATH, 'utf8'))?.[1] ?? '0.0.0'
  const tree = desktopPackTreeDigest(tmp)
  const manifest: DesktopPackManifest = {
    name: DESKTOP_PACK_NAME,
    version: crateVersion,
    platform: PLATFORM,
    addon: DESKTOP_ADDON_FILE,
    addonSha256: sha256(readFileSync(join(tmp, DESKTOP_ADDON_FILE))),
    sourceTreeDigest: desktopSourceTreeDigest(NATIVE_DIR),
    cargo,
    crates,
    fileCount: tree.fileCount,
    treeDigest: tree.treeDigest,
  }
  writeFileSync(join(tmp, DESKTOP_PACK_MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n')
  rmSync(OUT_DIR, { recursive: true, force: true })
  mkdirSync(dirname(OUT_DIR), { recursive: true })
  renameSync(tmp, OUT_DIR)
  console.log(`build-desktop: installed ${DESKTOP_ADDON_FILE} + ${crates.length} crate licences → ${DESKTOP_PACK_PATH}/${PLATFORM} (treeDigest ${manifest.treeDigest.slice(0, 12)}…)`)
}

function main(): void {
  if (checkOnly) {
    const invalid = packInvalidReason()
    if (invalid === null) {
      const manifest = readDesktopPackManifest(OUT_DIR)
      console.log(`build-desktop --check: OK — ${DESKTOP_PACK_NAME} ${manifest?.version ?? '?'} ${PLATFORM} pack valid against ${DESKTOP_NATIVE_PATH}`)
      process.exit(0)
    }
    console.error(`build-desktop --check: STALE — ${PLATFORM}: ${invalid}`)
    console.error(`  remedy: ${DESKTOP_BUILD_COMMAND} (cargo build --release, then the pack install)`)
    process.exit(2)
  }
  if (!existsSync(MANIFEST_PATH)) fail(`${DESKTOP_NATIVE_PATH}/Cargo.toml is absent — nothing to build`)
  const invalid = packInvalidReason()
  if (invalid === null && !force) {
    console.log(`build-desktop: pack already valid for ${PLATFORM} — nothing to do (--force rebuilds)`)
    process.exit(0)
  }
  const dropStale = (): void => {
    if (invalid !== null && existsSync(OUT_DIR)) {
      rmSync(OUT_DIR, { recursive: true, force: true })
      console.log(`build-desktop: removed the stale pack at ${DESKTOP_PACK_PATH}/${PLATFORM} (${invalid}) — it cannot be rebuilt here`)
    }
  }
  const cargo = cargoVersion()
  if (cargo === null) {
    dropStale()
    console.log(
      `build-desktop: SKIPPED — no cargo on PATH, so the desktop driver pack is not built for ${PLATFORM}. ` +
        `The build ships without computer use (${DEGRADED}) and the doctor says so; install a Rust toolchain (https://rustup.rs) and re-run ${DESKTOP_BUILD_COMMAND}`,
    )
    process.exit(0)
  }
  if (CROSS) {
    if (TRIPLE === null) {
      dropStale()
      console.log(`build-desktop: SKIPPED — no cargo target triple is known for ${PLATFORM}; the build ships without computer use (${DEGRADED}) and the doctor says so.`)
      process.exit(0)
    }
    const installed = run('rustup', ['target', 'list', '--installed'], { capture: true })
    const present = installed.status === 0 && installed.stdout.split('\n').map(l => l.trim()).includes(TRIPLE)
    if (!present) {
      dropStale()
      console.log(
        `build-desktop: SKIPPED — the rustup target ${TRIPLE} is not installed on this machine, so the desktop driver pack is not cross-compiled for ${PLATFORM}. ` +
          `The build ships without computer use (${DEGRADED}) and the doctor says so; install it (rustup target add ${TRIPLE}) and re-run ${DESKTOP_BUILD_COMMAND} --target ${TARGET_ARG}.`,
      )
      process.exit(0)
    }
  }
  if (invalid !== null && existsSync(OUT_DIR)) console.log(`build-desktop: rebuilding — ${invalid}`)
  console.log(`build-desktop: ${cargo} — cargo build --release (${DESKTOP_NATIVE_PATH}, ${PLATFORM}${CROSS ? `, --target ${TRIPLE}` : ''})`)
  const build = run('cargo', ['build', '--release', '--manifest-path', MANIFEST_PATH, '--target-dir', TARGET_DIR, ...(CROSS && TRIPLE ? ['--target', TRIPLE] : [])])
  if (build.error) fail(`cargo could not be started: ${build.error.message}`)
  if (build.status !== 0) {
    fail(`cargo build failed (exit ${String(build.status)}) — the desktop driver pack is not installed; the build ships without computer use (${DEGRADED}). Fix the reported error and re-run ${DESKTOP_BUILD_COMMAND}`)
  }
  installPack(cargo)
  const post = packInvalidReason()
  if (post !== null) fail(`post-install validation failed for ${PLATFORM}: ${post}`)
  const size = statSync(join(OUT_DIR, DESKTOP_ADDON_FILE)).size
  console.log(`build-desktop: DONE — ${DESKTOP_PACK_NAME} ${PLATFORM} ready for the build (${size} bytes; bun run build.ts)`)
}

main()
