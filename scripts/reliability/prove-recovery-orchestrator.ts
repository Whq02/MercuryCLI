
import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  rmSync,
  utimesSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const ok = (cond: boolean, label: string, hint?: string) => {
  console.log(`${cond ? '  ✅' : '  ❌'} ${label}`)
  if (!cond) {
    failures++
    if (hint) console.log(`     change: ${hint}`)
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'mercury-orch-'))
const home = join(tmp, 'home')
const daemon = join(tmp, 'daemon')
mkdirSync(home, { recursive: true })
mkdirSync(daemon, { recursive: true })

process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = daemon
delete process.env.MERCURY_TASK_LIST_ID

const orch = await import('../../src/platform/substrate/recoveryOrchestrator.ts')
const { buildBootRecoveryRow } = await import('../../src/commands/run/runInspectorModel.ts')

const TEN_MIN = 10 * 60_000
const backdate = (path: string, ms: number) => {
  const t = new Date(Date.now() - ms)
  utimesSync(path, t, t)
}

console.log('— seeding damage —')

const staleTemp = join(home, 'recovery', '.ledger.json.12345.deadbeef.tmp')
const freshTemp = join(home, 'recovery', '.ledger.json.12346.cafebabe.tmp')
mkdirSync(join(home, 'recovery'), { recursive: true })
writeFileSync(staleTemp, 'stale', 'utf8')
writeFileSync(freshTemp, 'fresh', 'utf8')
backdate(staleTemp, TEN_MIN + 60_000)

const list = 'orch-list'
const listDir = join(home, 'tasks', list)
mkdirSync(listDir, { recursive: true })
writeFileSync(join(listDir, '.epoch'), JSON.stringify({ epoch: 2, resetAt: new Date().toISOString() }), 'utf8')
const taskBody = (id: string, epoch: number) =>
  JSON.stringify({ id, subject: 's', description: 'd', status: 'pending', blocks: [], blockedBy: [], epoch })
writeFileSync(join(listDir, '1.json'), taskBody('1', 1), 'utf8')
writeFileSync(join(listDir, '2.json'), taskBody('2', 2), 'utf8')

const ledger = join(home, 'recovery', 'store-recovery.jsonl')
mkdirSync(join(home, 'recovery'), { recursive: true })
const seededTs = new Date().toISOString()
appendFileSync(
  ledger,
  JSON.stringify({ ts: seededTs, store: 'proof-store', path: '/x', reason: 'seeded', quarantinePath: '/x.damaged', resumedFrom: 'empty' }) + '\n',
  'utf8',
)

console.log('— boot 1: reconciliation over seeded damage —')
{
  const before = orch.getBootRecovery()
  ok(before.phase === 'pending', 'state starts pending', 'src/platform/substrate/recoveryOrchestrator.ts: getBootRecovery must start in phase pending before runBootRecovery runs')
  const report = await orch.runBootRecovery({ scope: 'session', sessionId: 'unrelated-session' })
  ok(report.schema === 1 && report.scope === 'session', 'typed report (schema 1, session scope)', 'src/platform/substrate/recoveryOrchestrator.ts: runBootRecovery must return a report with schema 1 and the scope it was given')
  ok(!existsSync(staleTemp), 'stale orphan temp swept', 'src/platform/substrate/recoveryOrchestrator.ts: runBootRecovery must remove durable temp files older than ten minutes')
  ok(existsSync(freshTemp), 'fresh temp PRESERVED (live-writer guard)', 'src/platform/substrate/recoveryOrchestrator.ts: runBootRecovery must leave recent durable temp files alone')
  ok(report.orphanTemps.removed >= 1, `orphan sweep counted (${report.orphanTemps.removed} across ${report.orphanTemps.dirsSwept} dirs)`, 'src/platform/substrate/recoveryOrchestrator.ts: runBootRecovery must count each swept temp in report.orphanTemps.removed')
  ok(!existsSync(join(listDir, '1.json')), 'dead-epoch task body reclaimed', 'src/platform/substrate/recoveryOrchestrator.ts: runBootRecovery must delete task files whose epoch is below the list .epoch file')
  ok(existsSync(join(listDir, '2.json')), 'current-epoch task body preserved', 'src/platform/substrate/recoveryOrchestrator.ts: runBootRecovery must keep task files at the current epoch')
  ok(report.deadEpochTasks.removed === 1, `dead-epoch GC counted (${report.deadEpochTasks.removed})`, 'src/platform/substrate/recoveryOrchestrator.ts: runBootRecovery must set report.deadEpochTasks.removed to the number of files it deleted')
  ok(report.quarantine.recent === 1 && report.quarantine.total === 1, `quarantine ledger counted (${report.quarantine.recent} recent, ${report.quarantine.total} total)`, 'src/platform/substrate/recoveryOrchestrator.ts: runBootRecovery must read the store-recovery.jsonl ledger into report.quarantine')
  ok(readFileSync(ledger, 'utf8').split('\n').filter(Boolean).length === 1, 'the quarantine ledger is read, never mutated', 'src/platform/substrate/recoveryOrchestrator.ts: runBootRecovery must not write to store-recovery.jsonl')
  ok(report.errors.length === 0, `no recovery errors (${report.errors.join(' | ') || 'clean'})`, 'src/platform/substrate/recoveryOrchestrator.ts: runBootRecovery pushed an error; fix the step named in the error text above')
  ok(report.notes.length === 0, `no coverage notes on a small home (${report.notes.join(' | ') || 'clean'})`, 'src/platform/substrate/recoveryOrchestrator.ts: runBootRecovery added a coverage note on a small home; its bounds must only note when exceeded')
  ok(orch.getBootRecovery().phase === 'done', 'state lands done', 'src/platform/substrate/recoveryOrchestrator.ts: runBootRecovery must set the state phase to done when it finishes')

  const line = orch.bootRecoveryStatusLine(orch.getBootRecovery())
  ok(line !== null && line.text.includes('1 dead task file(s) reclaimed'), `status line reports the work (${line?.text})`, 'src/platform/substrate/recoveryOrchestrator.ts: bootRecoveryStatusLine must name the dead task files it reclaimed')
  const row = buildBootRecoveryRow(orch.getBootRecovery())
  ok(row !== null && row.section === 'RECOVERY' && row.detail.length >= 3, '/run RECOVERY row carries the evidence detail', 'src/commands/run/runInspectorModel.ts: buildBootRecoveryRow must return a RECOVERY row with at least three detail lines when work was done')

  const again = await orch.runBootRecovery({ scope: 'session', sessionId: 'unrelated-session' })
  ok(again === report, 'per-process memo returns the identical report', 'src/platform/substrate/recoveryOrchestrator.ts: runBootRecovery must return the memoized report on a second call in the same process')
}

