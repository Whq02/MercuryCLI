#!/usr/bin/env node
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const REPO = 'Whq02/MercuryCLI'
const SITE = 'https://mercury-cli.ai'
const MANIFEST_VERSION = '1.12.0'
const SCHEMA_URL = type => `https://aka.ms/winget-manifest.${type}.${MANIFEST_VERSION}.schema.json`
const DEFAULTS = {
  id: 'MercuryCLI.MercuryCLI',
  publisher: 'Mercury CLI',
  name: 'Mercury CLI',
  moniker: 'mercurycli',
  command: 'mercury',
  nested: 'mercury\\mercury.exe',
  license: 'Apache-2.0',
  description: 'Mercury CLI: a software-development harness for the terminal.',
  tags: ['ai', 'cli', 'coding-agent', 'developer-tools', 'mercury-cli', 'terminal'],
}
const ARCHITECTURES = [
  { architecture: 'x64', target: 'windows-x64' },
  { architecture: 'arm64', target: 'windows-arm64' },
]

const USAGE = `winget-manifest.mjs — the WinGet package manifests for one Mercury release, from the release's own checksum file.

  node scripts/release/winget-manifest.mjs [--version <x.y.z[-pre]>] [--sums <SHA256SUMS.txt>] [--out <dir>] [--id <Publisher.Package>] [--nested <path in the zip>] [--zip <archive>]... [--release-date <YYYY-MM-DD>]
  node scripts/release/winget-manifest.mjs --check [the same options]

  --version       the release (default: package.json's version); the archives are mercury-v<version>-windows-<arch>.zip
  --sums          a SHA256SUMS.txt to read the archive hashes from (default: the GitHub release's, fetched)
  --out           where the manifest folder lands (default: release-out/winget); the three files sit under
                  manifests/<m>/<Publisher>/<Package>/<version>/ exactly as microsoft/winget-pkgs lays them out
  --id            the package identifier (default ${DEFAULTS.id})
  --nested        the executable inside the zip that the \`${DEFAULTS.command}\` command runs (default ${DEFAULTS.nested}); WinGet links
                  <alias>.exe to it, so it must be an .exe
  --zip           a Windows release archive to read the layout from (one per architecture); the nested executable must be an
                  entry of every archive given, else the run is refused; without --zip the layout is not checked
  --release-date  the date the installer manifest records (default: the checksum file's "# released" line, else today)
  --check         write nothing: regenerate from the release's checksum file and compare with the files under --out
                  (exit 0 when identical, 1 when a file differs or is missing, 2 on a usage or source refusal)
`

function fail(message, code = 2) {
  console.error(`winget-manifest: ${message}`)
  process.exit(code)
}

function argValue(flag) {
  const at = process.argv.indexOf(flag)
  if (at === -1) return null
  const value = process.argv[at + 1]
  if (value === undefined || value.startsWith('--')) fail(`${flag} wants a value`)
  return value
}

function argValues(flag) {
  const values = []
  for (let at = 0; at < process.argv.length; at++) {
    if (process.argv[at] !== flag) continue
    const value = process.argv[at + 1]
    if (value === undefined || value.startsWith('--')) fail(`${flag} wants a value`)
    values.push(value)
  }
  return values
}

function parseChecksums(text) {
  const sums = new Map()
  for (const line of text.split('\n')) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$/.exec(line.trim())
    if (match) sums.set(match[2], match[1].toLowerCase())
  }
  return sums
}

function yamlString(value) {
  return /^[A-Za-z0-9][A-Za-z0-9 ._:/()\-]*$/.test(value) && !/^(?:true|false|null|yes|no|on|off)$/i.test(value) && !/: /.test(value) && !/\s$/.test(value) ? value : JSON.stringify(value)
}

function zipEntryNames(path) {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const tailLength = Math.min(size, 65_557)
    const tail = Buffer.alloc(tailLength)
    readSync(fd, tail, 0, tailLength, size - tailLength)
    let eocd = -1
    for (let at = tailLength - 22; at >= 0; at--) {
      if (tail.readUInt32LE(at) === 0x06054b50) {
        eocd = at
        break
      }
    }
    if (eocd < 0) throw new Error(`${path} has no end-of-central-directory record (not a zip)`)
    let entries = tail.readUInt16LE(eocd + 10)
    let directorySize = tail.readUInt32LE(eocd + 12)
    let directoryOffset = tail.readUInt32LE(eocd + 16)
    if (entries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
      const locator = eocd - 20
      if (locator < 0 || tail.readUInt32LE(locator) !== 0x07064b50) throw new Error(`${path} is a zip64 archive without a zip64 locator`)
      const record = Buffer.alloc(56)
      readSync(fd, record, 0, 56, Number(tail.readBigUInt64LE(locator + 8)))
      if (record.readUInt32LE(0) !== 0x06064b50) throw new Error(`${path} has a broken zip64 end-of-central-directory record`)
      entries = Number(record.readBigUInt64LE(32))
      directorySize = Number(record.readBigUInt64LE(40))
      directoryOffset = Number(record.readBigUInt64LE(48))
    }
    const directory = Buffer.alloc(directorySize)
    readSync(fd, directory, 0, directorySize, directoryOffset)
    const names = []
    let at = 0
    while (names.length < entries && at + 46 <= directory.length && directory.readUInt32LE(at) === 0x02014b50) {
      const nameLength = directory.readUInt16LE(at + 28)
      const extraLength = directory.readUInt16LE(at + 30)
      const commentLength = directory.readUInt16LE(at + 32)
      names.push(directory.toString('utf8', at + 46, at + 46 + nameLength))
      at += 46 + nameLength + extraLength + commentLength
    }
    return names
  } finally {
    closeSync(fd)
  }
}

