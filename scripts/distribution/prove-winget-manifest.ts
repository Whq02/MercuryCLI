#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'release', 'winget-manifest.mjs')
let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)
const j = (value: unknown): string => JSON.stringify(value)

const scratch = mkdtempSync(join(tmpdir(), 'winget-manifest-'))
const VERSION = '1.2.3-beta.4'
const X64 = 'a'.repeat(63) + '1'
const ARM = 'b'.repeat(63) + '2'
const sums = [
  `${'c'.repeat(64)}  mercury-v${VERSION}-linux-x64.tar.gz`,
  `${X64}  mercury-v${VERSION}-windows-x64.zip`,
  `${ARM}  mercury-v${VERSION}-windows-arm64.zip`,
  `${'d'.repeat(64)}  mercury-v${VERSION}-macos-arm64.tar.gz`,
  '',
].join('\n')
const sumsPath = join(scratch, 'SHA256SUMS.txt')
writeFileSync(sumsPath, sums)
const out = join(scratch, 'out')
const run = (...args: string[]) => {
  const result = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', timeout: 60_000 })
  return { rc: result.status ?? -1, out: `${result.stdout}${result.stderr}` }
}
const folder = join(out, 'manifests', 'm', 'MercuryCLI', 'Mercury', VERSION)
const read = (name: string): string => readFileSync(join(folder, name), 'utf8')

