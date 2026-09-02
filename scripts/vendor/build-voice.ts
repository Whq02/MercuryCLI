#!/usr/bin/env bun
// ============================================================================
//  scripts/vendor/build-voice.ts — the explicit vendor-preparation command
//  for the voice capture pack: BUILT from native/voice with cargo, never
//  fetched.
//
//  The pack is a Node-API addon (mercury_voice.node) over the platform's
//  own audio layer; Node-API is ABI-stable, so one build serves the
//  vendored Node and a PATH Node alike. This command builds it for the HOST
//  platform and installs, under vendor/voice/<platform>/:
//    mercury_voice.node              the addon (cargo build --release)
//    licenses/<crate>-<version>/     every LICENSE* / COPYING* of every
//                                    crate linked into it (cargo metadata,
//                                    host-filtered) — the pack law: licence
//                                    preserved
//    NOTICES.json                    the crate inventory (name · version ·
//                                    licence · repository)
//    .vendor-manifest.json           the record: version · platform · the
//                                    addon's sha256 · the SOURCE TREE digest
//                                    it was built from · treeDigest
//
//  Same contract as the fetched packs: the build (build.ts) consumes ONLY a
//  valid local pack and refuses a PRESENT pack older than its sources; an
//  absent pack degrades the artifact honestly (`voice-input`) and the doctor
//  says so. No cargo on the machine ⇒ a LOUD skip, exit 0 (the setup chain
//  continues; the affected feature names the remedy). A cargo build that
//  FAILS exits 1 naming the reason (the release workflow marks this step
//  optional so the archive still publishes, degraded and honest).
//
//  --check = no-cargo validity (exit 0 valid / 2 stale + remedy);
//  --force rebuilds a valid pack.
//
//  Run:  bun run scripts/vendor/build-voice.ts [--check] [--force]
// ============================================================================
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  VOICE_ADDON_FILE,
  VOICE_NATIVE_PATH,
  VOICE_PACK_MANIFEST_FILE,
  VOICE_PACK_NAME,
  VOICE_PACK_PATH,
  checkVoicePackDir,
  readVoicePackManifest,
  voicePackPlatform,
  voicePackTreeDigest,
  voiceSourceTreeDigest,
  type VoicePackCrate,
  type VoicePackManifest,
} from '../../src/services/voice/voicePack.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const NATIVE_DIR = join(ROOT, ...VOICE_NATIVE_PATH.split('/'))
const MANIFEST_PATH = join(NATIVE_DIR, 'Cargo.toml')
const TARGET_DIR = join(NATIVE_DIR, 'target')
const PLATFORM = voicePackPlatform()
const OUT_DIR = join(ROOT, ...VOICE_PACK_PATH.split('/'), PLATFORM)

const argv = process.argv.slice(2)
const checkOnly = argv.includes('--check')
const force = argv.includes('--force')

function fail(msg: string): never {
  console.error(`build-voice: ${msg}`)
  process.exit(1)
}

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')

/** The cdylib cargo emits for this host, under target/release. */
function cargoArtifactName(): string {
  if (process.platform === 'win32') return 'mercury_voice.dll'
  if (process.platform === 'darwin') return 'libmercury_voice.dylib'
  return 'libmercury_voice.so'
}

// env passed explicitly: bun's spawnSync otherwise resolves executables
// against the PROCESS-START PATH (the cargo shim sits in ~/.cargo/bin).
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