function renderManifests(facts) {
  const { id, version, publisher, name, moniker, command, nested, license, description, tags, installers } = facts
  const header = type => `# ${name} ${version} — generated by scripts/release/winget-manifest.mjs from the release's SHA256SUMS.txt; regenerate, never hand-edit\n# yaml-language-server: $schema=${SCHEMA_URL(type)}\n`
  const versionManifest = [
    header('version'),
    `PackageIdentifier: ${id}`,
    `PackageVersion: ${yamlString(version)}`,
    'DefaultLocale: en-US',
    'ManifestType: version',
    `ManifestVersion: ${MANIFEST_VERSION}`,
    '',
  ].join('\n')
  const installerLines = [
    header('installer'),
    `PackageIdentifier: ${id}`,
    `PackageVersion: ${yamlString(version)}`,
    'InstallerType: zip',
    'NestedInstallerType: portable',
    'NestedInstallerFiles:',
    `- RelativeFilePath: ${nested}`,
    `  PortableCommandAlias: ${command}`,
    'ArchiveBinariesDependOnPath: true',
    'Commands:',
    `- ${command}`,
    `ReleaseDate: ${facts.releaseDate}`,
    'Installers:',
  ]
  for (const installer of installers) {
    installerLines.push(`- Architecture: ${installer.architecture}`)
    installerLines.push(`  InstallerUrl: ${installer.url}`)
    installerLines.push(`  InstallerSha256: ${installer.sha256.toUpperCase()}`)
  }
  installerLines.push('ManifestType: installer', `ManifestVersion: ${MANIFEST_VERSION}`, '')
  const localeManifest = [
    header('defaultLocale'),
    `PackageIdentifier: ${id}`,
    `PackageVersion: ${yamlString(version)}`,
    'PackageLocale: en-US',
    `Publisher: ${yamlString(publisher)}`,
    `PublisherUrl: ${SITE}`,
    `PublisherSupportUrl: https://github.com/${REPO}/issues`,
    `PackageName: ${yamlString(name)}`,
    `PackageUrl: ${SITE}`,
    `License: ${yamlString(license)}`,
    `LicenseUrl: https://raw.githubusercontent.com/${REPO}/v${version}/LICENSE.md`,
    `ShortDescription: ${yamlString(description)}`,
    `Moniker: ${moniker}`,
    'Tags:',
    ...tags.map(tag => `- ${tag}`),
    `ReleaseNotesUrl: https://github.com/${REPO}/releases/tag/v${version}`,
    'ManifestType: defaultLocale',
    `ManifestVersion: ${MANIFEST_VERSION}`,
    '',
  ].join('\n')
  return {
    [`${id}.yaml`]: versionManifest,
    [`${id}.installer.yaml`]: installerLines.join('\n'),
    [`${id}.locale.en-US.yaml`]: localeManifest,
  }
}

function manifestFolder(id, version) {
  const [publisher, pkg] = id.split('.')
  return join('manifests', publisher.slice(0, 1).toLowerCase(), publisher, pkg, version)
}

function installersFor(version, sums) {
  const installers = []
  for (const { architecture, target } of ARCHITECTURES) {
    const asset = `mercury-v${version}-${target}.zip`
    const sha256 = sums.get(asset)
    if (sha256 === undefined) continue
    installers.push({ architecture, target, asset, url: `https://github.com/${REPO}/releases/download/v${version}/${asset}`, sha256 })
  }
  return installers
}

async function readSums(version, sumsPath) {
  if (sumsPath !== null) {
    if (!existsSync(sumsPath)) fail(`--sums names no file: ${sumsPath}`)
    return { text: readFileSync(sumsPath, 'utf8'), source: sumsPath }
  }
  const url = `https://github.com/${REPO}/releases/download/v${version}/SHA256SUMS.txt`
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) fail(`the release's checksum file answered HTTP ${response.status}: ${url}`)
  return { text: await response.text(), source: url }
}

