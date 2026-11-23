import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

let failures = 0
function check(label: string, ok: boolean, detail = '', failHint = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}${!ok && failHint ? ` — ${failHint}` : ''}`)
  if (!ok) failures++
}

const home = mkdtempSync(join(tmpdir(), 'daemon-reconcile-home-'))
const daemonScratch = join(home, 'daemon')
const projectDir = mkdtempSync(join(tmpdir(), 'daemon-reconcile-proj-'))
mkdirSync(daemonScratch, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = daemonScratch
delete process.env.MERCURY_SPAWN_LEDGER

const { reconcileDaemonRecords } = await import('../../src/daemon/control/reconcileRecords.ts')
const controlSocket = await import('../../src/daemon/control/controlSocket.ts')
const ledger = await import('../../src/daemon/roster/spawnLedger.ts')

const deadPid = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' }).pid as number
if (!deadPid || deadPid <= 1) {
  console.error('could not mint a dead pid — cannot run this proof')
  process.exit(1)
}

const supPath = controlSocket.daemonStatePath()
const lockPath = join(daemonScratch, 'daemon.lock')
const keyPath = join(daemonScratch, 'control.key')

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

seedDeadRecords(deadPid)
const dead = await reconcileDaemonRecords({ projectDir })
check('seeded-dead ⇒ state reconciled', dead.state === 'reconciled', JSON.stringify(dead), 'fix reconcileDaemonRecords in src/daemon/control/reconcileRecords.ts so a daemon.json whose pid is dead gives state reconciled')
check('daemon.json removed', !existsSync(supPath), '', 'reconcileDaemonRecords in src/daemon/control/reconcileRecords.ts must delete daemon.json when the recorded pid is dead')
check('daemon.lock removed', !existsSync(lockPath), '', 'reconcileDaemonRecords in src/daemon/control/reconcileRecords.ts must delete daemon.lock when the recorded pid is dead')
check('control.key removed', !existsSync(keyPath), '', 'reconcileDaemonRecords in src/daemon/control/reconcileRecords.ts must delete control.key when the recorded pid is dead')
check(
  'receipt names all three artifacts',
  dead.cleaned.length === 3 &&
    ['daemon.json', 'daemon.lock', 'control.key'].every(n =>
      dead.cleaned.includes(n),
    ),
  dead.cleaned.join(','),
  'reconcileDaemonRecords in src/daemon/control/reconcileRecords.ts must list daemon.json, daemon.lock and control.key in cleaned',
)
check('receipt carries the dead pid', dead.deadPid === deadPid, '', 'reconcileDaemonRecords in src/daemon/control/reconcileRecords.ts must put the dead pid in the receipt as deadPid')

const again = await reconcileDaemonRecords({ projectDir })
check('second pass ⇒ clean (idempotent)', again.state === 'clean' && again.cleaned.length === 0, '', 'reconcileDaemonRecords in src/daemon/control/reconcileRecords.ts must report clean and remove nothing when no records remain')

seedDeadRecords(process.pid, Date.now())
const live = await reconcileDaemonRecords({ projectDir })
check('live daemon pid ⇒ state live, nothing touched', live.state === 'live' && live.cleaned.length === 0, '', 'reconcileDaemonRecords in src/daemon/control/reconcileRecords.ts must report live and clean nothing when the recorded pid is this running process')
check('live: daemon.json intact', existsSync(supPath), '', 'reconcileDaemonRecords in src/daemon/control/reconcileRecords.ts must not delete daemon.json of a live daemon')
check('live: control.key intact', existsSync(keyPath), '', 'reconcileDaemonRecords in src/daemon/control/reconcileRecords.ts must not delete control.key of a live daemon')
check('live: daemon.lock intact', existsSync(lockPath), '', 'reconcileDaemonRecords in src/daemon/control/reconcileRecords.ts must not delete daemon.lock of a live daemon')

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
    recycled.state === 'reconciled' && ['daemon.json', 'daemon.lock', 'control.key'].every(n => recycled.cleaned.includes(n)),
    JSON.stringify(recycled),
    'reconcileDaemonRecords in src/daemon/control/reconcileRecords.ts must compare the recorded startToken with the live process and treat a mismatch as a recycled pid',
  )
  check('the receipt names the recycled verdict, not "not running"', recycled.reason.includes('recycled') && recycled.reason.includes('start-token mismatch'), recycled.reason, 'reconcileDaemonRecords in src/daemon/control/reconcileRecords.ts must word the reason as recycled with a start-token mismatch')
  check('recycled sweep: files gone', !existsSync(supPath) && !existsSync(lockPath) && !existsSync(keyPath), '', 'reconcileDaemonRecords in src/daemon/control/reconcileRecords.ts must delete all three records of a recycled pid')
  const otherLivePid = process.ppid
  if (otherLivePid && otherLivePid > 1) {
    seedIdentity(otherLivePid)
    const vetoed = await reconcileDaemonRecords({ projectDir })
    check('a DIFFERENT live lock-holder pid still vetoes (the mid-boot hand-off is whole)', vetoed.state === 'live' && vetoed.cleaned.length === 0, JSON.stringify(vetoed), 'reconcileDaemonRecords in src/daemon/control/reconcileRecords.ts must treat a live pid in daemon.lock that differs from the recorded one as live and clean nothing')
    check('vetoed: records intact', existsSync(supPath) && existsSync(lockPath) && existsSync(keyPath), '', 'reconcileDaemonRecords in src/daemon/control/reconcileRecords.ts must leave all three records when the lock holder is live')
    rmSync(supPath, { force: true })
    rmSync(lockPath, { force: true })
    rmSync(keyPath, { force: true })
  }
  writeFileSync(
    supPath,
    JSON.stringify({ pid: process.pid, version: '0.0.0-proof', origin: 'transient', startedAt: Date.now() - 60_000, dir: projectDir, controlSock: join(daemonScratch, 'control.sock'), startToken: null }),
  )
  const fallbackRecycled = await reconcileDaemonRecords({ projectDir })
  check('a baseline-less record + a process born after its stamp ⇒ the fallback arm judges recycled ⇒ reconciled', fallbackRecycled.state === 'reconciled' && fallbackRecycled.reason.includes('recycled'), JSON.stringify(fallbackRecycled), 'reconcileDaemonRecords in src/daemon/control/reconcileRecords.ts must, for a record without a startToken, judge the pid recycled when the process started after startedAt')
  writeFileSync(
    supPath,
    JSON.stringify({ pid: process.pid, version: '0.0.0-proof', origin: 'transient', startedAt: Date.now(), dir: projectDir, controlSock: join(daemonScratch, 'control.sock') }),
  )
  const fallbackSame = await reconcileDaemonRecords({ projectDir })
  check('a pre-token record + a process born at-or-before its stamp ⇒ the recorded daemon ⇒ live hand-off', fallbackSame.state === 'live' && fallbackSame.cleaned.length === 0, JSON.stringify(fallbackSame), 'reconcileDaemonRecords in src/daemon/control/reconcileRecords.ts must, for a record without a startToken, judge the daemon live when the process started at or before startedAt')
  rmSync(supPath, { force: true })
}

rmSync(supPath, { force: true })
writeFileSync(lockPath, JSON.stringify({ owner: 'proof-midboot', pid: process.pid, acquiredAt: Date.now() }))
const midBoot = await reconcileDaemonRecords({ projectDir })
check('live lock holder alone ⇒ live (mid-boot conservatism)', midBoot.state === 'live' && midBoot.cleaned.length === 0, '', 'reconcileDaemonRecords in src/daemon/control/reconcileRecords.ts must report live when only daemon.lock exists and its pid is alive')
rmSync(lockPath, { force: true })
rmSync(keyPath, { force: true })

const clean = await reconcileDaemonRecords({ projectDir })
check('empty home ⇒ clean', clean.state === 'clean' && clean.cleaned.length === 0, '', 'reconcileDaemonRecords in src/daemon/control/reconcileRecords.ts must report clean when no daemon records exist')

writeFileSync(keyPath, 'deadbeef'.repeat(8))
const keyOnly = await reconcileDaemonRecords({ projectDir })
check('orphan control.key alone ⇒ reconciled', keyOnly.state === 'reconciled' && keyOnly.cleaned.includes('control.key'), '', 'reconcileDaemonRecords in src/daemon/control/reconcileRecords.ts must delete a control.key left with no daemon.json and report reconciled')

console.log('— §2 runBootRecovery integration —')
const orchestrator = await import('../../src/platform/substrate/recoveryOrchestrator.ts')
orchestrator._resetBootRecoveryForTests()
seedDeadRecords(deadPid)
const report = await orchestrator.runBootRecovery({ scope: 'daemon', projectDir })
check('report carries the daemonRecords step', report.daemonRecords !== null && report.daemonRecords !== undefined, '', 'runBootRecovery in src/platform/substrate/recoveryOrchestrator.ts must run the daemon record reconcile and put its result in the report as daemonRecords')
check(
  'boot recovery reconciled the seeded records',
  report.daemonRecords?.state === 'reconciled' && (report.daemonRecords?.cleaned.length ?? 0) === 3,
  JSON.stringify(report.daemonRecords),
  'runBootRecovery in src/platform/substrate/recoveryOrchestrator.ts must pass the reconcileDaemonRecords result through unchanged',
)
check('boot recovery: files gone', !existsSync(supPath) && !existsSync(keyPath) && !existsSync(lockPath), '', 'runBootRecovery in src/platform/substrate/recoveryOrchestrator.ts must let reconcileDaemonRecords delete the stale records')
check(
  'status line reports the reconcile',
  (orchestrator.bootRecoveryStatusLine(orchestrator.getBootRecovery())?.text ?? '').includes('daemon record'),
  '',
  'bootRecoveryStatusLine in src/platform/substrate/recoveryOrchestrator.ts must mention the daemon record reconcile in its text',
)

console.log('— §3 daemonExitTeardownSync (the sync exit backstop) —')
seedDeadRecords(process.pid)
controlSocket.daemonExitTeardownSync('proof-exit')
check('sync teardown removes OWNED daemon.json', !existsSync(supPath), '', 'daemonExitTeardownSync in src/daemon/control/controlSocket.ts must delete daemon.json that this process owns')
check('sync teardown removes OWNED control.key', !existsSync(keyPath), '', 'daemonExitTeardownSync in src/daemon/control/controlSocket.ts must delete control.key that this process owns')
check('sync teardown removes OWNED daemon.lock', !existsSync(lockPath), '', 'daemonExitTeardownSync in src/daemon/control/controlSocket.ts must delete daemon.lock that this process owns')
seedDeadRecords(deadPid)
controlSocket.daemonExitTeardownSync('proof-exit-foreign')
check('sync teardown LEAVES a foreign daemon.json (the phone-line law)', existsSync(supPath), '', 'daemonExitTeardownSync in src/daemon/control/controlSocket.ts must leave daemon.json that belongs to another pid')
check('sync teardown LEAVES a foreign control.key', existsSync(keyPath), '', 'daemonExitTeardownSync in src/daemon/control/controlSocket.ts must leave control.key that belongs to another pid')
rmSync(supPath, { force: true })
rmSync(keyPath, { force: true })
rmSync(lockPath, { force: true })
const ledgerPath = join(daemonScratch, 'spawn-ledger.jsonl')
const rows = existsSync(ledgerPath)
  ? readFileSync(ledgerPath, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  : []
check(
  'sync teardown ledgers a daemon exit row',
  rows.some(r => r.kind === 'daemon' && r.event === 'exit' && r.reason === 'proof-exit'),
  `${rows.length} row(s)`,
  'daemonExitTeardownSync in src/daemon/control/controlSocket.ts must append a daemon exit row with the given reason to spawn-ledger.jsonl',
)

{
  seedDeadRecords(process.pid, Date.now())
  const written: string[] = []
  const realWrite = process.stderr.write.bind(process.stderr)
  ;(process.stderr as unknown as { write: (chunk: unknown) => boolean }).write = (chunk: unknown): boolean => {
    written.push(String(chunk))
    return true
  }
  try {
    controlSocket.daemonExitTeardownSync('exit-before-teardown', 1)
  } finally {
    ;(process.stderr as unknown as { write: typeof realWrite }).write = realWrite
  }
  const line = written.join('')
  check('the bypassed-roads death writes its one honest line with the code', line.includes('[daemon] exit (code 1) WITHOUT a shutdown road'), '', 'daemonExitTeardownSync in src/daemon/control/controlSocket.ts must write one stderr line starting [daemon] exit (code N) WITHOUT a shutdown road when the reason is exit-before-teardown')
  check('the line carries the sweep verdict and the site-naming probe', line.includes('records swept') && line.includes('--trace-exit'), '', 'daemonExitTeardownSync in src/daemon/control/controlSocket.ts must add records swept and --trace-exit to the bypassed-road line')
  const ledgerRows = readFileSync(ledgerPath, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  check('the ledger row keeps the plain reason when the sweep succeeded', ledgerRows.some(r => r.kind === 'daemon' && r.reason === 'exit-before-teardown'), '', 'daemonExitTeardownSync in src/daemon/control/controlSocket.ts must ledger the plain reason exit-before-teardown when the sweep succeeded')
  seedDeadRecords(process.pid, Date.now())
  const writtenQuiet: string[] = []
  ;(process.stderr as unknown as { write: (chunk: unknown) => boolean }).write = (chunk: unknown): boolean => {
    writtenQuiet.push(String(chunk))
    return true
  }
  try {
    controlSocket.daemonExitTeardownSync('proof-quiet')
  } finally {
    ;(process.stderr as unknown as { write: typeof realWrite }).write = realWrite
  }
  check('an ordinary teardown reason stays wordless (the line is for bypassed roads only)', writtenQuiet.join('') === '', '', 'daemonExitTeardownSync in src/daemon/control/controlSocket.ts must write to stderr only for the exit-before-teardown reason')
}

{
  const fsH = await import('node:fs')
  fsH.mkdirSync(dirname(supPath), { recursive: true })
  fsH.writeFileSync(supPath, JSON.stringify({ pid: deadPid, startedAt: Date.now() - 60_000 }))
  const { crewChecks } = await import('../../src/platform/health/sections/crew.ts')
  const daemonSays = await crewChecks().find(row => row.id === 'daemon')?.run()
  check(
    'health daemon row runs the reconcile (verb-path cleanup)',
    daemonSays !== undefined && /reconciled stale records: removed /.test(daemonSays.evidence) && !fsH.existsSync(supPath),
    `${daemonSays?.status}: ${daemonSays?.evidence}`,
    'the daemon row of crewChecks in src/platform/health/sections/crew.ts must run reconcileDaemonRecords and say reconciled stale records: removed in its evidence',
  )
}

rmSync(home, { recursive: true, force: true })
rmSync(projectDir, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-daemon-reconcile: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-daemon-reconcile: all green')