/** Why a present pack is not the pack the sources describe, or null. */
function packInvalidReason(): string | null {
  const check = checkVoicePackDir(OUT_DIR, { digest: true, platform: PLATFORM })
  if (check.state !== 'ok') return check.note
  const manifest = check.manifest
  if (!existsSync(NATIVE_DIR)) return `${VOICE_NATIVE_PATH} is absent — nothing to compare the pack against`
  const sourceDigest = voiceSourceTreeDigest(NATIVE_DIR)
  if (manifest.sourceTreeDigest !== sourceDigest) return `the pack was built from another source tree (${manifest.sourceTreeDigest.slice(0, 12)}…, sources now ${sourceDigest.slice(0, 12)}…)`
  const tree = voicePackTreeDigest(OUT_DIR)
  if (tree.fileCount !== manifest.fileCount) return `file count drifted: ${tree.fileCount} on disk vs ${manifest.fileCount} in the manifest`
  if (tree.treeDigest !== manifest.treeDigest) return 'treeDigest mismatch (pack content drifted)'
  if (!existsSync(join(OUT_DIR, 'NOTICES.json'))) return 'NOTICES.json missing'
  for (const crate of manifest.crates) {
    if (crate.name === VOICE_PACK_NAME.replace('-', '_')) continue
    // A crate's licence text rides as a directory of its LICENSE* files, or
    // as one note naming the declared licence when the crate ships none.
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

/** Every crate linked into the host build (cargo metadata, host-filtered). */
function linkedCrates(): CargoPackage[] {
  const host = run('rustc', ['-vV'], { capture: true })
  const triple = /host:\s*(\S+)/.exec(host.stdout)?.[1]
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
  const artifact = join(TARGET_DIR, 'release', cargoArtifactName())
  if (!existsSync(artifact)) fail(`cargo reported success but ${artifact} is absent`)
  const tmp = `${OUT_DIR}.tmp-${process.pid}`
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(join(tmp, 'licenses'), { recursive: true })
  copyFileSync(artifact, join(tmp, VOICE_ADDON_FILE))
  const crates: VoicePackCrate[] = []
  const notices: Array<{ name: string; version: string; license: string; repository: string | null; licenseFiles: string[] }> = []
  for (const pkg of linkedCrates()) {
    const own = pkg.name === 'mercury_voice'
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
        // The crate ships no licence text (a permissive-licence crate with
        // only its Cargo.toml `license` field): the inventory row is the
        // record; an empty directory would be a false claim.
        rmSync(dest, { recursive: true, force: true })
        writeFileSync(join(tmp, 'licenses', `${pkg.name}-${pkg.version}.txt`), `${pkg.name} ${pkg.version}: ${license} (no licence file in the crate; see ${pkg.repository ?? 'the crate registry'})\n`)
      }
    }
    notices.push({ name: pkg.name, version: pkg.version, license, repository: pkg.repository, licenseFiles: files })
  }
  writeFileSync(join(tmp, 'NOTICES.json'), JSON.stringify({ pack: VOICE_PACK_NAME, platform: PLATFORM, crates: notices }, null, 2) + '\n')
  const crateVersion = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(MANIFEST_PATH, 'utf8'))?.[1] ?? '0.0.0'
  const tree = voicePackTreeDigest(tmp)
  const manifest: VoicePackManifest = {
    name: VOICE_PACK_NAME,
    version: crateVersion,
    platform: PLATFORM,
    addon: VOICE_ADDON_FILE,
    addonSha256: sha256(readFileSync(join(tmp, VOICE_ADDON_FILE))),
    sourceTreeDigest: voiceSourceTreeDigest(NATIVE_DIR),
    cargo,
    crates,
    fileCount: tree.fileCount,
    treeDigest: tree.treeDigest,
  }
  writeFileSync(join(tmp, VOICE_PACK_MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n')
  rmSync(OUT_DIR, { recursive: true, force: true })
  mkdirSync(dirname(OUT_DIR), { recursive: true })
  renameSync(tmp, OUT_DIR)
  console.log(`build-voice: installed ${VOICE_ADDON_FILE} + ${crates.length} crate licences → ${VOICE_PACK_PATH}/${PLATFORM} (treeDigest ${manifest.treeDigest.slice(0, 12)}…)`)
}

function main(): void {
  if (checkOnly) {
    const invalid = packInvalidReason()
    if (invalid === null) {
      const manifest = readVoicePackManifest(OUT_DIR)
      console.log(`build-voice --check: OK — ${VOICE_PACK_NAME} ${manifest?.version ?? '?'} ${PLATFORM} pack valid against ${VOICE_NATIVE_PATH}`)
      process.exit(0)
    }
    console.error(`build-voice --check: STALE — ${PLATFORM}: ${invalid}`)
    console.error('  remedy: bun run scripts/vendor/build-voice.ts (cargo build --release, then the pack install)')
    process.exit(2)
  }
  if (!existsSync(MANIFEST_PATH)) fail(`${VOICE_NATIVE_PATH}/Cargo.toml is absent — nothing to build`)
  const invalid = packInvalidReason()
  if (invalid === null && !force) {
    console.log(`build-voice: pack already valid for ${PLATFORM} — nothing to do (--force rebuilds)`)
    process.exit(0)
  }
  const cargo = cargoVersion()
  if (cargo === null) {
    console.log(
      `build-voice: SKIPPED — no cargo on PATH, so the voice capture pack is not built for ${PLATFORM}. ` +
        'The build ships without voice input (degraded: voice-input) and the doctor says so; install a Rust toolchain (https://rustup.rs) and re-run bun run scripts/vendor/build-voice.ts, or put sox/ffmpeg on PATH for the recorder fallback.',
    )
    process.exit(0)
  }
  if (invalid !== null && existsSync(OUT_DIR)) console.log(`build-voice: rebuilding — ${invalid}`)
  console.log(`build-voice: ${cargo} — cargo build --release (${VOICE_NATIVE_PATH}, ${PLATFORM})`)
  const build = run('cargo', ['build', '--release', '--manifest-path', MANIFEST_PATH, '--target-dir', TARGET_DIR])
  if (build.error) fail(`cargo could not be started: ${build.error.message}`)
  if (build.status !== 0) {
    fail(
      `cargo build failed (exit ${String(build.status)}) — the voice capture pack is not installed; the build ships without voice input (degraded: voice-input). ` +
        (process.platform === 'linux' ? 'On Linux the audio layer needs the ALSA headers (Debian/Ubuntu: apt-get install libasound2-dev). ' : '') +
        'Fix the reported error and re-run bun run scripts/vendor/build-voice.ts',
    )
  }
  installPack(cargo)
  const post = packInvalidReason()
  if (post !== null) fail(`post-install validation failed for ${PLATFORM}: ${post}`)
  const size = statSync(join(OUT_DIR, VOICE_ADDON_FILE)).size
  console.log(`build-voice: DONE — ${VOICE_PACK_NAME} ${PLATFORM} ready for the build (${size} bytes; bun run build.ts)`)
}

main()
