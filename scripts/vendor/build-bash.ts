#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { availableParallelism, release } from 'node:os'
import { join, resolve } from 'node:path'
import { extractTarGz } from './tarExtract.ts'
import {
  BASH_PACK_BINARY,
  BASH_PACK_MANIFEST_FILE,
  BASH_PACK_NAME,
  BASH_PACK_PATH,
  BASH_PACK_PLATFORMS,
  bashPackIsFetched,
  bashPackPlatform,
  bashPackTreeDigest,
  bashPatchesDigest,
  checkBashPackDir,
  type BashPackManifest,
  type BashPackPlatform,
} from '../../src/platform/shell/bashPack.ts'
import { RELEASE_TARGETS, buildPlatformOf, isReleaseTarget } from '../../src/platform/update-channel/releaseTarget.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const LOCK_PATH = join(ROOT, 'vendor', 'bash.lock.json')
const PACK_ROOT = join(ROOT, ...BASH_PACK_PATH.split('/'))
const ARCHIVE_DIR = join(PACK_ROOT, 'archive')
const DOWNLOAD_TRIES = 3
const DOWNLOAD_LIMIT_MS = 300_000

interface PinnedFile {
  file: string
  url: string
  sha256: string
}
interface LockPlatform {
  kind?: string
  target: string
  deploymentTarget?: string
  docker?: string
  configure: string[]
}
interface Lock {
  name: string
  version: string
  release: string
  patchLevel: number
  license: string
  licenseFiles: string[]
  sourceNote: string
  pinsVerifiedWith: { key: string; on: string; how: string }
  tarball: PinnedFile
  patches: PinnedFile[]
  build: { cflags: string; configure: string[]; make: string[] }
  platforms: Record<string, LockPlatform>
  linuxBuilder: {
    image: string
    release: string
    packages: string[]
    libc: { name: string; version: string; license: string; licenseFile: string; tarball: PinnedFile & { member: string } }
  }
}

const argv = process.argv.slice(2)
const checkOnly = argv.includes('--check')
const force = argv.includes('--force')
const all = argv.includes('--all')

function fail(msg: string): never {
  console.error(`build-bash: ${msg}`)
  process.exit(1)
}

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')
const HEX64 = /^[0-9a-f]{64}$/

function readLock(): Lock {
  if (!existsSync(LOCK_PATH)) fail(`lock file missing: ${LOCK_PATH}`)
  const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8')) as Lock
  if (lock.name !== BASH_PACK_NAME) fail(`lock names ${String(lock.name)}, not ${BASH_PACK_NAME}`)
  for (const key of ['version', 'release', 'license', 'sourceNote'] as const) {
    if (!lock[key]) fail(`lock is missing '${key}'`)
  }
  if (!lock.pinsVerifiedWith?.key || !lock.pinsVerifiedWith.on) fail("lock is missing 'pinsVerifiedWith' (the key the pins were verified with by hand, and the day)")
  if (!Array.isArray(lock.licenseFiles) || lock.licenseFiles.length === 0) fail('lock names no licence files')
  if (!Array.isArray(lock.patches) || lock.patches.length !== lock.patchLevel) fail(`lock names ${lock.patches?.length ?? 0} patches for patch level ${String(lock.patchLevel)}`)
  if (lock.version !== `${lock.release}.${lock.patchLevel}`) fail(`lock version ${lock.version} is not release ${lock.release} at patch level ${lock.patchLevel}`)
  for (const pinned of [lock.tarball, ...lock.patches, lock.linuxBuilder.libc.tarball]) {
    if (!pinned.file || !pinned.url.startsWith('https://') || !pinned.url.endsWith(`/${pinned.file}`)) fail(`lock entry ${String(pinned.file)} lacks a file name or an https url that ends in it`)
    if (!HEX64.test(pinned.sha256)) fail(`lock entry ${pinned.file} sha256 is not a 64-hex digest`)
  }
  lock.patches.forEach((patch, index) => {
    const expected = `bash${lock.release.replace('.', '')}-${String(index + 1).padStart(3, '0')}`
    if (patch.file !== expected) fail(`lock patch ${index + 1} is ${patch.file}; the official patches apply in order and this one must be ${expected}`)
  })
  for (const platform of Object.keys(lock.platforms)) {
    if (!(BASH_PACK_PLATFORMS as readonly string[]).includes(platform)) fail(`lock entry ${platform} is not a pack platform`)
  }
  if (!/^[a-z0-9./-]+@sha256:[0-9a-f]{64}$/.test(lock.linuxBuilder.image)) fail('the lock pins the Linux builder image by name@sha256:digest')
  return lock
}

