// ============================================================================
// prove-daemon-reconcile — a TERMINATED supervisor's on-disk
// records reconcile at the next boot, conservatively, with ONE receipt.
//
// On win32 a TerminateProcess'd daemon fires NO signal and NO 'exit' event, so
// supervisor.json, supervisor.lock, control.key and the project's
// old daemon records survive as stale debris that nothing organically
// reconciles (field-proven: 19 clean 1.5.2 runs, byte-identical mtimes).
//
// Hermetic: MERCURY_CONFIG_DIR + MERCURY_DAEMON_DIR point at scratch dirs BEFORE
// any product import (the ambient-state law). Legs:
//   §1 reconcileDaemonRecords behavior — seeded-dead cleanup (G12), live
//      conservatism (G13), clean home, idempotence;
//   §2 runBootRecovery integration (the daemon-records step + report field);
//   §3 supervisorExitTeardownSync — the sync process-exit backstop;
//   §4 wiring + policy anchors — main.ts exit backstop + shutdown reap rows +
//      loop-stop outcome row, doctor reconcile, orchestrator step, the
//      ownedDaemon bounded log rotation (G14), the worker parent-watch stamp.
// ============================================================================
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// ── hermetic homes BEFORE imports ───────────────────────────────────────────
const home = mkdtempSync(join(tmpdir(), 'daemon-reconcile-home-'))
const daemonScratch = join(home, 'daemon')
const projectDir = mkdtempSync(join(tmpdir(), 'daemon-reconcile-proj-'))
mkdirSync(daemonScratch, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = daemonScratch
delete process.env.MERCURY_SPAWN_LEDGER

const { reconcileDaemonRecords } = await import('../../src/daemon/reconcileRecords.ts')
const controlSocket = await import('../../src/daemon/controlSocket.ts')
const ledger = await import('../../src/utils/spawnLedger.ts')

// A REAL dead pid: spawn-and-wait a trivial child, then use its pid.
const deadPid = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' }).pid as number
if (!deadPid || deadPid <= 1) {
  console.error('could not mint a dead pid — cannot run this proof')
  process.exit(1)
}

const supPath = controlSocket.supervisorStatePath()
const lockPath = join(daemonScratch, 'supervisor.lock')
const keyPath = join(daemonScratch, 'control.key')
// (The old per-project scheduler lock died with its engine;
// the reconcile sweeps the daemon's own three artifacts only.)

function seedDeadRecords(pid: number, startedAt = Date.now() - 60_000): void {
  mkdirSync(daemonScratch, { recursive: true })
  writeFileSync(
    supPath,
    JSON.stringify({
      pid,
      version: '0.0.0-proof',
      origin: 'transient',
      startedAt,
      dir: projectDir,
      controlSock: join(daemonScratch, 'control.sock'),
    }),
  )
  writeFileSync(lockPath, JSON.stringify({ owner: 'proof-sup', pid, acquiredAt: Date.now() - 60_000 }))
  writeFileSync(keyPath, 'deadbeef'.repeat(8))
}

console.log('— §1 reconcileDaemonRecords behavior —')

// G12: seeded confirmed-dead records reconcile with one receipt.
seedDeadRecords(deadPid)
const dead = await reconcileDaemonRecords({ projectDir })
check('seeded-dead ⇒ state reconciled', dead.state === 'reconciled', JSON.stringify(dead))
check('supervisor.json removed', !existsSync(supPath))
check('supervisor.lock removed', !existsSync(lockPath))
check('control.key removed', !existsSync(keyPath))
check(
  'receipt names all three artifacts',
  dead.cleaned.length === 3 &&
    ['supervisor.json', 'supervisor.lock', 'control.key'].every(n =>
      dead.cleaned.includes(n),
    ),
  dead.cleaned.join(','),
)
check('receipt carries the dead pid', dead.deadPid === deadPid)

// Idempotence: a second pass over reconciled state is a clean no-op.
const again = await reconcileDaemonRecords({ projectDir })
check('second pass ⇒ clean (idempotent)', again.state === 'clean' && again.cleaned.length === 0)

// G13: ANY liveness signal ⇒ hands off everything (pid-alive supervisor.json
// whose identity is consistent — a record stamped NOW reads born-at-or-before
// under the union's fallback arm, the same hand-off the old pid-only gate
// gave; the recycled shapes are §1b's legs).
seedDeadRecords(process.pid, Date.now())
const live = await reconcileDaemonRecords({ projectDir })
check('live supervisor pid ⇒ state live, nothing touched', live.state === 'live' && live.cleaned.length === 0)
check('live: supervisor.json intact', existsSync(supPath))
check('live: control.key intact', existsSync(keyPath))
check('live: supervisor.lock intact', existsSync(lockPath))

// §1b — THE IDENTITY-MATCHED RECORD GATE (the
// vocabulary: getProcessStartToken + ownerIdentityMatches, never a second
// liveness test): pid-alive alone is not "the daemon" — a RECYCLED pid
// (alive, wrong start token) is judged dead, so a dead daemon's trio cannot
// survive every boot on a fast-recycling box. The recycled shape is minted
// with OUR OWN live pid under a WRONG recorded baseline — no second process
// needed. The lock naming the SAME disproved pid falls with the record; a
// lock naming any OTHER live pid keeps the conservative veto whole.
{
  const seedIdentity = (lockPid: number): void => {
    mkdirSync(daemonScratch, { recursive: true })
    writeFileSync(
      supPath,
      JSON.stringify({
        pid: process.pid,
        version: '0.0.0-proof',
        origin: 'transient',
        startedAt: Date.now() - 60_000,
        dir: projectDir,
        controlSock: join(daemonScratch, 'control.sock'),
        startToken: 'not-this-process-token (the recycled shape)',
      }),
    )
    writeFileSync(lockPath, JSON.stringify({ owner: 'proof-sup', pid: lockPid, acquiredAt: Date.now() - 60_000 }))
    writeFileSync(keyPath, 'deadbeef'.repeat(8))
  }
  seedIdentity(process.pid)
  const recycled = await reconcileDaemonRecords({ projectDir })
  check(
    'POISON (the immortal stale trio): a live pid under a WRONG recorded start token is judged recycled ⇒ reconciled',
    recycled.state === 'reconciled' && ['supervisor.json', 'supervisor.lock', 'control.key'].every(n => recycled.cleaned.includes(n)),
    JSON.stringify(recycled),
  )
  check('the receipt names the recycled verdict, not "not running"', recycled.reason.includes('recycled') && recycled.reason.includes('start-token mismatch'), recycled.reason)
  check('recycled sweep: files gone', !existsSync(supPath) && !existsSync(lockPath) && !existsSync(keyPath))
  // The conservative veto stands for a lock holder the token did NOT
  // disprove: a DIFFERENT live pid on the lock reads live, nothing touched.
  const otherLivePid = process.ppid
  if (otherLivePid && otherLivePid > 1) {
    seedIdentity(otherLivePid)
    const vetoed = await reconcileDaemonRecords({ projectDir })
    check('a DIFFERENT live lock-holder pid still vetoes (the mid-boot hand-off is whole)', vetoed.state === 'live' && vetoed.cleaned.length === 0, JSON.stringify(vetoed))
    check('vetoed: records intact', existsSync(supPath) && existsSync(lockPath) && existsSync(keyPath))
    rmSync(supPath, { force: true })
    rmSync(lockPath, { force: true })
    rmSync(keyPath, { force: true })
  }
  // THE FALLBACK ARM through the union (the D-convergence ruling): a record
  // with NO usable baseline (pre-token, or a boot whose probe answered
  // null) takes the verifier's birth-time judgment. Our own live process
  // against a record stamped 60s in the past reads born-AFTER ⇒ recycled ⇒
  // swept — the arm the old blanket-conservative pass could never reach.
  writeFileSync(
    supPath,
    JSON.stringify({ pid: process.pid, version: '0.0.0-proof', origin: 'transient', startedAt: Date.now() - 60_000, dir: projectDir, controlSock: join(daemonScratch, 'control.sock'), startToken: null }),
  )
  const fallbackRecycled = await reconcileDaemonRecords({ projectDir })
  check('a baseline-less record + a process born after its stamp ⇒ the fallback arm judges recycled ⇒ reconciled', fallbackRecycled.state === 'reconciled' && fallbackRecycled.reason.includes('recycled'), JSON.stringify(fallbackRecycled))
  // …and a record stamped NOW (our process was born at-or-before it) is the
  // recorded daemon under the same fallback — the conservative hand-off.
  writeFileSync(
    supPath,
    JSON.stringify({ pid: process.pid, version: '0.0.0-proof', origin: 'transient', startedAt: Date.now(), dir: projectDir, controlSock: join(daemonScratch, 'control.sock') }),
  )
  const fallbackSame = await reconcileDaemonRecords({ projectDir })
  check('a pre-token record + a process born at-or-before its stamp ⇒ the recorded daemon ⇒ live hand-off', fallbackSame.state === 'live' && fallbackSame.cleaned.length === 0, JSON.stringify(fallbackSame))
  rmSync(supPath, { force: true })
}

// A live supervisor.LOCK holder alone (no supervisor.json) also reads live —
// the mid-boot window (lock acquired before the state record is written).
// (Seeded explicitly: the legacy mixed-scheduler leg that used to leave a
// lock behind died with the old engine.)
rmSync(supPath, { force: true })
writeFileSync(lockPath, JSON.stringify({ owner: 'proof-midboot', pid: process.pid, acquiredAt: Date.now() }))
const midBoot = await reconcileDaemonRecords({ projectDir })
check('live lock holder alone ⇒ live (mid-boot conservatism)', midBoot.state === 'live' && midBoot.cleaned.length === 0)
rmSync(lockPath, { force: true })
rmSync(keyPath, { force: true })

// Clean home: nothing on disk ⇒ 'clean'.
const clean = await reconcileDaemonRecords({ projectDir })
check('empty home ⇒ clean', clean.state === 'clean' && clean.cleaned.length === 0)

// Orphan control.key ALONE (the clean-shutdown residue class) is reconciled.
writeFileSync(keyPath, 'deadbeef'.repeat(8))
const keyOnly = await reconcileDaemonRecords({ projectDir })
check('orphan control.key alone ⇒ reconciled', keyOnly.state === 'reconciled' && keyOnly.cleaned.includes('control.key'))

console.log('— §2 runBootRecovery integration —')
const orchestrator = await import('../../src/substrate/recoveryOrchestrator.ts')
orchestrator._resetBootRecoveryForTests()
seedDeadRecords(deadPid)
const report = await orchestrator.runBootRecovery({ scope: 'daemon', projectDir })
check('report carries the daemonRecords step', report.daemonRecords !== null && report.daemonRecords !== undefined)
check(
  'boot recovery reconciled the seeded records',
  report.daemonRecords?.state === 'reconciled' && (report.daemonRecords?.cleaned.length ?? 0) === 3,
  JSON.stringify(report.daemonRecords),
)
check('boot recovery: files gone', !existsSync(supPath) && !existsSync(keyPath) && !existsSync(lockPath))
check(
  'status line reports the reconcile',
  (orchestrator.bootRecoveryStatusLine(orchestrator.getBootRecovery())?.text ?? '').includes('daemon record'),
)

console.log('— §3 supervisorExitTeardownSync (the sync exit backstop) —')
// Fix 3 / SB-: the
// exit backstop unlinks ONLY records THIS process owns — a dying
// predecessor racing a successor's fresh bind must never delete the
// successor's live plane. Owned records (our pid) still tear down; foreign
// records (any other pid — dead ones belong to boot recovery) survive.
seedDeadRecords(process.pid)
controlSocket.supervisorExitTeardownSync('proof-exit')
check('sync teardown removes OWNED supervisor.json', !existsSync(supPath))
check('sync teardown removes OWNED control.key', !existsSync(keyPath))
check('sync teardown removes OWNED supervisor.lock', !existsSync(lockPath))
seedDeadRecords(deadPid)
controlSocket.supervisorExitTeardownSync('proof-exit-foreign')
check('sync teardown LEAVES a foreign supervisor.json (the phone-line law)', existsSync(supPath))
check('sync teardown LEAVES a foreign control.key', existsSync(keyPath))
rmSync(supPath, { force: true })
rmSync(keyPath, { force: true })
rmSync(lockPath, { force: true })
const ledgerPath = join(daemonScratch, 'spawn-ledger.jsonl')
const rows = existsSync(ledgerPath)
  ? readFileSync(ledgerPath, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  : []
check(
  'sync teardown ledgers a supervisor exit row',
  rows.some(r => r.kind === 'supervisor' && r.event === 'exit' && r.reason === 'proof-exit'),
  `${rows.length} row(s)`,
)

// §3b — THE DEATH NAMES ITSELF (TASK-017 F-3: the box's current-build daemon
// died silently at +100s, exit 1, record left, NOTHING on stderr — every
// deliberate daemon exit road prints, so a wordless death is an exit that
// bypassed them all). The exit-before-teardown backstop now writes ONE
// stderr line naming the code and the sweep verdict — the
// discriminator: line present = a voluntary exit (--trace-exit names the
// site); line absent = an abrupt kill (the event log's jurisdiction).
{
  seedDeadRecords(process.pid, Date.now())
  const written: string[] = []
  const realWrite = process.stderr.write.bind(process.stderr)
  ;(process.stderr as unknown as { write: (chunk: unknown) => boolean }).write = (chunk: unknown): boolean => {
    written.push(String(chunk))
    return true
  }
  try {
    controlSocket.supervisorExitTeardownSync('exit-before-teardown', 1)
  } finally {
    ;(process.stderr as unknown as { write: typeof realWrite }).write = realWrite
  }
  const line = written.join('')
  check('the bypassed-roads death writes its one honest line with the code', line.includes('[daemon] exit (code 1) WITHOUT a shutdown road'))
  check('the line carries the sweep verdict and the site-naming probe', line.includes('records swept') && line.includes('--trace-exit'))
  const ledgerRows = readFileSync(ledgerPath, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  check('the ledger row keeps the plain reason when the sweep succeeded', ledgerRows.some(r => r.kind === 'supervisor' && r.reason === 'exit-before-teardown'))
  // POISON (the wordless graceful path): an ORDINARY teardown reason writes
  // NO stderr line — the honest line is for bypassed roads only, so a clean
  // daemon exit stays exactly as quiet as it was.
  seedDeadRecords(process.pid, Date.now())
  const writtenQuiet: string[] = []
  ;(process.stderr as unknown as { write: (chunk: unknown) => boolean }).write = (chunk: unknown): boolean => {
    writtenQuiet.push(String(chunk))
    return true
  }
  try {
    controlSocket.supervisorExitTeardownSync('proof-quiet')
  } finally {
    ;(process.stderr as unknown as { write: typeof realWrite }).write = realWrite
  }
  check('an ordinary teardown reason stays wordless (the line is for bypassed roads only)', writtenQuiet.join('') === '')
  check(
    'the daemon hands the exit code into the backstop',
    readFileSync(join(import.meta.dir, '..', '..', 'src', 'daemon', 'main.ts'), 'utf8').includes(
      "supervisorExitTeardownSync('exit-before-teardown', code)",
    ),
  )
}

console.log('— §4 wiring + policy anchors —')
const ROOT = join(import.meta.dir, '..', '..')
const src = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const mainTs = src('src/daemon/main.ts')
check(
  'daemonRun arms the process-exit sync backstop',
  mainTs.includes("process.once('exit'") && mainTs.includes('supervisorExitTeardownSync('),
)
check('daemonRun passes projectDir into boot recovery', mainTs.includes("scope: 'daemon', projectDir"))
check(
  'shutdown reap ledgers un-observed worker exits (reap rows)',
  mainTs.includes("event: 'reap'"),
)
// (The loop-stop outcome-row needle retired with its engine;
// the ticker's fire decisions row per-session receipts, pinned in
// scripts/daemon/prove-saturn-core.ts §F.)
check(
  'clean shutdown clears control.key beside the supervisor record',
  mainTs.includes('clearControlKey('),
)
const rosterTs = src('src/daemon/roster.ts')
check(
  'roster handleCrash ledgers long-lived exit rows (all dispositions)',
  (rosterTs.match(/ledgerExit\(/g) || []).length >= 4 && rosterTs.includes('recordSpawnExit'),
)
const headlessTs = src('src/daemon/headlessRun.ts')
check('headless settle ledgers an exit row', headlessTs.includes('recordSpawnExit'))
check(
  'doctor daemon row runs the reconcile (verb-path cleanup)',
  src('src/utils/healthReport.ts').includes('reconcileDaemonRecords'),
)
check(
  'ownedDaemon keeps the bounded daemon.log rotation (G14: logs are records, never debris)',
  src('src/daemon/ownedDaemon.ts').includes('5 * 1024 * 1024') &&
    src('src/daemon/ownedDaemon.ts').includes('daemon.log.1'),
)
check(
  'reconcile removal set is exactly the record trio + scheduler lock — never logs (G14)',
  (src('src/daemon/reconcileRecords.ts').match(/await rm\(/g) || []).length === 3 &&
    !/unlink[^\n]*\.log/i.test(src('src/daemon/reconcileRecords.ts')),
)
check(
  'workers still carry the parent-death stamp (≤8s self-exit — the other half of teardown)',
  headlessTs.includes('WORKER_PARENT_PID_ENV, String(process.pid)'),
)
check(
  'the daemon stamps its identity baseline on BOTH record writes (boot + plane heal)',
  (mainTs.match(/startToken: bootStartToken/g) || []).length === 2 &&
    mainTs.includes('await getProcessStartTokenAsync(process.pid)'),
)
check(
  'the record type declares the baseline in the one vocabulary',
  src('src/daemon/controlSocket.ts').includes('startToken?: string | null'),
)
check(
  'the reconcile judges the record pid through the ONE identity owner (the D-convergence union), never a second liveness test',
  src('src/daemon/reconcileRecords.ts').includes('supervisorRecordIdentity(sup, await getProcessStartTokenAsync(sup.pid))'),
)
check(
  'spawn ledger documents the exit/reap vocabulary',
  src('src/utils/spawnLedger.ts').includes("'exit' | 'reap'"),
)

// ── cleanup + verdict ───────────────────────────────────────────────────────
rmSync(home, { recursive: true, force: true })
rmSync(projectDir, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-daemon-reconcile: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-daemon-reconcile: all green')