function releaseDateOf(sumsText, fallback) {
  const stamp = /^#\s*released\s+(\d{4}-\d{2}-\d{2})/im.exec(sumsText)
  return stamp ? stamp[1] : fallback
}

function checkLayout(zips, nested) {
  const wanted = nested.replace(/\\/g, '/')
  for (const zip of zips) {
    if (!existsSync(zip)) fail(`--zip names no file: ${zip}`)
    let names
    try {
      names = zipEntryNames(zip)
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
    if (!names.includes(wanted)) {
      const launchers = names.filter(name => /^mercury\/mercury(\.[a-z0-9]+)?$/.test(name))
      fail(`${zip} has no ${wanted} (its launchers: ${launchers.join(', ') || 'none'}); WinGet links ${DEFAULTS.command}.exe to the nested file, so the zip needs an .exe entry point before it can be a WinGet package`)
    }
  }
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(USAGE)
    return
  }
  const check = process.argv.includes('--check')
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const version = argValue('--version') ?? pkg.version
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(version)) fail(`--version must be a release version like 1.0.0-beta.37 (got ${JSON.stringify(version)})`)
  const id = argValue('--id') ?? DEFAULTS.id
  if (!/^[A-Za-z0-9]+\.[A-Za-z0-9]+$/.test(id)) fail(`--id must be Publisher.Package in letters and digits (got ${JSON.stringify(id)})`)
  const nested = argValue('--nested') ?? DEFAULTS.nested
  if (!/^[A-Za-z0-9_.\\-]+$/.test(nested) || nested.includes('..') || nested.startsWith('\\')) fail(`--nested must be a relative path inside the zip, in backslashes (got ${JSON.stringify(nested)})`)
  if (!/\.exe$/i.test(nested)) fail(`--nested must name an .exe: WinGet links ${DEFAULTS.command}.exe to the nested file, and a link named .exe cannot start ${nested}`)
  const releaseDateArg = argValue('--release-date')
  if (releaseDateArg !== null && !/^\d{4}-\d{2}-\d{2}$/.test(releaseDateArg)) fail(`--release-date must be YYYY-MM-DD (got ${JSON.stringify(releaseDateArg)})`)
  const outRoot = resolve(argValue('--out') ?? join(ROOT, 'release-out', 'winget'))
  const sums = await readSums(version, argValue('--sums'))
  const checksums = parseChecksums(sums.text)
  const installers = installersFor(version, checksums)
  if (installers.length === 0) fail(`${sums.source} lists no Windows archive for ${version} (looked for ${ARCHITECTURES.map(a => `mercury-v${version}-${a.target}.zip`).join(', ')})`)
  checkLayout(argValues('--zip'), nested)
  const releaseDate = releaseDateArg ?? releaseDateOf(sums.text, new Date().toISOString().slice(0, 10))
  const files = renderManifests({ ...DEFAULTS, id, version, nested, installers, releaseDate: check ? readReleaseDate(outRoot, id, version) ?? releaseDate : releaseDate })
  const folder = join(outRoot, manifestFolder(id, version))
  if (check) {
    let differences = 0
    for (const [name, text] of Object.entries(files)) {
      const path = join(folder, name)
      if (!existsSync(path)) {
        console.error(`winget-manifest: missing ${path}`)
        differences++
        continue
      }
      if (readFileSync(path, 'utf8') !== text) {
        console.error(`winget-manifest: ${path} differs from the manifest the release's checksum file yields`)
        differences++
      }
    }
    if (differences > 0) process.exit(1)
    console.log(`winget-manifest: ${folder} matches the release ${version} (${installers.map(i => `${i.architecture} ${i.sha256.slice(0, 12)}…`).join(', ')}; checksums from ${sums.source})`)
    return
  }
  mkdirSync(folder, { recursive: true })
  for (const [name, text] of Object.entries(files)) writeFileSync(join(folder, name), text)
  console.log(`winget-manifest: wrote ${Object.keys(files).length} manifests to ${folder}`)
  for (const installer of installers) console.log(`  ${installer.architecture}: ${installer.asset} sha256 ${installer.sha256}`)
  console.log(`  nested executable ${nested} (${argValues('--zip').length > 0 ? 'present in every --zip given' : 'layout not checked: no --zip given'}); checksums from ${sums.source}`)
}

function readReleaseDate(outRoot, id, version) {
  const path = join(outRoot, manifestFolder(id, version), `${id}.installer.yaml`)
  if (!existsSync(path)) return null
  const match = /^ReleaseDate: (\d{4}-\d{2}-\d{2})$/m.exec(readFileSync(path, 'utf8'))
  return match ? match[1] : null
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => fail(error instanceof Error ? error.message : String(error), 1))
}