function selectPlatforms(lock: Lock): BashPackPlatform[] {
  const known = (Object.keys(lock.platforms) as BashPackPlatform[]).filter(platform => !bashPackIsFetched(platform))
  const fetched = (platform: string | null): platform is string => platform !== null && bashPackIsFetched(platform) && lock.platforms[platform] !== undefined
  if (all) return known
  const at = argv.indexOf('--target')
  if (at !== -1) {
    const value = argv[at + 1] ?? ''
    if (!isReleaseTarget(value)) fail(`--target wants one of ${RELEASE_TARGETS.join(', ')} (got ${value || 'nothing'})`)
    const ship = buildPlatformOf(value)
    const platform = bashPackPlatform(ship.platform, ship.arch)
    if (platform === null || !known.includes(platform)) {
      console.log(fetched(platform) ? `build-bash: the bash pack for ${value} is fetched, not built (bun run scripts/vendor/fetch-bash-win.ts --target ${value}) — nothing to build` : `build-bash: no bash pack is built for ${value} here — nothing to build`)
      process.exit(0)
    }
    return [platform]
  }
  const named = argv.indexOf('--platform')
  if (named !== -1) {
    const value = argv[named + 1] ?? ''
    const platform = known.find(candidate => candidate === value)
    if (platform === undefined) fail(fetched(value) ? `--platform ${value} is fetched, not built: bun run scripts/vendor/fetch-bash-win.ts --platform ${value}` : `--platform wants one of ${known.join(', ')} (got ${value || 'nothing'})`)
    return [platform]
  }
  const host = bashPackPlatform()
  if (host === null || !known.includes(host)) {
    console.log(fetched(host) ? `build-bash: the bash pack for ${host} is fetched, not built (bun run scripts/vendor/fetch-bash-win.ts) — nothing to build` : `build-bash: no bash pack layout exists for ${process.platform}/${process.arch} — nothing to build`)
    process.exit(0)
  }
  return [host]
}

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; log?: string } = {}): { status: number | null; stdout: string; error?: Error } {
  const logFd = opts.log === undefined ? null : openSync(opts.log, 'a')
  try {
    const res = spawnSync(cmd, args, {
      cwd: opts.cwd ?? ROOT,
      env: opts.env ?? process.env,
      encoding: 'utf8',
      stdio: logFd === null ? ['ignore', 'pipe', 'pipe'] : ['ignore', logFd, logFd],
      maxBuffer: 64 * 1024 * 1024,
    })
    return { status: res.status, stdout: typeof res.stdout === 'string' ? res.stdout : '', ...(res.error ? { error: res.error } : {}) }
  } finally {
    if (logFd !== null) closeSync(logFd)
  }
}

const works = (cmd: string, args: string[]): boolean => {
  const res = run(cmd, args)
  return res.error === undefined && res.status === 0
}

function packDirFor(platform: string): string {
  return join(PACK_ROOT, platform)
}

function configureArgs(lock: Lock, platform: BashPackPlatform): string[] {
  return [...lock.build.configure, ...lock.platforms[platform]!.configure]
}

function packInvalidReason(lock: Lock, platform: BashPackPlatform): string | null {
  const dir = packDirFor(platform)
  const check = checkBashPackDir(dir, { digest: true, platform })
  if (check.state !== 'ok') return check.note
  const manifest = check.manifest
  if (manifest.source !== 'gnu-tarball') return `the pack is ${manifest.source}, not a build from the GNU tarball`
  if (manifest.version !== lock.version || manifest.patchLevel !== lock.patchLevel) return `the pack is ${manifest.version}, the lock pins ${lock.version}`
  if (manifest.tarballSha256 !== lock.tarball.sha256) return "the pack's tarball digest is not the lock's"
  if (manifest.patchesSha256 !== bashPatchesDigest(lock.patches)) return "the pack's patch set is not the lock's"
  if (manifest.target !== lock.platforms[platform]!.target) return `the pack's target ${manifest.target} is not the lock's ${lock.platforms[platform]!.target}`
  if (JSON.stringify(manifest.configure) !== JSON.stringify(configureArgs(lock, platform))) return "the pack was configured with other flags than the lock's"
  for (const file of expectedLicenceFiles(lock, platform)) {
    if (!manifest.licenseFiles.includes(file) || !existsSync(join(dir, file))) return `licence file missing: ${file}`
  }
  if (manifest.sourceNote !== lock.sourceNote) return `the pack's source note is ${manifest.sourceNote}, the lock names ${lock.sourceNote}`
  const tree = bashPackTreeDigest(dir)
  if (tree.fileCount !== manifest.fileCount) return `file count drifted: ${tree.fileCount} on disk vs ${manifest.fileCount} in the manifest`
  if (tree.treeDigest !== manifest.treeDigest) return 'treeDigest mismatch (pack content drifted)'
  return null
}

