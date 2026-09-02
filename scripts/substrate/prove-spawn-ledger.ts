// ============================================================================
// prove-spawn-ledger — the post-incident spawn-provenance layer.
// Hermetic: MERCURY_CONFIG_DIR is pointed at a scratch dir (the resolver's
// memoize is keyed on the env pair, so this re-resolves per set). Unit legs
// exercise the module; anchor legs pin that every spawn chokepoint actually
// calls it (the wiring, not just the library).
// ============================================================================
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const home = mkdtempSync(join(tmpdir(), 'spawn-ledger-proof-'))
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_SPAWN_LEDGER
delete process.env.MERCURY_SPAWN_AUDIT
delete process.env.MERCURY_SPAWNED_BY

const led = await import('../../src/utils/spawnLedger.ts')

console.log('— unit: ledger writes —')
led.recordSpawn({ kind: 'headless', id: 'proof-1', cwd: home })
const ledgerPath = join(home, 'spawn-ledger.jsonl')
check('recordSpawn appends to spawn-ledger.jsonl', existsSync(ledgerPath))
const row = JSON.parse(readFileSync(ledgerPath, 'utf8').trim().split('\n')[0])
check(
  'row carries ts/kind/id/cwd/spawnedBy',
  Boolean(row.ts) && row.kind === 'headless' && row.id === 'proof-1' && row.cwd === home &&
    row.spawnedBy === 'operator-session' && row.spawnerPid === process.pid,
)

