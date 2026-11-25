#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { checkBundledVendorPacks, checkJsonQueryPack, unsignedArchiveName } from './payloadContract.mjs'
import { checkReleaseDocuments } from './releaseDocuments.mjs'
import { checkWindowsLauncher } from './windowsLauncher.mjs'

const args = process.argv.slice(2)
const opt = name => {
  const i = args.indexOf(name)
  return i !== -1 && args[i + 1] ? args[i + 1] : null
}
const expect = opt('--expect')
const root = resolve(opt('--root') ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'))
const version = opt('--version') ?? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const usage = () => {
  console.error('usage: node scripts/release/verifyArchive.mjs (--target <release target> | --archive <file>) --expect signed|unsigned [--root <tree>] [--version <v>]')
  process.exit(2)
}
if (!['signed', 'unsigned'].includes(expect)) usage()
let archive = opt('--archive')
const target = opt('--target')
if (archive === null && target === null) usage()
const built = join(root, 'dist', 'verify-artifact.mjs')
if (!existsSync(built)) {
  console.error(`✗ ${built} is missing — the archive name and the updater's archive check are read from the built library (run bun run build.ts first)`)
  process.exit(2)
}
const owner = await import(pathToFileURL(built).href)
if (archive === null) {
  if (!owner.isReleaseTarget(target)) {
    console.error(`✗ --target wants one of ${owner.RELEASE_TARGETS.join(', ')} (got ${target})`)
    process.exit(2)
  }
  const signedName = owner.archiveNameFor(version, target)
  archive = join(root, 'release-out', expect === 'unsigned' ? unsignedArchiveName(signedName) : signedName)
}

const fail = msg => {
  console.error(`✗ ${msg}`)
  process.exit(1)
}
if (!existsSync(archive)) fail(`no archive at ${archive} — package first (node scripts/release/package.mjs --target <target>${expect === 'unsigned' ? ' --unsigned' : ''})`)

const signaturePath = `${archive}.sig`
if (expect === 'unsigned' && existsSync(signaturePath)) fail(`${basename(archive)} is unsigned by decision and ${basename(signaturePath)} stands beside it — nothing may publish`)
if (expect === 'signed') {
  if (!existsSync(signaturePath)) fail(`${basename(archive)} has no ${basename(signaturePath)} beside it — every updater from the first signed version on refuses an archive without its signature; nothing may publish`)
  const own = owner.verifyArchiveSignature(readFileSync(signaturePath, 'utf8'), basename(archive), createHash('sha256').update(readFileSync(archive)).digest('hex'), owner.trustedSigningKeys())
  if (own.state !== 'signed') fail(`${basename(signaturePath)} verifies as '${own.state}'${own.state === 'unrecognized-key' ? ` (key ${own.keyId})` : `: ${own.note}`} — an installed updater would refuse this archive; nothing may publish`)
  console.log(`${basename(signaturePath)}: signed by key ${own.keyId} (${own.keyLabel}) over the archive's name and SHA-256`)
}

const read = await owner.checkArchiveBeforeUnpack(archive, archive.endsWith('.zip') ? 'zip' : 'tar.gz', owner.updateCeilings())
if (read.state !== 'ok') fail(`${basename(archive)}: an installed updater would refuse this archive: ${read.state === 'refused' ? read.reason : read.note} — nothing may publish`)
console.log(`${basename(archive)}: an installed updater's archive check passes (${read.entries} entries)`)

const scratch = mkdtempSync(join(tmpdir(), 'mercury-verify-archive-'))
try {
  if (archive.endsWith('.zip') && process.platform !== 'win32') {
    execFileSync('unzip', ['-q', archive, '-d', scratch], { stdio: 'pipe' })
  } else if (archive.endsWith('.zip')) {
    const pwsh = ['pwsh', 'powershell'].find(exe => spawnSync(exe, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { stdio: 'pipe', timeout: 30_000 }).status === 0)
    if (!pwsh) fail('no PowerShell available (pwsh or powershell) — required to extract a zip archive')
    execFileSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:MVER_SRC -DestinationPath $env:MVER_DEST -Force'], {
      stdio: 'pipe',
      env: { ...process.env, MVER_SRC: archive, MVER_DEST: scratch },
    })
  } else {
    execFileSync('tar', ['-xzf', archive, '-C', scratch], { stdio: 'pipe' })
  }
  const payload = join(scratch, 'mercury')
  const verifier = join(payload, 'verify-artifact.mjs')
  if (!existsSync(verifier)) fail(`${basename(archive)} carries no verify-artifact.mjs — not a release archive`)

  const run = spawnSync(process.execPath, [verifier, '--json', '--deep'], { encoding: 'utf8', timeout: 300_000 })
  let result
  try {
    result = JSON.parse(run.stdout)
  } catch {
    fail(`the shipped verifier printed no verdict (exit ${run.status}): ${(run.stderr || run.stdout).slice(0, 300)}`)
  }
  const verdict = result.verdict
  const said = verdict.state === 'signed'
    ? `signed by key ${verdict.keyId} (${verdict.keyLabel}) — ${verdict.statement.version} ${verdict.statement.target}, packaged ${verdict.statement.packagedAt}`
    : verdict.state + (verdict.note ? ` — ${verdict.note}` : '') + (verdict.keyId ? ` (key ${verdict.keyId})` : '')
  console.log(`${basename(archive)}: ${said} (deep, exit ${run.status})`)
  if (verdict.state !== expect) fail(`expected the verdict '${expect}', the archive verifies as '${verdict.state}' — nothing may publish`)

  const docs = checkReleaseDocuments({ root, archiveDir: payload })
  if (!docs.ok) fail(`the archive's licence documents: ${docs.findings.join('; ')}`)
  console.log(`${basename(archive)}: Apache License 2.0 — LICENSE.md; NOTICE; TRADEMARKS.md`)

  const shipped = JSON.parse(readFileSync(join(payload, 'manifest.json'), 'utf8'))
  const shippedTarget = shipped.target && typeof shipped.target === 'object' && typeof shipped.target.release === 'string' ? shipped.target.release : target
  if (shippedTarget?.startsWith('windows-')) {
    const exe = checkWindowsLauncher(join(payload, 'mercury.exe'), shippedTarget)
    const member = shipped.releaseLayout?.members?.find(m => m.path === 'mercury.exe')
    if (!member || member.role !== 'launcher' || member.bytes !== exe.bytes || member.sha256 !== exe.sha256) fail('mercury.exe does not match its releaseLayout member')
    console.log(`${basename(archive)}: mercury.exe is a ${shippedTarget} console PE image (${exe.bytes} bytes)`)
  }
  const query = checkJsonQueryPack(payload)
  if (!query.ok) fail(`the archive's JSON query engine: ${query.findings.join('; ')}`)
  console.log(`${basename(archive)}: jq-wasm ${query.version} and its licences match the pinned pack`)
  const bundled = checkBundledVendorPacks(payload, shippedTarget)
  if (!bundled.ok) fail(`the archive's bundled packs: ${bundled.findings.join('; ')}`)
  for (const pack of bundled.packs) console.log(`${basename(archive)}: bundled ${pack.name} ${pack.version} rides at ${pack.dir} — ${pack.binary}, its record and its licence files, the binary's digest matching the record`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