function expectedLicenceFiles(lock: Lock, platform: BashPackPlatform): string[] {
  return platform.startsWith('linux-') ? [...lock.licenseFiles, lock.linuxBuilder.libc.licenseFile] : [...lock.licenseFiles]
}

async function secure(pinned: PinnedFile): Promise<string> {
  mkdirSync(ARCHIVE_DIR, { recursive: true })
  const path = join(ARCHIVE_DIR, pinned.file)
  if (existsSync(path) && sha256(readFileSync(path)) === pinned.sha256) return path
  console.log(`build-bash: downloading ${pinned.url}`)
  const bytes = await download(pinned)
  const digest = sha256(bytes)
  if (digest !== pinned.sha256) fail(`sha256 mismatch for ${pinned.file}: got ${digest.slice(0, 24)}…, lock pins ${pinned.sha256.slice(0, 24)}… — refusing (the source changed)`)
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, bytes)
  renameSync(tmp, path)
  return path
}

async function download(pinned: PinnedFile): Promise<Buffer> {
  let fault = ''
  for (let attempt = 1; attempt <= DOWNLOAD_TRIES; attempt++) {
    try {
      const res = await fetch(pinned.url, { signal: AbortSignal.timeout(DOWNLOAD_LIMIT_MS) })
      if (res.ok) return Buffer.from(await res.arrayBuffer())
      fault = `HTTP ${res.status} ${res.statusText}`
    } catch (error) {
      fault = error instanceof Error ? error.message : String(error)
    }
    if (attempt < DOWNLOAD_TRIES) console.log(`build-bash: ${pinned.file} did not arrive (${fault}); try ${attempt + 1} of ${DOWNLOAD_TRIES}`)
  }
  fail(`download failed for ${pinned.file} after ${DOWNLOAD_TRIES} tries: ${fault}`)
}

function skipReason(lock: Lock, platform: BashPackPlatform): string | null {
  const rerun = `bun run scripts/vendor/build-bash.ts${platform === bashPackPlatform() ? '' : ` --target ${releaseTargetOf(platform)}`}`
  const tail = `The build ships without the shipped bash (degraded: shell-bash; the Bash tool runs the system's bash, then the bundled engine) and says so; re-run ${rerun}`
  if (!works('patch', ['--version'])) return `no patch on PATH, so the official patches cannot be applied. ${tail} once it is installed.`
  if (platform.startsWith('linux-')) {
    if (!works('docker', ['version', '--format', '{{.Server.Version}}'])) return `no docker daemon answers, and the ${platform} pack is a static build inside the pinned ${lock.linuxBuilder.image.split('@')[0]} image. ${tail} with docker running.`
    return null
  }
  if (process.platform !== 'darwin') return `the ${platform} pack is built on a Mac with the Xcode command line tools. ${tail} there.`
  if (!works('/usr/bin/xcrun', ['--find', 'clang']) || !works('/usr/bin/make', ['--version'])) return `the Xcode command line tools are absent (xcode-select --install). ${tail} once they are installed.`
  if (platform === 'darwin-x64' && process.arch !== 'x64' && !works('/usr/bin/arch', ['-x86_64', '/usr/bin/true'])) return `Rosetta 2 is absent, and on an Apple-silicon Mac configure runs the x86_64 programs it compiles (softwareupdate --install-rosetta). ${tail} once it is installed.`
  if (platform === 'darwin-arm64' && process.arch !== 'arm64') return `the darwin-arm64 pack is built on an Apple-silicon Mac. ${tail} there.`
  return null
}

function releaseTargetOf(platform: BashPackPlatform): string {
  return platform.replace('darwin-', 'macos-')
}

function elfIsStatic(path: string): boolean {
  const bytes = readFileSync(path)
  if (bytes.length < 64 || bytes.readUInt32BE(0) !== 0x7f454c46 || bytes[4] !== 2 || bytes[5] !== 1) return false
  const phoff = Number(bytes.readBigUInt64LE(0x20))
  const phentsize = bytes.readUInt16LE(0x36)
  const phnum = bytes.readUInt16LE(0x38)
  for (let i = 0; i < phnum; i++) {
    if (bytes.readUInt32LE(phoff + i * phentsize) === 3) return false
  }
  return true
}