section('§1 the manifests a release yields: three files in the winget-pkgs layout, from the release\'s checksum file')
{
  const made = run('--version', VERSION, '--sums', sumsPath, '--out', out)
  check('the script exits 0 and names what it wrote', made.rc === 0 && made.out.includes('wrote 3 manifests') && made.out.includes(`x64: mercury-v${VERSION}-windows-x64.zip sha256 ${X64}`) && made.out.includes(`arm64: mercury-v${VERSION}-windows-arm64.zip sha256 ${ARM}`), made.out)
  for (const name of ['MercuryCLI.Mercury.yaml', 'MercuryCLI.Mercury.installer.yaml', 'MercuryCLI.Mercury.locale.en-US.yaml']) {
    check(`${name} exists under manifests/m/MercuryCLI/Mercury/${VERSION}`, existsSync(join(folder, name)))
  }
  const installer = read('MercuryCLI.Mercury.installer.yaml')
  check('the installer manifest names the package, the version, the zip with its nested portable launcher and the command alias', installer.includes('PackageIdentifier: MercuryCLI.Mercury') && installer.includes(`PackageVersion: ${VERSION}`) && installer.includes('InstallerType: zip') && installer.includes('NestedInstallerType: portable') && installer.includes('RelativeFilePath: mercury\\mercury.cmd') && installer.includes('PortableCommandAlias: mercury'), installer)
  check('one installer per Windows architecture, each with the release asset url and the hash in upper-case hex', installer.includes('- Architecture: x64') && installer.includes(`InstallerUrl: https://github.com/Whq02/MercuryCLI/releases/download/v${VERSION}/mercury-v${VERSION}-windows-x64.zip`) && installer.includes(`InstallerSha256: ${X64.toUpperCase()}`) && installer.includes('- Architecture: arm64') && installer.includes(`InstallerSha256: ${ARM.toUpperCase()}`), installer)
  check('no switches: a zip of a portable needs none, and none are written', !/InstallerSwitches/.test(installer))
  const version = read('MercuryCLI.Mercury.yaml')
  check('the version manifest names the default locale and its type', version.includes('DefaultLocale: en-US') && version.includes('ManifestType: version') && version.includes('ManifestVersion: 1.9.0'))
  const locale = read('MercuryCLI.Mercury.locale.en-US.yaml')
  check('the locale manifest carries the identity the owner set for every public page: publisher and name "Mercury CLI", the site, the licence, the moniker', locale.includes('Publisher: Mercury CLI') && locale.includes('PackageName: Mercury CLI') && locale.includes('PublisherUrl: https://mercury-cli.ai') && locale.includes('License: Business Source License 1.1 (BUSL-1.1)') && locale.includes('Moniker: mercury') && locale.includes(`ReleaseNotesUrl: https://github.com/Whq02/MercuryCLI/releases/tag/v${VERSION}`), locale)
  check('a description with a colon is quoted (valid YAML)', /ShortDescription: "Mercury CLI: /.test(locale), locale)
  const again = run('--version', VERSION, '--sums', sumsPath, '--out', join(scratch, 'again'))
  const twin = readFileSync(join(scratch, 'again', 'manifests', 'm', 'MercuryCLI', 'Mercury', VERSION, 'MercuryCLI.Mercury.installer.yaml'), 'utf8')
  check('control: the same release yields byte-identical manifests on a second run', again.rc === 0 && twin === installer)
}

section('§2 --check: green against the release, red when a manifest drifts, when the release\'s hash moves, or when a file is missing')
{
  const green = run('--version', VERSION, '--sums', sumsPath, '--out', out, '--check')
  check('--check exits 0 against the checksum file the manifests came from', green.rc === 0 && green.out.includes('matches the release'), green.out)
  const installerPath = join(folder, 'MercuryCLI.Mercury.installer.yaml')
  const original = readFileSync(installerPath, 'utf8')
  writeFileSync(installerPath, original.replace(X64.toUpperCase(), 'F'.repeat(64)))
  const drifted = run('--version', VERSION, '--sums', sumsPath, '--out', out, '--check')
  check('a hand-edited hash makes --check exit 1 and name the file', drifted.rc === 1 && drifted.out.includes('installer.yaml differs'), drifted.out)
  writeFileSync(installerPath, original)
  const movedSums = join(scratch, 'SHA256SUMS-moved.txt')
  writeFileSync(movedSums, sums.replace(X64, 'e'.repeat(64)))
  const moved = run('--version', VERSION, '--sums', movedSums, '--out', out, '--check')
  check('a release whose archive hash moved makes --check exit 1 (the manifest no longer matches the current release)', moved.rc === 1, moved.out)
  rmSync(join(folder, 'MercuryCLI.Mercury.yaml'))
  const missing = run('--version', VERSION, '--sums', sumsPath, '--out', out, '--check')
  check('a missing manifest file makes --check exit 1 and name it', missing.rc === 1 && missing.out.includes('missing') && missing.out.includes('MercuryCLI.Mercury.yaml'), missing.out)
  check('--check wrote nothing (the missing file stays missing)', !existsSync(join(folder, 'MercuryCLI.Mercury.yaml')))
}

section('§3 refusals: no Windows archive in the checksum file, a version or id that is not one, a checksum file that is not there, a malformed hash line')
{
  const noWindows = join(scratch, 'SHA256SUMS-posix.txt')
  writeFileSync(noWindows, `${'c'.repeat(64)}  mercury-v${VERSION}-linux-x64.tar.gz\n`)
  const refusedAsset = run('--version', VERSION, '--sums', noWindows, '--out', join(scratch, 'none'))
  check('a checksum file with no Windows archive is refused with the names it looked for, nothing written', refusedAsset.rc === 2 && refusedAsset.out.includes('lists no Windows archive') && refusedAsset.out.includes(`mercury-v${VERSION}-windows-x64.zip`) && !existsSync(join(scratch, 'none')), refusedAsset.out)
  const badVersion = run('--version', '../../etc', '--sums', sumsPath, '--out', join(scratch, 'bad'))
  check('a version that is not a release version is refused (a traversal spelling among them)', badVersion.rc === 2 && badVersion.out.includes('--version must be a release version') && !existsSync(join(scratch, 'bad')), badVersion.out)
  const badId = run('--version', VERSION, '--sums', sumsPath, '--out', join(scratch, 'bad'), '--id', 'Mercury CLI/../x')
  check('an id that is not Publisher.Package is refused', badId.rc === 2 && badId.out.includes('--id must be Publisher.Package') && !existsSync(join(scratch, 'bad')), badId.out)
  const noFile = run('--version', VERSION, '--sums', join(scratch, 'absent.txt'), '--out', join(scratch, 'bad'))
  check('a --sums that names no file is refused', noFile.rc === 2 && noFile.out.includes('names no file'), noFile.out)
  const shortHash = join(scratch, 'SHA256SUMS-short.txt')
  writeFileSync(shortHash, `abc123  mercury-v${VERSION}-windows-x64.zip\n`)
  const malformed = run('--version', VERSION, '--sums', shortHash, '--out', join(scratch, 'bad'))
  check('a hash that is not 64 hex characters is no hash: the line is ignored and the file is refused for the archive it fails to name', malformed.rc === 2 && malformed.out.includes('lists no Windows archive'), malformed.out)
  const help = run('--help')
  check('--help prints the usage and exits 0', help.rc === 0 && help.out.includes('--check'))
}

rmSync(scratch, { recursive: true, force: true })
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.log(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
