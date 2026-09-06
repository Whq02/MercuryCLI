#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { voiceCargoTriple, voicePackPlatform } from '../../src/services/voice/voicePack.ts'
import {
  WHISPER_ADDON_FILE,
  WHISPER_ENGINE_NAME,
  WHISPER_NATIVE_PATH,
  WHISPER_PACK_MANIFEST_FILE,
  WHISPER_PACK_NAME,
  WHISPER_PACK_PATH,
  checkWhisperPackDir,
  readWhisperPackManifest,
  whisperCpuFloorWords,
  whisperGpuFor,
  whisperPackDirFor,
  whisperPackTreeDigest,
  whisperSourceTreeDigest,
  type WhisperPackCrate,
  type WhisperPackManifest,
} from '../../src/services/voice/whisperPack.ts'
import { RELEASE_TARGETS, buildPlatformOf, isReleaseTarget } from '../../src/services/privateChannel/releaseTarget.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const NATIVE_DIR = join(ROOT, 'native', 'whisper')
const MANIFEST_PATH = join(NATIVE_DIR, 'Cargo.toml')
const TARGET_DIR = join(NATIVE_DIR, 'target')

const argv = process.argv.slice(2)
const checkOnly = argv.includes('--check')
const force = argv.includes('--force')

function fail(msg: string): never {
  console.error(`build-whisper: ${msg}`)
  process.exit(1)
}

const targetAt = argv.indexOf('--target')
const TARGET_ARG = targetAt === -1 ? null : (argv[targetAt + 1] ?? '')
if (TARGET_ARG !== null && !isReleaseTarget(TARGET_ARG)) fail(`--target wants one of ${RELEASE_TARGETS.join(', ')} (got ${TARGET_ARG || 'nothing'})`)
const SHIP = TARGET_ARG === null ? { platform: process.platform, arch: process.arch } : buildPlatformOf(TARGET_ARG)
const PLATFORM = voicePackPlatform(SHIP.platform, SHIP.arch)
const CROSS = PLATFORM !== voicePackPlatform()
const TRIPLE = voiceCargoTriple(PLATFORM)
const OUT_DIR = whisperPackDirFor(ROOT, PLATFORM)
const DEGRADED = 'degraded: on-device-transcriber'

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')

function cargoArtifactName(): string {
  if (SHIP.platform === 'win32') return 'mercury_whisper.dll'
  if (SHIP.platform === 'darwin') return 'libmercury_whisper.dylib'
  return 'libmercury_whisper.so'
}

function kernelFloorEnv(): Record<string, string> {
  const base: Record<string, string> = { GGML_NATIVE: 'OFF', GGML_OPENMP: 'OFF' }
  if (SHIP.arch === 'x64') {
    return { ...base, GGML_AVX: 'ON', GGML_AVX2: 'ON', GGML_FMA: 'ON', GGML_F16C: 'ON', GGML_AVX512: 'OFF', GGML_AVX_VNNI: 'OFF', GGML_AMX_TILE: 'OFF' }
  }
  return base
}