type Built = { binary: string; bashVersion: string; toolchain: string; links: string[] }

function buildDarwin(lock: Lock, platform: BashPackPlatform, source: string, work: string): Built {
  const entry = lock.platforms[platform]!
  const env: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: work,
    LC_ALL: 'C',
    CFLAGS: lock.build.cflags,
    MACOSX_DEPLOYMENT_TARGET: entry.deploymentTarget ?? '',
  }
  const triple = platform === 'darwin-x64' && process.arch !== 'x64' ? `x86_64-apple-darwin${release()}` : null
  if (triple !== null) env.CC = '/usr/bin/cc -arch x86_64'
  const step = (label: string, cmd: string[], log: string): void => {
    const res = run(cmd[0]!, cmd.slice(1), { cwd: source, env, log })
    if (res.error || res.status !== 0) fail(`${label} failed for ${platform} (exit ${String(res.status)}); its output is in ${log}`)
  }
  step('configure', ['/bin/sh', './configure', ...(triple === null ? [] : [`--build=${triple}`, `--host=${triple}`]), ...configureArgs(lock, platform)], join(work, 'configure.log'))
  step('make', ['/usr/bin/make', `-j${availableParallelism()}`, ...lock.build.make], join(work, 'make.log'))
  const binary = join(source, BASH_PACK_BINARY)
  if (!existsSync(binary)) fail(`make left no ${BASH_PACK_BINARY} for ${platform}`)
  const libraries = run('/usr/bin/otool', ['-L', binary], { env }).stdout.split('\n').slice(1).map(line => line.trim().split(' (')[0] ?? '').filter(line => line !== '')
  const outside = libraries.filter(library => !library.startsWith('/usr/lib/'))
  if (libraries.length === 0 || outside.length > 0) fail(`the ${platform} binary links outside the operating system: ${outside.join(', ') || 'otool named no library'}`)
  const weak = run('/usr/bin/nm', ['-m', binary], { env }).stdout.split('\n').filter(line => line.includes('weak external')).map(line => line.trim().split(' ').find(word => word.startsWith('_')) ?? line.trim())
  if (weak.length > 0) fail(`the ${platform} binary imports ${weak.join(', ')}, newer than macOS ${entry.deploymentTarget}: hold each back in the platform's configure list in vendor/bash.lock.json (ac_cv_func_<name>=no, and any second check ${join(source, 'config.log')} names for it)`)
  const version = run(binary, ['--norc', '--noprofile', '-c', 'printf %s "$BASH_VERSION"'], { env })
  const compiler = run('/usr/bin/cc', ['--version'], { env }).stdout.split('\n')[0] ?? ''
  const sdk = run('/usr/bin/xcrun', ['--show-sdk-version'], { env }).stdout.trim()
  return { binary, bashVersion: version.stdout, toolchain: `${compiler}${triple === null ? '' : ` with -arch x86_64, configured as ${triple} on an Apple-silicon host`}; macOS SDK ${sdk}; deployment target ${entry.deploymentTarget}`, links: libraries }
}