console.log('— boot 2: idempotent re-run —')
{
  orch._resetBootRecoveryForTests()
  const report = await orch.runBootRecovery({ scope: 'session', sessionId: 'unrelated-session' })
  ok(report.orphanTemps.removed === 0, 'no temps left to sweep', 'src/platform/substrate/recoveryOrchestrator.ts: the orphan sweep in runBootRecovery must not recount files it already removed')
  ok(report.deadEpochTasks.removed === 0, 'dead-epoch GC is a no-op', 'src/platform/substrate/recoveryOrchestrator.ts: the dead-epoch GC in runBootRecovery must be idempotent')
  ok(report.errors.length === 0, 'still no errors', 'src/platform/substrate/recoveryOrchestrator.ts: a re-run of runBootRecovery must not push errors: ' + report.errors.join(' | '))
  ok(report.quarantine.total === 1 && readFileSync(ledger, 'utf8').split('\n').filter(Boolean).length === 1, 'the second boot appends nothing to the ledger', 'src/platform/substrate/recoveryOrchestrator.ts: runBootRecovery must not append to store-recovery.jsonl')
  ok(orch.bootRecoveryStatusLine(orch.getBootRecovery()) === null, 'a quiet boot earns NO status line', 'src/platform/substrate/recoveryOrchestrator.ts: bootRecoveryStatusLine must return null when nothing was reclaimed')
  ok(buildBootRecoveryRow(orch.getBootRecovery()) === null, 'a quiet boot earns NO /run row', 'src/commands/run/runInspectorModel.ts: buildBootRecoveryRow must return null when nothing was reclaimed')
}

console.log('— boot 3: bounded epoch GC stays quiet —')
{
  for (let i = 0; i < 80; i++) {
    mkdirSync(join(home, 'tasks', `plain-${i}`), { recursive: true })
  }
  for (let i = 0; i < 70; i++) {
    const d = join(home, 'tasks', `epochy-${i}`)
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, '.epoch'), JSON.stringify({ epoch: 1, resetAt: new Date().toISOString() }), 'utf8')
  }
  orch._resetBootRecoveryForTests()
  const report = await orch.runBootRecovery({ scope: 'session', sessionId: 'unrelated-session' })
  ok(report.deadEpochTasks.listsChecked === 64, `epoch-bearing lists bounded at 64 (${report.deadEpochTasks.listsChecked})`, 'src/platform/substrate/recoveryOrchestrator.ts: the dead-epoch GC in runBootRecovery must check at most 64 epoch-bearing lists')
  const epochNote = report.notes.find(n => n.includes('dead-epoch GC bounded'))
  ok(epochNote !== undefined && epochNote.includes('64/'), `the bound is a NOTE (${epochNote})`, 'src/platform/substrate/recoveryOrchestrator.ts: runBootRecovery must add a note containing dead-epoch GC bounded and the 64/ count when the bound is hit')
  ok(report.notes.some(n => n.includes('orphan sweep bounded')), 'the dir bound is ALSO a note (150 lists > 128 dirs)', 'src/platform/substrate/recoveryOrchestrator.ts: the orphan sweep in runBootRecovery must add a note containing orphan sweep bounded when it hits its directory bound')
  ok(report.errors.length === 0, 'the bound is NOT an error', 'src/platform/substrate/recoveryOrchestrator.ts: hitting a bound in runBootRecovery must be a note, not an error: ' + report.errors.join(' | '))
  const line = orch.bootRecoveryStatusLine(orch.getBootRecovery())
  ok(line === null || line.tone !== 'warn', 'no amber paint over coverage bookkeeping', 'src/platform/substrate/recoveryOrchestrator.ts: bootRecoveryStatusLine must not use the warn tone for coverage notes alone')
}

console.log('— health deep probe: disposable transaction —')
{
  const probes = await import('../../src/platform/health/healthDeepProbes.ts')
  const res = await probes.probeDurableTransaction()
  ok(res.status === 'ok', `probeDurableTransaction ok (${res.evidence})`, 'src/platform/health/healthDeepProbes.ts: probeDurableTransaction returned a non-ok status; see its evidence above')
  ok(process.env.MERCURY_FAULT_INJECT === undefined, 'fault-inject seam restored after the probe', 'src/platform/health/healthDeepProbes.ts: probeDurableTransaction must restore MERCURY_FAULT_INJECT to its prior value when it ends')
}

rmSync(tmp, { recursive: true, force: true })
console.log(failures === 0 ? '\n✅ recovery orchestrator: ALL PASS' : `\n❌ recovery orchestrator: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
