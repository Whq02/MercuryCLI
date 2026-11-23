#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  BASH_PACK_BINARY,
  BASH_PACK_MANIFEST_FILE,
  BASH_PACK_PATH,
  BASH_PACK_PLATFORMS,
  bashPackIsFetched,
  bashPackPlatform,
  bashPackTreeDigest,
  bashPatchesDigest,
  checkBashPackDir,
  readBashPackManifest,
  resolveBashPackDir,
} from '../../src/platform/shell/bashPack.ts'
import { bundledVendorPacks, checkBundledVendorPacks } from '../release/payloadContract.mjs'

const ROOT = resolve(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => console.log(`\n${title}`)
const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

type Pinned = { file: string; url: string; sha256: string }
type Lock = {
  name: string
  version: string
  release: string
  patchLevel: number
  license: string
  licenseFiles: string[]
  sourceNote: string
  pinsVerifiedWith?: { key?: string; on?: string; how?: string }
  tarball: Pinned
  patches: Pinned[]
  build: { cflags: string; configure: string[]; make: string[] }
  platforms: Record<string, { kind?: string; target: string; deploymentTarget?: string; docker?: string; configure: string[] }>
  linuxBuilder: { image: string; libc: { name: string; version: string; licenseFile: string; tarball: Pinned } }
}
const lock = JSON.parse(readFileSync(join(ROOT, 'vendor', 'bash.lock.json'), 'utf8')) as Lock
const PINNED = `${lock.version}(1)-release`

console.log('============================================================')
console.log(' The bash pack: what the lock pins is what was built, and what ships')
console.log('============================================================')

section('(1) the lock')
check(`the lock pins GNU bash ${lock.release} at patch level ${lock.patchLevel} as version ${lock.version}, under ${lock.license}`, lock.name === 'bash' && lock.version === `${lock.release}.${lock.patchLevel}` && lock.license === 'GPL-3.0-or-later')
check('the source is the GNU release tarball, over https, with a sha256', lock.tarball.url === `https://ftp.gnu.org/gnu/bash/${lock.tarball.file}` && /^[0-9a-f]{64}$/.test(lock.tarball.sha256), lock.tarball.url)
const patchNames = lock.patches.map(patch => patch.file)
const wanted = Array.from({ length: lock.patchLevel }, (_, i) => `bash${lock.release.replace('.', '')}-${String(i + 1).padStart(3, '0')}`)
check(
  `every official patch up to the patch level is pinned in order, each with its url and sha256: ${lock.patches.length}`,
  JSON.stringify(patchNames) === JSON.stringify(wanted) && lock.patches.every(patch => patch.url === `https://ftp.gnu.org/gnu/bash/bash-${lock.release}-patches/${patch.file}` && /^[0-9a-f]{64}$/.test(patch.sha256)),
  patchNames.join(' '),
)
const BUILT_PLATFORMS = BASH_PACK_PLATFORMS.filter(platform => !bashPackIsFetched(platform))
check('the lock names the six platforms of the pack and the door names the same six', JSON.stringify(Object.keys(lock.platforms).sort()) === JSON.stringify([...BASH_PACK_PLATFORMS].sort()), Object.keys(lock.platforms).join(' '))
check(
  'four are built from the GNU tarball and the two for Windows are fetched as MSYS2 packages (scripts/bash/prove-bash-win-pack.ts holds those)',
  JSON.stringify(BUILT_PLATFORMS) === JSON.stringify(['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64']) && Object.keys(lock.platforms).every(platform => (lock.platforms[platform]!.kind === 'msys2') === bashPackIsFetched(platform)),
  Object.entries(lock.platforms).map(([platform, entry]) => `${platform}:${entry.kind ?? 'built'}`).join(' '),
)
check('the Linux packs are static builds in a builder image pinned by digest', /^[a-z0-9./-]+@sha256:[0-9a-f]{64}$/.test(lock.linuxBuilder.image) && ['linux-x64', 'linux-arm64'].every(p => lock.platforms[p]!.configure.includes('--enable-static-link')), lock.linuxBuilder.image)
check("every build uses bash's own readline and its own allocator's absence is stated: no installed library is named", lock.build.configure.includes('--without-installed-readline') && lock.build.configure.includes('--without-bash-malloc') && lock.build.make.includes('YACC=false'), lock.build.configure.join(' '))
check('the door maps a host to its pack, a Windows host to its fetched one, and gives none for a host no pack is made for', bashPackPlatform('darwin', 'arm64') === 'darwin-arm64' && bashPackPlatform('darwin', 'x64') === 'darwin-x64' && bashPackPlatform('linux', 'x64') === 'linux-x64' && bashPackPlatform('linux', 'arm64') === 'linux-arm64' && bashPackPlatform('win32', 'x64') === 'win-x64' && bashPackPlatform('win32', 'arm64') === 'win-arm64' && bashPackPlatform('freebsd', 'x64') === null)
const verifiedWith = lock.pinsVerifiedWith ?? {}
check(
  'the pin is the digest: the key stands in the lock as a note of what the pins were verified with, how and on which day, and no field calls it a signing key',
  /^[0-9A-F]{40}$/.test(verifiedWith.key ?? '') && /^\d{4}-\d{2}-\d{2}$/.test(verifiedWith.on ?? '') && /no signature/.test(verifiedWith.how ?? '') && !('signingKey' in lock),
  JSON.stringify(lock.pinsVerifiedWith ?? null),
)

section('(2) the packs that stand in this checkout')
const built = BUILT_PLATFORMS.filter(platform => existsSync(join(ROOT, ...BASH_PACK_PATH.split('/'), platform, BASH_PACK_MANIFEST_FILE)))
const host = bashPackPlatform()
if (host === null) console.log(`  [SKIP] no bash pack is built for ${process.platform}/${process.arch}`)
else if (!built.includes(host)) console.log(`  [SKIP] this checkout holds no pack for ${host} (bun run scripts/vendor/build-bash.ts builds it): the rows that read it are skipped, the rows on the built bundle stand`)
else console.log(`  packs in this checkout: ${built.join(', ')}`)
for (const platform of built) {
  const dir = join(ROOT, ...BASH_PACK_PATH.split('/'), platform)
  const verdict = checkBashPackDir(dir, { digest: true, platform })
  const manifest = readBashPackManifest(dir)
  check(`${platform}: the pack reads whole and its binary matches its record`, verdict.state === 'ok', verdict.state === 'ok' ? '' : verdict.note)
  if (manifest === null || manifest.source !== 'gnu-tarball') continue
  const flags = [...lock.build.configure, ...lock.platforms[platform]!.configure]
  check(
    `${platform}: the record names the lock's version, tarball, patch set, target and flags`,
    manifest.version === lock.version && manifest.patchLevel === lock.patchLevel && manifest.bashVersion === PINNED && manifest.tarballSha256 === lock.tarball.sha256 && manifest.patchesSha256 === bashPatchesDigest(lock.patches) && manifest.target === lock.platforms[platform]!.target && JSON.stringify(manifest.configure) === JSON.stringify(flags),
    JSON.stringify({ version: manifest.version, bashVersion: manifest.bashVersion, configure: manifest.configure }),
  )
  const tree = bashPackTreeDigest(dir)
  check(`${platform}: the pack holds exactly the files its record counts, unchanged (${manifest.fileCount})`, tree.fileCount === manifest.fileCount && tree.treeDigest === manifest.treeDigest, `${tree.fileCount} files, digest ${tree.treeDigest.slice(0, 12)}`)
  const licence = readFileSync(join(dir, 'COPYING'), 'utf8')
  check(`${platform}: the licence text rides with the binary (COPYING, the GNU General Public License, version 3)`, licence.includes('GNU GENERAL PUBLIC LICENSE') && licence.includes('Version 3, 29 June 2007'))
  const note = readFileSync(join(dir, lock.sourceNote), 'utf8')
  check(
    `${platform}: the SOURCE note names the tarball, every patch, each sha256, the flags and the key the maintainer signs with`,
    [lock.tarball, ...lock.patches].every(pinned => note.includes(pinned.url) && note.includes(pinned.sha256)) && flags.every(flag => note.includes(flag)) && verifiedWith.key !== undefined && note.includes(verifiedWith.key) && note.includes(`patch level ${lock.patchLevel}`),
  )
  if (platform.startsWith('linux-')) {
    const libc = lock.linuxBuilder.libc
    check(`${platform}: a static build, and the licence of the libc inside it rides too (${libc.licenseFile})`, manifest.links.length === 1 && manifest.links[0]!.startsWith('static:') && manifest.licenseFiles.includes(libc.licenseFile) && readFileSync(join(dir, libc.licenseFile), 'utf8').includes('musl') && note.includes(libc.tarball.sha256), manifest.links.join(' '))
    const head = readFileSync(join(dir, BASH_PACK_BINARY)).subarray(0, 4).toString('latin1')
    check(`${platform}: the binary is an ELF image`, head === '\u007fELF')
  } else {
    check(`${platform}: the record says the binary links the operating system's own libraries and nothing else`, manifest.links.length > 0 && manifest.links.every(link => link.startsWith('/usr/lib/')), manifest.links.join(' '))
    check(`${platform}: built for the deployment target the lock names`, manifest.toolchain.includes(`deployment target ${lock.platforms[platform]!.deploymentTarget}`), manifest.toolchain)
  }
}

if (host !== null && built.includes(host)) {
  section(`(3) the host's binary runs (${host})`)
  const dir = join(ROOT, ...BASH_PACK_PATH.split('/'), host)
  const bash = join(dir, BASH_PACK_BINARY)
  const run = (script: string): { status: number | null; stdout: string; stderr: string } => {
    const ran = spawnSync(bash, ['--norc', '--noprofile', '-c', script], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: tmpdir() } })
    return { status: ran.status, stdout: ran.stdout ?? '', stderr: ran.stderr ?? '' }
  }
  const version = run('printf %s "$BASH_VERSION"')
  check(`it says BASH_VERSION ${PINNED}`, version.status === 0 && version.stdout === PINNED, `${version.stdout} ${version.stderr}`)
  const commit = run('msg="$(cat <<\'EOF\'\nfix: it\'s the reader\'s guard (one\nEOF\n)"; printf \'%s\\n\' "$msg"')
  check('a commit message in a here-document inside $( ) keeps its apostrophes and its parenthesis', commit.status === 0 && commit.stdout === "fix: it's the reader's guard (one\n", `${commit.status} ${JSON.stringify(commit.stdout)} ${commit.stderr}`)
  const modern = run('declare -A m; m[k]=v; v=ABC; mapfile -t l < <(printf "a\\nb\\n"); echo "${m[k]} ${v,,} ${#l[@]}"')
  check('associative arrays, case conversion, mapfile and process substitution work', modern.status === 0 && modern.stdout === 'v abc 2\n', `${JSON.stringify(modern.stdout)} ${modern.stderr}`)
  if (process.platform === 'darwin') {
    const linked = spawnSync('/usr/bin/otool', ['-L', bash], { encoding: 'utf8' })
    const libraries = (linked.stdout ?? '').split('\n').slice(1).map(line => line.trim().split(' (')[0] ?? '').filter(Boolean)
    check('otool -L names only libraries of the operating system', linked.status === 0 && libraries.length > 0 && libraries.every(library => library.startsWith('/usr/lib/')), libraries.join(' '))
  }
  const checked = spawnSync(process.execPath, ['run', join(ROOT, 'scripts', 'vendor', 'build-bash.ts'), '--check'], { cwd: ROOT, encoding: 'utf8' })
  check(
    'build-bash.ts --check says what it holds the pack to: the digests, and that it checks no signature',
    checked.status === 0 && /valid against the lock's digests \(the tarball and \d+ patches by sha256/.test(checked.stdout ?? '') && /no signature is checked/.test(checked.stdout ?? ''),
    `exit ${String(checked.status)} · ${JSON.stringify(`${checked.stdout ?? ''}${checked.stderr ?? ''}`.slice(0, 400))}`,
  )

  section('(4) the door refuses a pack that is not what its record says')
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'bash-pack-')))
  try {
    const copy = join(scratch, host)
    cpSync(dir, copy, { recursive: true })
    check('a whole copy passes', checkBashPackDir(copy, { digest: true, platform: host }).state === 'ok')
    writeFileSync(join(copy, BASH_PACK_BINARY), Buffer.concat([readFileSync(join(copy, BASH_PACK_BINARY)), Buffer.from('x')]))
    const changed = checkBashPackDir(copy, { digest: true, platform: host })
    check('a changed binary is refused, naming the digest', changed.state === 'mismatch' && changed.note.includes('digest'), changed.state === 'ok' ? 'passed' : changed.note)
    cpSync(dir, copy, { recursive: true, force: true })
    rmSync(join(copy, 'COPYING'))
    const unlicensed = checkBashPackDir(copy, { platform: host })
    check('a pack without its licence text is refused, naming the file', unlicensed.state === 'mismatch' && unlicensed.note.includes('COPYING'), unlicensed.state === 'ok' ? 'passed' : unlicensed.note)
    const other = BUILT_PLATFORMS.find(platform => platform !== host)!
    const foreign = checkBashPackDir(dir, { platform: other })
    check(`the pack of one platform is refused on another (${other})`, foreign.state === 'mismatch', foreign.state === 'ok' ? 'passed' : foreign.note)
    const absent = resolveBashPackDir(scratch)
    check('with no pack beside the module the door says so and names the command that builds it', absent.state === 'unavailable' && absent.note.includes('bun run scripts/vendor/build-bash.ts'), absent.state === 'ok' ? absent.dir : absent.note)
    const here = resolveBashPackDir()
    check("from the source tree the door finds the checkout's own pack", here.state === 'ok' && here.source === 'workspace' && here.manifest.bashVersion === PINNED, here.state === 'ok' ? here.dir : here.note)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

section('(5) the build and the archive take the pack')
{
  type Pack = { name: string; version: string; platform: string; binary: string; degradation: string; manifestKey: string; dir: string; files: string[]; tree?: boolean }
  const targets: Array<[string, string]> = [['macos-arm64', 'darwin-arm64'], ['macos-x64', 'darwin-x64'], ['linux-x64', 'linux-x64'], ['linux-arm64', 'linux-arm64']]
  for (const [target, platform] of targets) {
    const packs = bundledVendorPacks(target) as Pack[]
    const pack = packs[0]
    check(
      `${target}: the payload contract requires the bash pack, its record, its licence text and its SOURCE note${platform.startsWith('linux-') ? ', and the libc licence' : ''}`,
      packs.length === 1 && pack?.name === 'bash' && pack.tree === true && pack.version === lock.version && pack.platform === platform && pack.dir === `${BASH_PACK_PATH}/${platform}` && pack.degradation === 'shell-bash' && pack.manifestKey === 'bash' && ['bash', '.vendor-manifest.json', 'COPYING', 'SOURCE'].every(file => pack.files.includes(file)) && pack.files.includes('LICENSE.musl') === platform.startsWith('linux-'),
      JSON.stringify(packs),
    )
  }
  const windows = bundledVendorPacks('windows-x64') as Pack[]
  check('windows-x64: the contract requires the fetched bash pack, held by its tree, before the engine pack', windows.length === 2 && windows[0]?.name === 'bash' && windows[0].tree === true && windows[0].dir === `${BASH_PACK_PATH}/win-x64` && windows[0].binary === 'usr/bin/bash.exe' && windows[1]?.name === 'brush', JSON.stringify(windows.map(pack => pack.name)))

  const manifestPath = join(ROOT, 'dist', 'manifest.json')
  if (!existsSync(manifestPath)) {
    console.log('  [SKIP] dist/manifest.json absent — build first (the gate prebuilds)')
  } else {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { degraded?: string[]; target?: { release?: string | null }; bash?: { vendored?: boolean; path?: string; bashVersion?: string; binary?: string; binarySha256?: string; license?: string } }
    const release = manifest.target?.release ?? null
    if (release === null || release.startsWith('windows-')) {
      console.log(`  [SKIP] this build ships for ${String(release)}: the bash pack is the macOS and Linux road`)
    } else if (manifest.degraded?.includes('shell-bash')) {
      check('a build without the pack says so: its manifest names the degradation and the remedy', manifest.bash?.vendored === false, JSON.stringify(manifest.bash))
      console.log('  [SKIP] this build carries no bash pack (degraded: shell-bash) — the shipped rows read a build made with the pack')
    } else {
      const shipped = manifest.bash
      const binary = join(ROOT, 'dist', ...(shipped?.path ?? '').split('/'), shipped?.binary ?? '')
      check(`the built bundle carries the pack and its manifest says which: bash ${String(shipped?.bashVersion)}, ${String(shipped?.license)}`, shipped?.vendored === true && shipped.bashVersion === PINNED && shipped.license === lock.license && existsSync(binary) && sha256(binary) === shipped.binarySha256, JSON.stringify(shipped))
      const verdict = checkBundledVendorPacks(join(ROOT, 'dist'), release) as { ok: boolean; findings: string[]; packs: Pack[] }
      const own = verdict.findings.filter(finding => finding.startsWith(`${BASH_PACK_PATH}/`))
      check('the payload check finds the pack whole in the built payload', verdict.packs.some(pack => pack.name === 'bash') && own.length === 0, own.join('; '))
      const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'bash-payload-')))
      try {
        const empty = checkBundledVendorPacks(scratch, release) as { ok: boolean; findings: string[] }
        check('an archive without the pack is refused, each missing file named', !empty.ok && ['bash', 'COPYING', 'SOURCE'].every(file => empty.findings.some(finding => finding.startsWith(`${BASH_PACK_PATH}/`) && finding.endsWith(`/${file} is missing`))), empty.findings.filter(finding => finding.startsWith(BASH_PACK_PATH)).join('; '))
      } finally {
        rmSync(scratch, { recursive: true, force: true })
      }
    }
  }
}

console.log(failures === 0 ? '\nprove-bash-pack: ALL LAWS HOLD' : `\nprove-bash-pack: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