function buildLinux(lock: Lock, platform: BashPackPlatform, work: string): Built {
  const entry = lock.platforms[platform]!
  const quoted = (words: string[]): string => words.map(word => `'${word.replace(/'/g, `'\\''`)}'`).join(' ')
  const owner = typeof process.getuid === 'function' && typeof process.getgid === 'function' ? `${process.getuid()}:${process.getgid()}` : null
  const script = [
    'set -e',
    ...(owner === null ? [] : [`trap 'chown -R ${owner} /work' EXIT`]),
    `apk add --no-cache ${quoted(lock.linuxBuilder.packages)} > /work/apk.log 2>&1`,
    'cd /work/src',
    `CFLAGS=${quoted([lock.build.cflags])} ./configure ${quoted(configureArgs(lock, platform))} > /work/configure.log 2>&1`,
    `make -j"$(nproc)" ${quoted(lock.build.make)} > /work/make.log 2>&1`,
    `strip ./${BASH_PACK_BINARY}`,
    `./${BASH_PACK_BINARY} --norc --noprofile -c 'printf %s "$BASH_VERSION"' > /work/bash-version.txt`,
    `{ gcc --version | head -n 1; apk info -e -v ${lock.linuxBuilder.libc.name}-dev; } > /work/toolchain.txt`,
  ].join('\n')
  const res = run('docker', ['run', '--rm', '--platform', entry.docker ?? '', '-v', `${work}:/work`, lock.linuxBuilder.image, 'sh', '-c', script], { log: join(work, 'docker.log') })
  if (res.error || res.status !== 0) fail(`the container build failed for ${platform} (exit ${String(res.status)}); its output is in ${work} (apk.log, configure.log, make.log, docker.log)`)
  const binary = join(work, 'src', BASH_PACK_BINARY)
  if (!existsSync(binary)) fail(`make left no ${BASH_PACK_BINARY} for ${platform}`)
  if (!elfIsStatic(binary)) fail(`the ${platform} binary asks for a program interpreter: it is not a static build`)
  const toolchain = readFileSync(join(work, 'toolchain.txt'), 'utf8').trim().split('\n')
  const libc = toolchain[1] ?? ''
  if (!libc.startsWith(`${lock.linuxBuilder.libc.name}-dev-${lock.linuxBuilder.libc.version}-`)) fail(`the builder image links ${libc}; the lock names ${lock.linuxBuilder.libc.name} ${lock.linuxBuilder.libc.version}, whose licence text the pack carries`)
  return {
    binary,
    bashVersion: readFileSync(join(work, 'bash-version.txt'), 'utf8'),
    toolchain: `${toolchain[0] ?? ''}; ${libc}; ${lock.linuxBuilder.image}`,
    links: [`static: no program interpreter; ${lock.linuxBuilder.libc.name} ${lock.linuxBuilder.libc.version} inside the binary`],
  }
}

function sourceNote(lock: Lock, platform: BashPackPlatform, built: Built): string {
  const libc = lock.linuxBuilder.libc
  const lines = [
    `GNU bash ${lock.release}, patch level ${lock.patchLevel} (BASH_VERSION ${built.bashVersion}), built for ${platform}.`,
    `Licence: ${lock.license}. The licence text is the file COPYING beside this note.`,
    'Mercury starts this program as a separate process and links nothing of it.',
    '',
    'The corresponding source is the GNU release tarball with the official patches applied in order:',
    ...[lock.tarball, ...lock.patches].flatMap(pinned => [`  ${pinned.url}`, `    sha256 ${pinned.sha256}`]),
    `Each file is signed by the bash maintainer: the .sig beside it on the same server, key ${lock.pinsVerifiedWith.key}.`,
    '',
    'How this binary was built, by scripts/vendor/build-bash.ts from vendor/bash.lock.json of the Mercury source tree (https://github.com/Whq02/MercuryCLI):',
    `  CFLAGS=${lock.build.cflags} ./configure ${configureArgs(lock, platform).join(' ')}`,
    `  make ${lock.build.make.join(' ')}`,
    `  toolchain: ${built.toolchain}`,
    ...built.links.map(link => `  links: ${link}`),
  ]
  if (platform.startsWith('linux-')) {
    lines.push('', `The binary carries ${libc.name} ${libc.version} (${libc.license}); its licence text is ${libc.licenseFile} beside this note, from ${libc.tarball.url} (sha256 ${libc.tarball.sha256}).`)
  }
  return lines.join('\n') + '\n'
}

async function buildOne(lock: Lock, platform: BashPackPlatform): Promise<void> {
  const tarball = await secure(lock.tarball)
  const patches: string[] = []
  for (const patch of lock.patches) patches.push(await secure(patch))
  const libcTarball = platform.startsWith('linux-') ? await secure(lock.linuxBuilder.libc.tarball) : null

  const work = join(PACK_ROOT, `.build-${platform}-${process.pid}`)
  rmSync(work, { recursive: true, force: true })
  const source = join(work, 'src')
  mkdirSync(source, { recursive: true })
  const tar = extractTarGz({ tarballPath: tarball, destDir: source, stripComponents: 1 })
  if (!tar.ok) fail(`tar extraction failed: ${tar.message}`)
  for (const patch of patches) {
    const res = run('patch', ['-p0', '-s', '-i', patch], { cwd: source, log: join(work, 'patch.log') })
    if (res.error || res.status !== 0) fail(`${patch} did not apply (exit ${String(res.status)}); its output is in ${join(work, 'patch.log')}`)
  }
  console.log(`build-bash: ${lock.tarball.file} with ${patches.length} patches applied, building ${platform}`)

  const built = platform.startsWith('linux-') ? buildLinux(lock, platform, work) : buildDarwin(lock, platform, source, work)
  const expected = `${lock.version}(1)-release`
  if (built.bashVersion !== expected) fail(`the ${platform} binary says BASH_VERSION ${JSON.stringify(built.bashVersion)}; the lock pins ${expected}`)

  const dir = packDirFor(platform)
  const tmp = `${dir}.tmp-${process.pid}`
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  copyFileSync(built.binary, join(tmp, BASH_PACK_BINARY))
  chmodSync(join(tmp, BASH_PACK_BINARY), 0o755)
  for (const file of lock.licenseFiles) {
    if (!existsSync(join(source, file))) fail(`the tarball carries no ${file}`)
    copyFileSync(join(source, file), join(tmp, file))
  }
  if (libcTarball !== null) {
    const libc = lock.linuxBuilder.libc
    const text = spawnSync('tar', ['-xzOf', libcTarball, libc.tarball.member], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
    if (text.status !== 0 || text.stdout.trim() === '') fail(`${libc.tarball.file} carries no ${libc.tarball.member}`)
    writeFileSync(join(tmp, libc.licenseFile), text.stdout)
  }
  writeFileSync(join(tmp, lock.sourceNote), sourceNote(lock, platform, built))
  const tree = bashPackTreeDigest(tmp)
  const manifest: BashPackManifest = {
    name: BASH_PACK_NAME,
    source: 'gnu-tarball',
    version: lock.version,
    patchLevel: lock.patchLevel,
    bashVersion: built.bashVersion,
    platform,
    target: lock.platforms[platform]!.target,
    binary: BASH_PACK_BINARY,
    binarySha256: sha256(readFileSync(join(tmp, BASH_PACK_BINARY))),
    license: lock.license,
    licenseFiles: expectedLicenceFiles(lock, platform),
    sourceNote: lock.sourceNote,
    tarballSha256: lock.tarball.sha256,
    patchesSha256: bashPatchesDigest(lock.patches),
    configure: configureArgs(lock, platform),
    toolchain: built.toolchain,
    links: built.links,
    fileCount: tree.fileCount,
    treeDigest: tree.treeDigest,
  }
  writeFileSync(join(tmp, BASH_PACK_MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n')
  rmSync(dir, { recursive: true, force: true })
  renameSync(tmp, dir)
  rmSync(work, { recursive: true, force: true })
  const post = packInvalidReason(lock, platform)
  if (post !== null) fail(`post-install validation failed for ${platform}: ${post}`)
  console.log(`build-bash: DONE — ${BASH_PACK_NAME} ${built.bashVersion} ${platform} ready for the build (${statSync(join(dir, BASH_PACK_BINARY)).size} bytes; ${built.links.join(', ')}; bun run build.ts)`)
}

async function main(): Promise<void> {
  const lock = readLock()
  const platforms = selectPlatforms(lock)
  if (checkOnly) {
    let stale = 0
    for (const platform of platforms) {
      const invalid = packInvalidReason(lock, platform)
      if (invalid === null) console.log(`build-bash --check: OK — ${BASH_PACK_NAME} ${lock.version} ${platform} pack valid against the lock's digests (the tarball and ${lock.patches.length} patches by sha256, the flags, the binary's own sha256); no signature is checked: the key in the lock is a note of what the pins were verified with by hand on ${lock.pinsVerifiedWith.on}`)
      else {
        stale++
        console.error(`build-bash --check: STALE — ${platform}: ${invalid}`)
      }
    }
    if (stale > 0) {
      console.error('  remedy: bun run scripts/vendor/build-bash.ts (downloads the pinned tarball and patches, verifies each sha256, builds and installs the pack)')
      process.exit(2)
    }
    process.exit(0)
  }
  for (const platform of platforms) {
    const invalid = packInvalidReason(lock, platform)
    if (invalid === null && !force) {
      console.log(`build-bash: pack already valid for ${BASH_PACK_NAME} ${lock.version} ${platform} — nothing to do (--force rebuilds)`)
      continue
    }
    const skip = skipReason(lock, platform)
    if (skip !== null) {
      console.log(`build-bash: SKIPPED — ${skip}`)
      continue
    }
    if (invalid !== null && existsSync(packDirFor(platform))) console.log(`build-bash: rebuilding — ${invalid}`)
    await buildOne(lock, platform)
  }
}

main().catch(error => fail(error instanceof Error ? error.message : String(error)))
