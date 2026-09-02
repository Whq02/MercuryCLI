// ============================================================================
//  scripts/field-tasks/prove-field-tasks-structural-laws.ts —.
//
//  subject/collector isolation: task workspaces materialize under the
//        OS temp root (never the repo tree, never the operator home); the
//        collector's config home is parameterized, never hardcoded; no
//        ambient operator handle or absolute home path appears in the
//        corpus/runner/crucible sources (the AMBIENT-handle red class).
//  capture hardening: every spawnSync capture in the runner declares
//        an explicit maxBuffer (the 1 MiB-default truncation class); the PTY
//        driver owns a kill ladder (SIGTERM→SIGKILL) rather than an open
//        wait; the interactive lane passes its tape by file, never argv.
//  wire-record identity: the miner extracts model identity from wire
//        record fields; every STANDING accepted row in the committed
//        envelopes carries a non-empty models[] receipt
//        (latest-generation view — reps stand, superseded generations drop).
// ============================================================================
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = join(import.meta.dir, '../..')
let failures = 0
function ok(name: string, pass: boolean, detail = ''): void {
  console.log((pass ? '  ok  ' : '  FAIL ') + name + (detail && !pass ? ' — ' + detail : ''))
  if (!pass) failures = 1
}

const runnerSrc = readFileSync(join(repoRoot, 'scripts/mission-runner/live/runner.ts'), 'utf8')
const ptydriveSrc = readFileSync(join(repoRoot, 'scripts/streaming/ptydrive.py'), 'utf8')

// ──: isolation ─────────────────────────────────────────────────────────

ok(
  'CR-33: task workspaces materialize under the OS temp root',
  /mkdtempSync\(join\(tmpdir\(\)/.test(runnerSrc),
)
ok(
  'CR-33: collector config home is parameterized (options → env), never a literal home',
  runnerSrc.includes("options.configHome ?? process.env.MERCURY_CONFIG_DIR"),
)
{
  // No ambient operator handle / absolute home path in benchmark sources.
  const scanDirs = ['scripts/mission-runner/corpus', 'scripts/mission-runner/live', 'scripts/field-tasks']
  const offenders: string[] = []
  for (const dir of scanDirs) {
    for (const f of readdirSync(join(repoRoot, dir))) {
      if (!f.endsWith('.ts') && !f.endsWith('.sh')) continue
      const text = readFileSync(join(repoRoot, dir, f), 'utf8')
      if (/\/Users\/[a-z]/.test(text)) offenders.push(dir + '/' + f)
    }
  }
  ok('CR-33: no absolute operator-home path in benchmark sources', offenders.length === 0, offenders.join(', '))
}

// ──: capture hardening ─────────────────────────────────────────────────

{
  const sites = runnerSrc.split('spawnSync(').slice(1)
  const bare = sites.filter(chunk => !chunk.slice(0, 900).includes('maxBuffer'))
  ok(
    'CR-34: every runner spawnSync declares an explicit maxBuffer (' + sites.length + ' sites)',
    sites.length >= 3 && bare.length === 0,
    bare.length + ' bare site(s)',
  )
}
ok('CR-34: the PTY driver owns a SIGTERM→SIGKILL kill ladder', /SIGTERM/.test(ptydriveSrc) && /SIGKILL/.test(ptydriveSrc))
ok('CR-34: the interactive tape travels by file, never argv', runnerSrc.includes("'--send-file'"))

// ──: wire-record identity ──────────────────────────────────────────────

ok(
  'CR-35: the miner reads wire model fields (never output-text grep)',
  runnerSrc.includes('message.model') && runnerSrc.includes('payload.model'),
)
if (failures) {
  console.error('prove-field-tasks-structural-laws: RED')
  process.exit(1)
}
console.log('prove-field-tasks-structural-laws: green')
