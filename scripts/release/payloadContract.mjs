import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DOC_SET = ['README-FIRST.md', 'INSTALLING.md', 'UPDATING.md', 'RELEASE-NOTES.md', 'NOTICES.md', 'LICENSE.md', 'TRADEMARKS.md', 'MERCURY-COMMUNITY-PRODUCTION-TERMS.md']

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
  const isWin = target === 'windows-x64'
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

export const launcherFor = target => (target === 'windows-x64' ? 'mercury.cmd' : 'mercury')

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
  if (target !== 'windows-x64') return []
  const lock = readShellEngineLock()
  const entry = lock.platforms['win-x64']
  return [
    {
      name: lock.name,
      version: lock.version,
      platform: 'win-x64',
      binary: 'brush.exe',
      degradation: 'shell-engine',
      manifestKey: 'shellEngine',
      dir: 'vendor/brush/win-x64',
      files: ['brush.exe', '.vendor-manifest.json', 'NOTICES.json', `licenses/${entry.crate}-${entry.crateVersion}/LICENSE`],
    },
  ]
}

export function checkBundledVendorPacks(payloadDir, target) {
  const findings = []
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
