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
const folder = join(out, 'manifests', 'm', 'MercuryCLI', 'MercuryCLI', VERSION)
const read = (name: string): string => readFileSync(join(folder, name), 'utf8')

section('§1 the manifests a release yields: three files in the winget-pkgs layout, from the release\'s checksum file')
{
  const made = run('--version', VERSION, '--sums', sumsPath, '--out', out)
  check('the script exits 0 and names what it wrote', made.rc === 0 && made.out.includes('wrote 3 manifests') && made.out.includes(`x64: mercury-v${VERSION}-windows-x64.zip sha256 ${X64}`) && made.out.includes(`arm64: mercury-v${VERSION}-windows-arm64.zip sha256 ${ARM}`), made.out)
  for (const name of ['MercuryCLI.MercuryCLI.yaml', 'MercuryCLI.MercuryCLI.installer.yaml', 'MercuryCLI.MercuryCLI.locale.en-US.yaml']) {
    check(`${name} exists under manifests/m/MercuryCLI/MercuryCLI/${VERSION}`, existsSync(join(folder, name)))
  }
  const installer = read('MercuryCLI.MercuryCLI.installer.yaml')
  check('the installer manifest names the package, the version, the zip with its nested portable executable, the command alias and the PATH road', installer.includes('PackageIdentifier: MercuryCLI.MercuryCLI') && installer.includes(`PackageVersion: ${VERSION}`) && installer.includes('InstallerType: zip') && installer.includes('NestedInstallerType: portable') && installer.includes('RelativeFilePath: mercury\\mercury.exe') && installer.includes('PortableCommandAlias: mercury') && installer.includes('ArchiveBinariesDependOnPath: true'), installer)
  for (const [name, type] of [['MercuryCLI.MercuryCLI.yaml', 'version'], ['MercuryCLI.MercuryCLI.installer.yaml', 'installer'], ['MercuryCLI.MercuryCLI.locale.en-US.yaml', 'defaultLocale']] as const) {
    const lines = read(name).split('\n')
    check(`${name} opens with the generated-by line and the ${type} schema header (the winget-pkgs first-contribution rule)`, lines[0]!.startsWith('# Mercury CLI ') && lines[1] === `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${type}.1.12.0.schema.json` && lines[2] === '', lines.slice(0, 3).join(' | '))
  }
  check('one installer per Windows architecture, each with the release asset url and the hash in upper-case hex', installer.includes('- Architecture: x64') && installer.includes(`InstallerUrl: https://github.com/Whq02/MercuryCLI/releases/download/v${VERSION}/mercury-v${VERSION}-windows-x64.zip`) && installer.includes(`InstallerSha256: ${X64.toUpperCase()}`) && installer.includes('- Architecture: arm64') && installer.includes(`InstallerSha256: ${ARM.toUpperCase()}`), installer)
  check('no switches: a zip of a portable needs none, and none are written', !/InstallerSwitches/.test(installer))
  const version = read('MercuryCLI.MercuryCLI.yaml')
  check('the version manifest names the default locale and its type at the schema version the winget-pkgs PR template asks for', version.includes('DefaultLocale: en-US') && version.includes('ManifestType: version') && version.includes('ManifestVersion: 1.12.0'))
  const locale = read('MercuryCLI.MercuryCLI.locale.en-US.yaml')
  check('the locale manifest carries the identity the owner set for every public page: publisher and name "Mercury CLI", the site, the licence, the moniker', locale.includes('Publisher: Mercury CLI') && locale.includes('PackageName: Mercury CLI') && locale.includes('PublisherUrl: https://mercury-cli.ai') && locale.includes('License: Apache-2.0') && locale.includes(`LicenseUrl: https://raw.githubusercontent.com/Whq02/MercuryCLI/v${VERSION}/LICENSE.md`) && locale.includes('Moniker: mercurycli') && locale.includes('- mercury-cli') && locale.includes(`ReleaseNotesUrl: https://github.com/Whq02/MercuryCLI/releases/tag/v${VERSION}`), locale)
  check('a description with a colon is quoted (valid YAML)', /ShortDescription: "Mercury CLI: /.test(locale), locale)
  const again = run('--version', VERSION, '--sums', sumsPath, '--out', join(scratch, 'again'))
  const twin = readFileSync(join(scratch, 'again', 'manifests', 'm', 'MercuryCLI', 'MercuryCLI', VERSION, 'MercuryCLI.MercuryCLI.installer.yaml'), 'utf8')
  check('control: the same release yields byte-identical manifests on a second run', again.rc === 0 && twin === installer)
}

section('§2 --check: green against the release, red when a manifest drifts, when the release\'s hash moves, or when a file is missing')
{
  const green = run('--version', VERSION, '--sums', sumsPath, '--out', out, '--check')
  check('--check exits 0 against the checksum file the manifests came from', green.rc === 0 && green.out.includes('matches the release'), green.out)
  const installerPath = join(folder, 'MercuryCLI.MercuryCLI.installer.yaml')
  const original = readFileSync(installerPath, 'utf8')
  writeFileSync(installerPath, original.replace(X64.toUpperCase(), 'F'.repeat(64)))
  const drifted = run('--version', VERSION, '--sums', sumsPath, '--out', out, '--check')
  check('a hand-edited hash makes --check exit 1 and name the file', drifted.rc === 1 && drifted.out.includes('installer.yaml differs'), drifted.out)
  writeFileSync(installerPath, original)
  const movedSums = join(scratch, 'SHA256SUMS-moved.txt')
  writeFileSync(movedSums, sums.replace(X64, 'e'.repeat(64)))
  const moved = run('--version', VERSION, '--sums', movedSums, '--out', out, '--check')
  check('a release whose archive hash moved makes --check exit 1 (the manifest no longer matches the current release)', moved.rc === 1, moved.out)
  rmSync(join(folder, 'MercuryCLI.MercuryCLI.yaml'))
  const missing = run('--version', VERSION, '--sums', sumsPath, '--out', out, '--check')
  check('a missing manifest file makes --check exit 1 and name it', missing.rc === 1 && missing.out.includes('missing') && missing.out.includes('MercuryCLI.MercuryCLI.yaml'), missing.out)
  check('--check wrote nothing (the missing file stays missing)', !existsSync(join(folder, 'MercuryCLI.MercuryCLI.yaml')))
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

section('§4 the three files parse as YAML and conform to the 1.12.0 JSON schemas (the copies under fixtures/winget, from aka.ms)')
{
  const { parse } = await import('yaml')
  const { default: Ajv } = await import('ajv')
  const ajv = new Ajv({ strict: false, allErrors: true, logger: false })
  const types = [['MercuryCLI.MercuryCLI.yaml', 'version'], ['MercuryCLI.MercuryCLI.installer.yaml', 'installer'], ['MercuryCLI.MercuryCLI.locale.en-US.yaml', 'defaultLocale']] as const
  const fresh = join(scratch, 'schema')
  const made = run('--version', VERSION, '--sums', sumsPath, '--out', fresh, '--release-date', '2026-10-31')
  check('a --release-date pins the installer manifest\'s ReleaseDate', made.rc === 0 && readFileSync(join(fresh, 'manifests', 'm', 'MercuryCLI', 'MercuryCLI', VERSION, 'MercuryCLI.MercuryCLI.installer.yaml'), 'utf8').includes('ReleaseDate: 2026-10-31'), made.out)
  for (const [name, type] of types) {
    const schema = JSON.parse(readFileSync(join(ROOT, 'scripts', 'distribution', 'fixtures', 'winget', `manifest.${type}.1.12.0.json`), 'utf8')) as Record<string, unknown>
    const document = parse(readFileSync(join(fresh, 'manifests', 'm', 'MercuryCLI', 'MercuryCLI', VERSION, name), 'utf8')) as Record<string, unknown>
    const validate = ajv.compile(schema)
    const ok = validate(document)
    check(`${name} conforms to manifest.${type}.1.12.0.json`, ok === true && document.ManifestVersion === '1.12.0' && document.ManifestType === type, j(validate.errors ?? null))
  }
  const installerDoc = parse(readFileSync(join(fresh, 'manifests', 'm', 'MercuryCLI', 'MercuryCLI', VERSION, 'MercuryCLI.MercuryCLI.installer.yaml'), 'utf8')) as { NestedInstallerFiles?: Array<Record<string, string>>; Installers?: Array<Record<string, string>>; ArchiveBinariesDependOnPath?: boolean }
  check('the parsed installer carries one nested file (mercury\\mercury.exe aliased mercury), two installers and the PATH road', j(installerDoc.NestedInstallerFiles) === j([{ RelativeFilePath: 'mercury\\mercury.exe', PortableCommandAlias: 'mercury' }]) && installerDoc.Installers?.length === 2 && installerDoc.ArchiveBinariesDependOnPath === true, j(installerDoc))
}

section('§5 the zip layout: --zip reads the archive\'s entries; the nested executable must be one of them, and a .cmd launcher is refused with the reason')
{
  const zipOf = (name: string, entries: string[]): string => {
    const path = join(scratch, name)
    const made = spawnSync('python3', ['-c', 'import sys, zipfile\nwith zipfile.ZipFile(sys.argv[1], "w") as z:\n  [z.writestr(e, "x") for e in sys.argv[2:]]', path, ...entries], { encoding: 'utf8' })
    if (made.status !== 0) throw new Error(`python3 zipfile: ${made.stderr}`)
    return path
  }
  const common = ['mercury/mercury.mjs', 'mercury/manifest.json', 'mercury/vendor/node/node.exe', 'mercury/mercury.cmd', 'mercury/mercury.ps1']
  const withExe = zipOf('with-exe.zip', [...common, 'mercury/mercury.exe'])
  const armWithExe = zipOf('arm-with-exe.zip', [...common, 'mercury/mercury.exe'])
  const cmdOnly = zipOf('cmd-only.zip', common)
  const good = run('--version', VERSION, '--sums', sumsPath, '--out', join(scratch, 'zipped'), '--zip', withExe, '--zip', armWithExe)
  check('two zips that carry mercury/mercury.exe pass the layout check and the manifests are written', good.rc === 0 && good.out.includes('present in every --zip given') && existsSync(join(scratch, 'zipped', 'manifests', 'm', 'MercuryCLI', 'MercuryCLI', VERSION, 'MercuryCLI.MercuryCLI.installer.yaml')), good.out)
  const refused = run('--version', VERSION, '--sums', sumsPath, '--out', join(scratch, 'unzipped'), '--zip', withExe, '--zip', cmdOnly)
  check('a zip whose only launchers are mercury.cmd and mercury.ps1 is refused with the launchers it has and the reason, nothing written', refused.rc === 2 && refused.out.includes('has no mercury/mercury.exe') && refused.out.includes('mercury/mercury.cmd') && refused.out.includes('.exe entry point') && !existsSync(join(scratch, 'unzipped')), refused.out)
  const cmdNested = run('--version', VERSION, '--sums', sumsPath, '--out', join(scratch, 'cmd'), '--nested', 'mercury\\mercury.cmd', '--zip', cmdOnly)
  check('--nested naming the .cmd launcher is refused: WinGet links mercury.exe to the nested file', cmdNested.rc === 2 && cmdNested.out.includes('--nested must name an .exe') && !existsSync(join(scratch, 'cmd')), cmdNested.out)
  const noZip = run('--version', VERSION, '--sums', sumsPath, '--out', join(scratch, 'unchecked'), '--zip', join(scratch, 'absent.zip'))
  check('a --zip that names no file is refused', noZip.rc === 2 && noZip.out.includes('--zip names no file'), noZip.out)
  const notZip = run('--version', VERSION, '--sums', sumsPath, '--out', join(scratch, 'unchecked'), '--zip', sumsPath)
  check('a --zip that is not a zip is refused', notZip.rc === 2 && notZip.out.includes('not a zip'), notZip.out)
}

rmSync(scratch, { recursive: true, force: true })
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.log(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
