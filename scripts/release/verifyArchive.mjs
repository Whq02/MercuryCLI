#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkReleaseDocuments } from './releaseDocuments.mjs'

const args = process.argv.slice(2)
const opt = name => {
  const i = args.indexOf(name)
  return i !== -1 && args[i + 1] ? args[i + 1] : null
}
const archive = opt('--archive')
const expect = opt('--expect')
const root = resolve(opt('--root') ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'))
const version = opt('--version') ?? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
if (!archive || !existsSync(archive) || !['signed', 'unsigned'].includes(expect)) {
  console.error('usage: node scripts/release/verifyArchive.mjs --archive <file> --expect signed|unsigned [--root <tree>] [--version <v>]')
  process.exit(2)
}

const fail = msg => {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

const scratch = mkdtempSync(join(tmpdir(), 'mercury-verify-archive-'))
try {
  if (archive.endsWith('.zip')) {
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

  const docs = checkReleaseDocuments({ root, version, archiveDir: payload })
  if (!docs.ok) fail(`the archive's licence documents: ${docs.findings.join('; ')}`)
  console.log(`${basename(archive)}: LICENSE.md (${docs.parameters.version}, released ${docs.parameters.releaseDate}), TRADEMARKS.md and the production terms ride verbatim; the terms hash the licence states`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