console.log('— unit: exit/reap rows (spawn AND exit are lookups) —')
led.recordSpawnExit({ kind: 'headless', event: 'exit', id: 'proof-1', pid: 4242, code: 0, outcome: 'ok' })
led.recordSpawnExit({ kind: 'long-lived', event: 'reap', id: 'proof-w', reason: 'daemon-shutdown:SIGTERM' })
{
  const rows = readFileSync(ledgerPath, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  const exit = rows.find(r => r.event === 'exit')
  const reap = rows.find(r => r.event === 'reap')
  check(
    'exit row pairs with the spawn row by id and carries code/outcome',
    exit && exit.kind === 'headless' && exit.id === 'proof-1' && exit.code === 0 && exit.outcome === 'ok',
  )
  check(
    'reap row carries the spawner-side reason',
    reap && reap.kind === 'long-lived' && reap.reason === 'daemon-shutdown:SIGTERM',
  )
  process.env.MERCURY_SPAWN_LEDGER = '0'
  led.recordSpawnExit({ kind: 'headless', event: 'exit', id: 'proof-off', code: 1 })
  check(
    'MERCURY_SPAWN_LEDGER=0 disables exit rows too',
    readFileSync(ledgerPath, 'utf8').trim().split('\n').length === rows.length,
  )
  delete process.env.MERCURY_SPAWN_LEDGER
}

console.log('— unit: dead-cwd refusal —')
check('assertSpawnCwd refuses a missing dir', led.assertSpawnCwd('/nonexistent/spawn-proof-xyz').ok === false)
check('assertSpawnCwd allows undefined (inherit spawner cwd)', led.assertSpawnCwd(undefined).ok === true)
check('assertSpawnCwd allows an existing dir', led.assertSpawnCwd(home).ok === true)

console.log('— unit: provenance stamp —')
check('spawnedByStamp is kind:id#pid', new RegExp(`^daemon-tank:x#${process.pid}$`).test(led.spawnedByStamp('daemon-tank', 'x')))

console.log('— unit: autonomous-only bash audit —')
const auditPath = join(home, 'bash-audit.jsonl')
led.recordBashAudit('echo operator', 0, false)
check('operator sessions never write bash-audit.jsonl', !existsSync(auditPath))
process.env.MERCURY_SPAWNED_BY = 'proof:me#1'
led.recordBashAudit('echo spawned', 0, false)
check('spawned children (MERCURY_SPAWNED_BY) do write it', existsSync(auditPath))
const audit = JSON.parse(readFileSync(auditPath, 'utf8').trim().split('\n')[0])
check('audit row carries spawnedBy/command/exit', audit.spawnedBy === 'proof:me#1' && audit.command === 'echo spawned' && audit.exitCode === 0)
process.env.MERCURY_SPAWN_AUDIT = '0'
led.recordBashAudit('echo off', 0, false)
check('MERCURY_SPAWN_AUDIT=0 disables the trail', readFileSync(auditPath, 'utf8').trim().split('\n').length === 1)
delete process.env.MERCURY_SPAWN_AUDIT
delete process.env.MERCURY_SPAWNED_BY

console.log('— unit: ledger off-switch —')
{
  const before = readFileSync(ledgerPath, 'utf8').trim().split('\n').length
  process.env.MERCURY_SPAWN_LEDGER = '0'
  led.recordSpawn({ kind: 'headless', id: 'proof-2', cwd: home })
  check(
    'MERCURY_SPAWN_LEDGER=0 disables the ledger',
    readFileSync(ledgerPath, 'utf8').trim().split('\n').length === before,
  )
  delete process.env.MERCURY_SPAWN_LEDGER
}

console.log('— anchors: every chokepoint calls the module —')
const ROOT = join(import.meta.dir, '..', '..')
const src = (p: string) => readFileSync(join(ROOT, p), 'utf8')
check('roster.spawnLongLived gates on assertSpawnCwd (dead cwd ⇒ degrade, no respawn loop)',
  src('src/daemon/roster.ts').includes('assertSpawnCwd(ll.spec.cwd)'))
check('roster refusal is ledgered as long-lived-refused',
  src('src/daemon/roster.ts').includes("kind: 'long-lived-refused'"))
check('headlessRun stamps MERCURY_SPAWNED_BY on long-lived children',
  src('src/daemon/headlessRun.ts').includes('spawnedByStamp(`daemon-'))
check('headlessRun ledgers per-fire headless runs',
  src('src/daemon/headlessRun.ts').includes("recordSpawn({ kind: 'headless'"))
check('spawnMultiAgent refuses dead teammate cwds on BOTH backends',
  (src('src/tools/shared/spawnMultiAgent.ts').match(/assertSpawnCwd\(workingDir\)/g) || []).length >= 2)
check('BashTool records the autonomous command audit',
  src('src/tools/BashTool/BashTool.tsx').includes('recordBashAudit(input.command'))
check('doctor carries the team-rosters dead-cwd check',
  src('src/utils/healthReport.ts').includes("id: 'team-rosters'"))
// Three closed gaps stay closed:
check('teammates carry the spawned-by stamp on BOTH tmux backends, both spellings (bash-audit + delete-ward arm)',
  (src('src/tools/shared/spawnMultiAgent.ts').match(/flagSpellings\(SPAWNED_BY_ENV\)\.map\(sp => `\$\{sp\}=\$\{quote\(\[spawnedByStamp\('teammate', teammateId\)\]\)\}`\)/g) || []).length >= 2)
check('headless one-shot runs gate on assertSpawnCwd (dead scheduled cwd ⇒ loud refusal)',
  src('src/daemon/headlessRun.ts').includes('assertSpawnCwd(dir)'))
check('headless refusal is ledgered as headless-refused',
  src('src/daemon/headlessRun.ts').includes("kind: 'headless-refused'"))

console.log('— unit: forensics hermetic seam (gate runs must not pollute the real trail) —')
const seamDir = mkdtempSync(join(tmpdir(), 'spawn-ledger-seam-'))
process.env.MERCURY_DAEMON_DIR = seamDir
led.recordSpawn({ kind: 'headless', id: 'seam-proof', cwd: home })
check('MERCURY_DAEMON_DIR routes spawn-ledger rows to the seam dir',
  existsSync(join(seamDir, 'spawn-ledger.jsonl')))
check('the config-home ledger stays untouched under the seam',
  !readFileSync(ledgerPath, 'utf8').includes('seam-proof'))
delete process.env.MERCURY_DAEMON_DIR
rmSync(seamDir, { recursive: true, force: true })

console.log('')
if (failures > 0) {
  console.log(`❌ ${failures} SPAWN-LEDGER PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL SPAWN-LEDGER PROOFS PASS')