function run(cmd: string, args: string[], opts: { capture?: boolean; env?: Record<string, string> } = {}): { status: number | null; stdout: string; stderr: string; error?: Error } {
  const res = spawnSync(cmd, args, {
    cwd: NATIVE_DIR,
    env: { ...process.env, CARGO_TERM_COLOR: 'never', ...(opts.env ?? {}) },
    encoding: 'utf8',
    stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', ...(res.error ? { error: res.error } : {}) }
}

function toolVersion(cmd: string, args: string[] = ['--version']): string | null {
  const res = run(cmd, args, { capture: true })
  if (res.error || res.status !== 0) return null
  return res.stdout.trim().split('\n')[0] ?? ''
}

function cmakeRemedy(): string {
  if (process.platform === 'darwin') return 'brew install cmake'
  if (process.platform === 'win32') return 'winget install Kitware.CMake'
  return 'apt-get install cmake (or your package manager)'
}

function hasLibclang(): boolean {
  const named = process.env.LIBCLANG_PATH
  if (named !== undefined && named !== '' && existsSync(named)) return true
  const candidates: string[] = []
  if (process.platform === 'darwin') {
    candidates.push('/Library/Developer/CommandLineTools/usr/lib/libclang.dylib', '/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/libclang.dylib', '/opt/homebrew/opt/llvm/lib/libclang.dylib', '/usr/local/opt/llvm/lib/libclang.dylib')
  } else if (process.platform === 'win32') {
    candidates.push('C:\\Program Files\\LLVM\\bin\\libclang.dll')
  } else {
    for (const dir of ['/usr/lib', '/usr/lib64', '/usr/lib/x86_64-linux-gnu', '/usr/lib/aarch64-linux-gnu', '/usr/local/lib']) {
      try {
        for (const name of readdirSync(dir)) if (/^libclang(-\d+(\.\d+)*)?\.so(\.\d+)*$/.test(name)) candidates.push(join(dir, name))
      } catch {
      }
    }
    try {
      for (const name of readdirSync('/usr/lib')) {
        if (/^llvm-\d+$/.test(name)) {
          try {
            for (const lib of readdirSync(join('/usr/lib', name, 'lib'))) if (/^libclang.*\.so/.test(lib)) candidates.push(join('/usr/lib', name, 'lib', lib))
          } catch {
          }
        }
      }
    } catch {
    }
  }
  return candidates.some(c => existsSync(c))
}

function packInvalidReason(): string | null {
  const check = checkWhisperPackDir(OUT_DIR, { digest: true, platform: PLATFORM })
  if (check.state !== 'ok') return check.note
  const manifest = check.manifest
  if (!existsSync(NATIVE_DIR)) return `${WHISPER_NATIVE_PATH} is absent — nothing to compare the pack against`
  const sourceDigest = whisperSourceTreeDigest(NATIVE_DIR)
  if (manifest.sourceTreeDigest !== sourceDigest) return `the pack was built from another source tree (${manifest.sourceTreeDigest.slice(0, 12)}…, sources now ${sourceDigest.slice(0, 12)}…)`
  const tree = whisperPackTreeDigest(OUT_DIR)
  if (tree.fileCount !== manifest.fileCount) return `file count drifted: ${tree.fileCount} on disk vs ${manifest.fileCount} in the manifest`
  if (tree.treeDigest !== manifest.treeDigest) return 'treeDigest mismatch (pack content drifted)'
  if (!existsSync(join(OUT_DIR, 'NOTICES.json'))) return 'NOTICES.json missing'
  if (!existsSync(join(OUT_DIR, 'licenses', `${WHISPER_ENGINE_NAME}-${manifest.engine.version}`, 'LICENSE'))) return `licence record missing for ${WHISPER_ENGINE_NAME} ${manifest.engine.version}`
  for (const crate of manifest.crates) {
    if (crate.name === WHISPER_PACK_NAME.replace('-', '_')) continue
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

function graphCrates(): CargoPackage[] {
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

function engineFacts(crates: CargoPackage[]): { version: string; licensePath: string } {
  const sys = crates.find(c => c.name === 'whisper-rs-sys')
  if (!sys) fail('whisper-rs-sys is not in the build graph — the manifest no longer links whisper.cpp')
  const root = join(dirname(sys.manifest_path), 'whisper.cpp')
  const cmake = join(root, 'CMakeLists.txt')
  if (!existsSync(cmake)) fail(`${cmake} is absent — the sys crate carries no whisper.cpp sources`)
  const version = /project\("whisper\.cpp" VERSION ([^)]+)\)/.exec(readFileSync(cmake, 'utf8'))?.[1]?.trim()
  if (!version) fail(`${cmake} declares no whisper.cpp version`)
  const licensePath = join(root, 'LICENSE')
  if (!existsSync(licensePath)) fail(`${licensePath} is absent — the engine's licence must ship beside the addon`)
  return { version, licensePath }
}

const LICENSE_FILE = /^(LICENSE|LICENCE|COPYING|NOTICE)([-._].*)?$/i

function installPack(cargo: string): void {
  const artifact = join(TARGET_DIR, ...(CROSS && TRIPLE ? [TRIPLE] : []), 'release', cargoArtifactName())
  if (!existsSync(artifact)) fail(`cargo reported success but ${artifact} is absent`)
  const tmp = `${OUT_DIR}.tmp-${process.pid}`
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(join(tmp, 'licenses'), { recursive: true })
  copyFileSync(artifact, join(tmp, WHISPER_ADDON_FILE))
  const graph = graphCrates()
  const engine = engineFacts(graph)
  const crates: WhisperPackCrate[] = []
  const notices: Array<{ name: string; version: string; license: string; repository: string | null; licenseFiles: string[] }> = []
  for (const pkg of graph) {
    const own = pkg.name === 'mercury_whisper'
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
  const engineDir = join(tmp, 'licenses', `${WHISPER_ENGINE_NAME}-${engine.version}`)
  mkdirSync(engineDir, { recursive: true })
  copyFileSync(engine.licensePath, join(engineDir, 'LICENSE'))
  const engineRecord = { name: WHISPER_ENGINE_NAME, version: engine.version, license: 'MIT', repository: 'https://github.com/ggml-org/whisper.cpp', licenseFiles: ['LICENSE'] }
  writeFileSync(join(tmp, 'NOTICES.json'), JSON.stringify({ pack: WHISPER_PACK_NAME, platform: PLATFORM, engine: engineRecord, cpuFloor: whisperCpuFloorWords(SHIP.arch), gpu: whisperGpuFor(SHIP.platform, SHIP.arch), crates: notices }, null, 2) + '\n')
  const crateVersion = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(MANIFEST_PATH, 'utf8'))?.[1] ?? '0.0.0'
  const tree = whisperPackTreeDigest(tmp)
  const manifest: WhisperPackManifest = {
    name: WHISPER_PACK_NAME,
    version: crateVersion,
    platform: PLATFORM,
    addon: WHISPER_ADDON_FILE,
    addonSha256: sha256(readFileSync(join(tmp, WHISPER_ADDON_FILE))),
    sourceTreeDigest: whisperSourceTreeDigest(NATIVE_DIR),
    cargo,
    engine: { name: WHISPER_ENGINE_NAME, version: engine.version },
    cpuFloor: whisperCpuFloorWords(SHIP.arch),
    gpu: whisperGpuFor(SHIP.platform, SHIP.arch),
    crates,
    fileCount: tree.fileCount,
    treeDigest: tree.treeDigest,
  }
  writeFileSync(join(tmp, WHISPER_PACK_MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n')
  rmSync(OUT_DIR, { recursive: true, force: true })
  mkdirSync(dirname(OUT_DIR), { recursive: true })
  renameSync(tmp, OUT_DIR)
  console.log(`build-whisper: installed ${WHISPER_ADDON_FILE} + ${crates.length} crate licences + ${WHISPER_ENGINE_NAME} ${engine.version} → ${WHISPER_PACK_PATH}/${PLATFORM} (treeDigest ${manifest.treeDigest.slice(0, 12)}…)`)
}

function main(): void {
  if (checkOnly) {
    const invalid = packInvalidReason()
    if (invalid === null) {
      const manifest = readWhisperPackManifest(OUT_DIR)
      console.log(`build-whisper --check: OK — ${WHISPER_PACK_NAME} ${manifest?.version ?? '?'} ${PLATFORM} pack valid against ${WHISPER_NATIVE_PATH} (${WHISPER_ENGINE_NAME} ${manifest?.engine.version ?? '?'})`)
      process.exit(0)
    }
    console.error(`build-whisper --check: STALE — ${PLATFORM}: ${invalid}`)
    console.error('  remedy: bun run scripts/vendor/build-whisper.ts (cargo build --release, then the pack install)')
    process.exit(2)
  }
  if (!existsSync(MANIFEST_PATH)) fail(`${WHISPER_NATIVE_PATH}/Cargo.toml is absent — nothing to build`)
  const invalid = packInvalidReason()
  if (invalid === null && !force) {
    console.log(`build-whisper: pack already valid for ${PLATFORM} — nothing to do (--force rebuilds)`)
    process.exit(0)
  }
  const dropStale = (): void => {
    if (invalid !== null && existsSync(OUT_DIR)) {
      rmSync(OUT_DIR, { recursive: true, force: true })
      console.log(`build-whisper: removed the stale pack at ${WHISPER_PACK_PATH}/${PLATFORM} (${invalid}) — it cannot be rebuilt here`)
    }
  }
  const cargo = toolVersion('cargo')
  if (cargo === null) {
    dropStale()
    console.log(
      `build-whisper: SKIPPED — no cargo on PATH, so the on-device transcriber pack is not built for ${PLATFORM}. ` +
        `The build ships without it (${DEGRADED}) and the doctor says so; install a Rust toolchain (https://rustup.rs) and cmake, and re-run bun run scripts/vendor/build-whisper.ts — the cloud transcribers serve meanwhile.`,
    )
    process.exit(0)
  }
  const cmake = toolVersion('cmake')
  if (cmake === null) {
    dropStale()
    console.log(
      `build-whisper: SKIPPED — no cmake on PATH (whisper.cpp compiles through it), so the on-device transcriber pack is not built for ${PLATFORM}. ` +
        `The build ships without it (${DEGRADED}) and the doctor says so; install cmake (${cmakeRemedy()}) and re-run bun run scripts/vendor/build-whisper.ts — the cloud transcribers serve meanwhile.`,
    )
    process.exit(0)
  }
  if (CROSS) {
    if (TRIPLE === null) {
      dropStale()
      console.log(`build-whisper: SKIPPED — no cargo target triple is known for ${PLATFORM}; the build ships without the on-device transcriber (${DEGRADED}) and the doctor says so.`)
      process.exit(0)
    }
    const installed = run('rustup', ['target', 'list', '--installed'], { capture: true })
    const present = installed.status === 0 && installed.stdout.split('\n').map(l => l.trim()).includes(TRIPLE)
    if (!present) {
      dropStale()
      console.log(
        `build-whisper: SKIPPED — the rustup target ${TRIPLE} is not installed on this machine, so the on-device transcriber pack is not cross-compiled for ${PLATFORM}. ` +
          `The build ships without it (${DEGRADED}) and the doctor says so; install it (rustup target add ${TRIPLE}) and re-run bun run scripts/vendor/build-whisper.ts --target ${TARGET_ARG}.`,
      )
      process.exit(0)
    }
  }
  if (invalid !== null && existsSync(OUT_DIR)) console.log(`build-whisper: rebuilding — ${invalid}`)
  const floor = kernelFloorEnv()
  const bindings = hasLibclang() ? {} : { WHISPER_DONT_GENERATE_BINDINGS: '1' }
  if ('WHISPER_DONT_GENERATE_BINDINGS' in bindings) console.log('build-whisper: no libclang found — whisper-rs uses its bundled bindings')
  console.log(`build-whisper: ${cargo} · ${cmake} — cargo build --release (${WHISPER_NATIVE_PATH}, ${PLATFORM}${CROSS ? `, --target ${TRIPLE}` : ''}; ${Object.entries(floor).map(([k, v]) => `${k}=${v}`).join(' ')})`)
  const build = run('cargo', ['build', '--release', '--manifest-path', MANIFEST_PATH, '--target-dir', TARGET_DIR, ...(CROSS && TRIPLE ? ['--target', TRIPLE] : [])], { env: { ...floor, ...bindings } })
  if (build.error) fail(`cargo could not be started: ${build.error.message}`)
  if (build.status !== 0) {
    fail(
      `cargo build failed (exit ${String(build.status)}) — the on-device transcriber pack is not installed; the build ships without it (${DEGRADED}). ` +
        'whisper.cpp needs a C++ compiler cmake can find (Xcode command-line tools · build-essential · the MSVC toolchain). ' +
        'Fix the reported error and re-run bun run scripts/vendor/build-whisper.ts',
    )
  }
  installPack(cargo)
  const post = packInvalidReason()
  if (post !== null) fail(`post-install validation failed for ${PLATFORM}: ${post}`)
  const size = statSync(join(OUT_DIR, WHISPER_ADDON_FILE)).size
  console.log(`build-whisper: DONE — ${WHISPER_PACK_NAME} ${PLATFORM} ready for the build (${size} bytes; bun run build.ts)`)
}

main()
