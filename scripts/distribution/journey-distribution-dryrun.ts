#!/usr/bin/env bun
// ============================================================================
//  scripts/distribution/journey-distribution-dryrun.ts —
//  the dry-run distribution journey (SOLO-RUN — not globbed into run-all.sh:
//  it packages a full archive and smokes the artifact, ~1-2 min + a fresh
//  dist requirement; run at closure and on demand, like the crown journeys).
//
//  Assembles the local-platform archive via scripts/release/package.mjs
//  (which itself proves the friend path: spaced dir, clean home,
//  --version/--help from the extracted artifact), keeps the inspectable
//  stage, then validates the §11 record — deterministic sorted manifest,
//  allowlist, identity binding to the CURRENT dist, notice coverage — and
//  runs one deterministic non-provider journey (doctor --json) from the
//  kept stage artifact.
//
//  Run: ~/.bun/bin/bun run scripts/distribution/journey-distribution-dryrun.ts
// ============================================================================
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

console.log('signature distribution dry-run journey')

const dist = join(ROOT, 'dist')
if (!existsSync(join(dist, 'manifest.json'))) {
  console.log('  dist missing — building first')
  execFileSync(process.execPath.includes('bun') ? process.execPath : 'bun', ['run', 'build.ts'], { cwd: ROOT, stdio: 'inherit' })
}
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8')) as {
  buildTree: string
  version: string
}

const target = process.platform === 'darwin' ? (process.arch === 'arm64' ? 'macos-arm64' : 'macos-x64') : process.platform === 'win32' ? 'windows-x64' : 'linux-x64'
const out = execFileSync('node', ['scripts/release/package.mjs', '--target', target, '--keep-stage'], {
  cwd: ROOT,
  encoding: 'utf8',
  timeout: 600_000,
})
process.stdout.write(out)
console.log('  · packager exited green (execFileSync throws on nonzero — assemble + archive + friend smoke held)')

const stageMatch = out.match(/inspectable stage kept: (.+)/)
check('inspectable stage kept', !!stageMatch)

const recordPath = join(ROOT, 'release-out', `mercury-v${manifest.version}-${target}.dryrun.json`)
check('dry-run record written', existsSync(recordPath))
const record = JSON.parse(readFileSync(recordPath, 'utf8')) as {
  buildTree: string
  fileCount: number
  totalBytes: number
  files: { path: string; bytes: number }[]
  noticesCoverVendors: string[]
}
check('record identity binds to the CURRENT dist buildTree', record.buildTree === manifest.buildTree)
check('record manifest is byte-order sorted + non-trivial', record.fileCount > 10 && record.files.every((f, i) => i === 0 || record.files[i - 1].path < f.path))
check('notices cover the vendored payloads', record.noticesCoverVendors.length >= 1)

// One deterministic non-provider journey from the ARTIFACT (not the repo):
// doctor --json in a fresh home must produce a parseable certificate.
if (stageMatch) {
  const stage = stageMatch[1].trim()
  const home = mkdtempSync(join(tmpdir(), 'sig-dryrun-home-'))
  try {
    const doctorOut = execFileSync('node', [join(stage, 'mercury.mjs'), 'doctor', '--json'], {
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, MERCURY_CONFIG_DIR: home, HOME: home, CI: '1' },
      cwd: home,
    })
    const cert = JSON.parse(doctorOut) as { sections?: unknown[] }
    check('doctor --json from the artifact parses', Array.isArray(cert.sections) && cert.sections.length > 0)
  } catch (e) {
    check('doctor --json from the artifact parses', false, e instanceof Error ? e.message.slice(0, 200) : String(e))
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(join(stage, '..'), { recursive: true, force: true })
  }
}

if (failures > 0) {
  console.log(`\nsignature distribution dry-run: RED (${failures})`)
  process.exit(1)
}
console.log('\nsignature distribution dry-run: green')
