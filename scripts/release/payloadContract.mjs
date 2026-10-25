import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DOC_SET = ['README-FIRST.md', 'INSTALLING.md', 'UPDATING.md', 'RELEASE-NOTES.md', 'NOTICES.md', 'LICENSE.md', 'NOTICE', 'TRADEMARKS.md']

export const UNSIGNED_ARCHIVE_SUFFIX = '-unsigned'

export function unsignedArchiveName(archiveName) {
  const m = /^(.*?)(\.tar\.gz|\.zip)$/.exec(archiveName)
  if (!m) throw new Error(`unsignedArchiveName: ${archiveName} is not an archive name (.tar.gz or .zip)`)
  return `${m[1]}${UNSIGNED_ARCHIVE_SUFFIX}${m[2]}`
}

export function readCompatFloor() {
  const here = dirname(fileURLToPath(import.meta.url))
  return JSON.parse(readFileSync(join(here, 'compat-floor.json'), 'utf8'))
}

export function topAllowlist(target, floor) {
  const isWin = target.startsWith('windows-')
  const members = [
    'mercury.mjs',
    'manifest.json',
    'vendor',
    'splash.mjs',
    'splash-core.mjs',
    'verify-artifact.mjs',
    'mercury-vscode.vsix',
    ...DOC_SET,
    ...(isWin ? ['mercury.cmd', 'mercury.ps1', 'install.ps1'] : ['mercury', 'install.sh']),
  ]
  return members.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

export function memberRole(name) {
  if (name === 'mercury.mjs') return 'primary'
  if (name === 'manifest.json') return 'manifest'
  if (name === 'mercury' || name === 'mercury.cmd') return 'launcher'
  if (name === 'mercury.ps1') return 'launcher-ps'
  if (name === 'install.sh' || name === 'install.ps1') return 'installer'
  if (name === 'splash.mjs') return 'splash'
  if (name === 'splash-core.mjs') return 'splash-core'
  if (name === 'verify-artifact.mjs') return 'verifier'
  if (name === 'mercury-vscode.vsix') return 'vsix'
  if (name === 'vendor') return 'vendor-tree'
  if (DOC_SET.includes(name)) return 'doc'
  return 'unknown'
}

export const launcherFor = target => (target.startsWith('windows-') ? 'mercury.cmd' : 'mercury')

const sha256File = path => createHash('sha256').update(readFileSync(path)).digest('hex')

export function walkPayloadFiles(dir, base = '') {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const rel = base ? `${base}/${name}` : name
    if (statSync(full).isDirectory()) out.push(...walkPayloadFiles(full, rel))
    else out.push({ path: rel, bytes: statSync(full).size })
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

export function payloadDigestOf(dir) {
  const h = createHash('sha256')
  for (const f of walkPayloadFiles(dir)) {
    if (f.path === 'manifest.json') continue
    h.update(`${f.path}\n${sha256File(join(dir, f.path))}\n`)
  }
  return h.digest('hex')
}

export function releaseLayoutSection(stagedDir, target, floor) {
  const members = []
  const compatibility = []
  for (const name of readdirSync(stagedDir).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const full = join(stagedDir, name)
    const role = memberRole(name)
    if (name === 'manifest.json') continue
    if (statSync(full).isDirectory()) {
      members.push({ path: name, role, treeDigest: payloadDigestOf(full) })
    } else {
      const entry = { path: name, role, bytes: statSync(full).size, sha256: sha256File(full) }
      members.push(entry)
    }
  }
  const primary = members.find(m => m.role === 'primary')
  if (!primary) throw new Error('releaseLayoutSection: staged payload has no primary bundle')
  return {
    schema: 1,
    floorVersion: floor.floorVersion,
    primary: { path: primary.path, bytes: primary.bytes, sha256: primary.sha256 },
    compatibility,
    launcher: launcherFor(target),
    payloadDigest: payloadDigestOf(stagedDir),
    manifestMember: { path: 'manifest.json', role: 'manifest' },
    members,
  }
}

function readShellEngineLock() {
  const here = dirname(fileURLToPath(import.meta.url))
  return JSON.parse(readFileSync(join(here, '..', '..', 'vendor', 'brush.lock.json'), 'utf8'))
}

export function bundledVendorPacks(target) {
  if (!target.startsWith('windows-')) return []
  const platform = target === 'windows-arm64' ? 'win-arm64' : 'win-x64'
  const lock = readShellEngineLock()
  const entry = lock.platforms[platform]
  return [
    {
      name: lock.name,
      version: lock.version,
      platform,
      binary: 'brush.exe',
      degradation: 'shell-engine',
      manifestKey: 'shellEngine',
      dir: `vendor/brush/${platform}`,
      files: ['brush.exe', '.vendor-manifest.json', 'NOTICES.json', `licenses/${entry.crate}-${entry.crateVersion}/LICENSE`],
    },
  ]
}

export function checkBundledVendorPacks(payloadDir, target) {
  const findings = []
  const platform = { 'macos-arm64': 'darwin-arm64', 'macos-x64': 'darwin-x64', 'linux-arm64': 'linux-arm64', 'linux-x64': 'linux-x64', 'windows-arm64': 'win32-arm64', 'windows-x64': 'win32-x64' }[target]
  const whisperPath = `vendor/whisper/${platform}`
  const whisperDir = join(payloadDir, ...whisperPath.split('/'))
  try {
    const manifest = JSON.parse(readFileSync(join(payloadDir, 'manifest.json'), 'utf8'))
    const shipped = manifest.onDeviceTranscriber
    if (!shipped?.vendored || shipped.platform !== platform || shipped.path !== whisperPath || manifest.degraded?.includes('on-device-transcriber')) findings.push(`${target} must carry its on-device transcriber in the archive manifest`)
    const record = JSON.parse(readFileSync(join(whisperDir, '.vendor-manifest.json'), 'utf8'))
    if (record.name !== 'mercury-whisper' || record.platform !== platform || record.addon !== 'mercury_whisper.node' || !record.version || record.engine?.name !== 'whisper.cpp') findings.push(`${whisperPath} carries an invalid pack record`)
    const digest = sha256File(join(whisperDir, 'mercury_whisper.node'))
    if (digest !== record.addonSha256 || digest !== shipped?.addonSha256 || shipped?.addon !== record.addon || shipped?.version !== record.version) findings.push(`${whisperPath}/mercury_whisper.node does not match the pack and archive records`)
    for (const file of ['NOTICES.json', `licenses/whisper.cpp-${record.engine?.version}/LICENSE`]) {
      if (!existsSync(join(whisperDir, ...file.split('/')))) findings.push(`${whisperPath}/${file} is missing`)
    }
    if (!Array.isArray(record.crates) || record.crates.length === 0) findings.push(`${whisperPath} carries no crate licence inventory`)
    for (const crate of record.crates ?? []) {
      if (crate.name === 'mercury_whisper') continue
      const licence = join(whisperDir, 'licenses', `${crate.name}-${crate.version}`)
      if (!existsSync(licence) && !existsSync(`${licence}.txt`)) findings.push(`${whisperPath} is missing the licence for ${crate.name} ${crate.version}`)
    }
  } catch (error) {
    findings.push(`${whisperPath}: the required on-device transcriber pack could not be verified (${error instanceof Error ? error.message : String(error)})`)
  }
  const packs = bundledVendorPacks(target)
  for (const pack of packs) {
    const dir = join(payloadDir, ...pack.dir.split('/'))
    for (const file of pack.files) {
      if (!existsSync(join(dir, ...file.split('/')))) findings.push(`${pack.dir}/${file} is missing`)
    }
    const recordPath = join(dir, '.vendor-manifest.json')
    if (!existsSync(recordPath)) continue
    let record
    try {
      record = JSON.parse(readFileSync(recordPath, 'utf8'))
    } catch (e) {
      findings.push(`${pack.dir}/.vendor-manifest.json does not parse: ${e instanceof Error ? e.message : String(e)}`)
      continue
    }
    if (record.platform !== pack.platform) findings.push(`${pack.dir}/.vendor-manifest.json names the platform ${record.platform}; the archive ships ${pack.platform}`)
    if (record.version !== pack.version) findings.push(`${pack.dir}/.vendor-manifest.json names ${pack.name} ${record.version}; the lock pins ${pack.version}`)
    if (record.binary !== pack.binary) findings.push(`${pack.dir}/.vendor-manifest.json names the binary ${record.binary}; the archive ships ${pack.binary}`)
    const binaryPath = join(dir, pack.binary)
    if (existsSync(binaryPath)) {
      const digest = sha256File(binaryPath)
      if (digest !== record.binarySha256) findings.push(`${pack.dir}/${pack.binary} does not match its record's sha256 (the record says ${String(record.binarySha256).slice(0, 12)}…, the bytes hash to ${digest.slice(0, 12)}…)`)
    }
  }
  return { ok: findings.length === 0, findings, packs }
}
