// ============================================================================
//  scripts/field-tasks/prove-field-packet-gen.ts — the §7 field packet's
//  deterministic floor (the macOS-side half of; the PS7 half rides
//  the windows-functional leg via prove-field-packet.ps1).
//
//  Proves, hermetically (scratch root, --allow-unbuilt, no ambient reads):
//    1. the generator materializes the complete kit + packet-manifest.json;
//    2. every manifest sha256 recomputes from the materialized bytes;
//    3. the practice task FAIL-STARTS (node --test red as shipped) and the
//       one-line reference fix turns it green — the §4.5 falsifiability
//       shape on the kit's own task;
//    4. the collector's candidate law holds textually: kit-owned globs only,
//       preview before write, -All never drops the preview output.
// ============================================================================
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '../..')
let failures = 0
const ok = (name: string, pass: boolean, detail = ''): void => {
  console.log((pass ? '  ok  ' : '  FAIL ') + name + (detail && !pass ? ' — ' + detail : ''))
  if (!pass) failures = 1
}

const scratch = mkdtempSync(join(tmpdir(), 'crucible-field-packet-'))
try {
  // 1 · generate
  const gen = spawnSync(
    process.execPath,
    [join(repoRoot, 'scripts/field-tasks/gen-field-packet.ts'), '--out', scratch, '--allow-unbuilt'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, cwd: repoRoot },
  )
  ok('generator exits 0', gen.status === 0, (gen.stderr ?? '').slice(0, 300))
  const kit = join(scratch, 'mercury-field-kit')
  const manifest = JSON.parse(readFileSync(join(kit, 'packet-manifest.json'), 'utf8')) as {
    kind: string
    taskId: string
    mercuryVersion: string
    artifactDigest: string
    files: { path: string; sha256: string }[]
  }
  ok('manifest identity', manifest.kind === 'mercury-field-kit' && manifest.taskId === 'FK1' && manifest.artifactDigest.length > 0)
  const expected = ['SETUP.md', 'CHECKLIST.md', 'ISSUE-TEMPLATE.md', 'Run-FieldKit.ps1', 'Collect-Report.ps1', 'task/TASK.md', 'task/src/ledger.mjs', 'task/test/ledger.test.mjs']
  ok(
    'kit is complete',
    expected.every(f => manifest.files.some(m => m.path === f)),
    expected.filter(f => !manifest.files.some(m => m.path === f)).join(', '),
  )

  // 2 · checksums recompute
  const bad = manifest.files.filter(f => createHash('sha256').update(readFileSync(join(kit, f.path))).digest('hex') !== f.sha256)
  ok('every sha256 recomputes', bad.length === 0, bad.map(b => b.path).join(', '))

  // 3 · the practice task fail-starts, and the reference fix greens it
  const taskDir = join(kit, 'task')
  const red = spawnSync('node', ['--test'], { cwd: taskDir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  ok('practice task FAIL-STARTS as shipped', red.status !== 0)
  const ledgerPath = join(taskDir, 'src/ledger.mjs')
  const shipped = readFileSync(ledgerPath, 'utf8')
  ok('the seeded defect is the refund sign', shipped.includes("else if (entry.kind === 'refund') total += entry.pence"))
  writeFileSync(ledgerPath, shipped.replace("else if (entry.kind === 'refund') total += entry.pence", "else if (entry.kind === 'refund') total -= entry.pence"), 'utf8')
  const green = spawnSync('node', ['--test'], { cwd: taskDir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  ok('the reference fix turns it green', green.status === 0, (green.stdout ?? '').split('\n').filter(l => l.includes('fail')).slice(0, 2).join(' · '))

  // 4 · collector candidate law (textual: kit-owned globs, preview, -All)
  const collector = readFileSync(join(repoRoot, 'scripts/field-tasks/field-kit/Collect-Report.ps1'), 'utf8')
  ok(
    'collector gathers kit-owned material only',
    collector.includes("'issue-*.md'") && collector.includes("'kit-logs'") && !collector.includes('$env:USERPROFILE') && !collector.includes('Get-ChildItem -Path /') && collector.includes('Split-Path -Parent $PSCommandPath'),
  )
  ok('collector previews before writing and supports -All without dropping the preview', collector.includes('Read-Host') && collector.includes('param([switch] $All)') && collector.includes("kept (-All)"))
  ok('collector writes the human-readable REPORT.md beside manifest.json', collector.includes("'REPORT.md'") && collector.includes("'manifest.json'"))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

if (failures) {
  console.error('prove-field-packet-gen: RED')
  process.exit(1)
}
console.log('prove-field-packet-gen: green')
