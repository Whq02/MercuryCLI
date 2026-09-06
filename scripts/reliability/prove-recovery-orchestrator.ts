
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
import { spawnSync } from 'node:child_process'

let failures = 0
const ok = (cond: boolean, label: string) => {
  console.log(`${cond ? '  ✅' : '  ❌'} ${label}`)
  if (!cond) failures++
}

const tmp = mkdtempSync(join(tmpdir(), 'hermes-orch-'))
const home = join(tmp, 'home')
const teams = join(tmp, 'teams')
const daemon = join(tmp, 'daemon')
mkdirSync(home, { recursive: true })
mkdirSync(teams, { recursive: true })
mkdirSync(daemon, { recursive: true })

process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_TEAMS_DIR = teams
process.env.MERCURY_DAEMON_DIR = daemon
delete process.env.MERCURY_TASK_LIST_ID

const orch = await import('../../src/substrate/recoveryOrchestrator.ts')
const helpers = await import('../../src/utils/swarm/teamHelpers.ts')
const { getTaskListId } = await import('../../src/utils/tasks.ts')
const { getLeadTeamFallback } = await import('../../src/utils/teammate.ts')
const { listJournalOperations } = await import('../../src/substrate/operationJournal.ts')
const { buildBootRecoveryRow } = await import('../../src/commands/run/runInspectorModel.ts')

const deadPid = spawnSync(process.execPath, ['-e', ''], { timeout: 10_000 }).pid ?? 999_999

const TEN_MIN = 10 * 60_000
const backdate = (path: string, ms: number) => {
  const t = new Date(Date.now() - ms)
  utimesSync(path, t, t)
}

console.log('— seeding damage —')

const staleTemp = join(teams, '.config.json.12345.deadbeef.tmp')
const freshTemp = join(teams, '.config.json.12346.cafebabe.tmp')
writeFileSync(staleTemp, 'stale', 'utf8')
writeFileSync(freshTemp, 'fresh', 'utf8')
backdate(staleTemp, TEN_MIN + 60_000)

const deadTeam = 'orch-dead'
await helpers.writeTeamFileAsync(deadTeam, {
  name: deadTeam,
  createdAt: Date.now(),
  leadAgentId: `team-lead@${deadTeam}`,
  leadSessionId: 'dead-owner-session',
  members: [],
})
const journalDir = join(teams, '.journal')
mkdirSync(journalDir, { recursive: true })
const opFile = (id: string, kind: string, key: string, owner: string) =>
  JSON.stringify({
    schema: 1,
    operationId: id,
    ownerKey: owner,
    kind,
    idempotencyKey: key,
    state: 'applying',
    steps: [
      { id: 'team-file', target: 'x', state: 'applied' },
      { id: 'task-epoch', target: 'y', state: 'pending' },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    writerPid: deadPid,
  })
writeFileSync(join(journalDir, 'op-dead1.json'), opFile('dead1', 'team-create', `team-create:${deadTeam}`, 'dead-owner-session'), 'utf8')

const foreignTeam = 'orch-foreign'
await helpers.writeTeamFileAsync(foreignTeam, {
  name: foreignTeam,
  createdAt: Date.now(),
  leadAgentId: `team-lead@${foreignTeam}`,
  leadSessionId: 'somebody-else-entirely',
  members: [],
})
writeFileSync(join(journalDir, 'op-dead2.json'), opFile('dead2', 'team-create', `team-create:${foreignTeam}`, 'dead-owner-session'), 'utf8')

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
appendFileSync(
  ledger,
  JSON.stringify({ ts: new Date().toISOString(), store: 'proof-store', path: '/x', reason: 'seeded', quarantinePath: '/x.damaged', resumedFrom: 'empty' }) + '\n',
  'utf8',
)

console.log('— boot 1: reconciliation over seeded damage —')
{
  const before = orch.getBootRecovery()
  ok(before.phase === 'pending', 'state starts pending')
  const report = await orch.runBootRecovery({ scope: 'session', sessionId: 'unrelated-session' })
  ok(report.schema === 1 && report.scope === 'session', 'typed report (schema 1, session scope)')
  ok(!existsSync(staleTemp), 'stale orphan temp swept')
  ok(existsSync(freshTemp), 'fresh temp PRESERVED (live-writer guard)')
  ok(report.orphanTemps.removed >= 1, `orphan sweep counted (${report.orphanTemps.removed} across ${report.orphanTemps.dirsSwept} dirs)`)
  ok(report.teamJournal !== null && report.teamJournal.compensated.length === 2, `both dead ops compensated (${report.teamJournal?.compensated.length})`)
  ok(!existsSync(join(teams, deadTeam)), 'half-created team REMOVED by compensation')
  ok(existsSync(join(teams, foreignTeam, 'config.json')), 'foreign team UNTOUCHED (guarded unwind)')
  const ops = await listJournalOperations(journalDir)
  ok(ops.every(o => o.state === 'aborted' || o.state === 'committed'), 'journal fully terminal after recovery')
  ok(!existsSync(join(listDir, '1.json')), 'dead-epoch task body reclaimed')
  ok(existsSync(join(listDir, '2.json')), 'current-epoch task body preserved')
  ok(report.deadEpochTasks.removed === 1, `dead-epoch GC counted (${report.deadEpochTasks.removed})`)
  ok(report.quarantine.recent === 1 && report.quarantine.total === 1, 'quarantine ledger counted (1 recent)')
  ok(readFileSync(ledger, 'utf8').split('\n').filter(Boolean).length === 1, 'quarantine ledger not mutated')
  ok(report.leaderProjection === null, 'no leader projection for an unrelated session')
  ok(report.errors.length === 0, `no recovery errors (${report.errors.join(' | ') || 'clean'})`)
  ok(report.notes.length === 0, `no coverage notes on a small home (${report.notes.join(' | ') || 'clean'})`)
  ok(orch.getBootRecovery().phase === 'done', 'state lands done')

  const line = orch.bootRecoveryStatusLine(orch.getBootRecovery())
  ok(line !== null && line.text.includes('2 interrupted op(s) reconciled'), `status line reports the work (${line?.text})`)
  ok(line !== null && line.tone === 'ok', 'status tone ok (no unrecoverables)')
  const row = buildBootRecoveryRow(orch.getBootRecovery())
  ok(row !== null && row.section === 'RECOVERY' && row.detail.length >= 4, '/run RECOVERY row carries the evidence detail')

  const again = await orch.runBootRecovery({ scope: 'session', sessionId: 'unrelated-session' })
  ok(again === report, 'per-process memo returns the identical report')
}

console.log('— boot 2: idempotent re-run —')
{
  orch._resetBootRecoveryForTests()
  const report = await orch.runBootRecovery({ scope: 'session', sessionId: 'unrelated-session' })
  ok(report.orphanTemps.removed === 0, 'no temps left to sweep')
  ok(report.teamJournal !== null && report.teamJournal.compensated.length === 0 && report.teamJournal.rolledForward.length === 0, 'journal recovery is a no-op')
  ok(report.deadEpochTasks.removed === 0, 'dead-epoch GC is a no-op')
  ok(report.errors.length === 0, 'still no errors')
  ok(orch.bootRecoveryStatusLine(orch.getBootRecovery()) === null, 'a quiet boot earns NO status line')
  ok(buildBootRecoveryRow(orch.getBootRecovery()) === null, 'a quiet boot earns NO /run row')
}

console.log('— boot 3: leader projection rebuild —')
{
  const ledTeam = 'orch-led'
  await helpers.writeTeamFileAsync(ledTeam, {
    name: ledTeam,
    createdAt: Date.now(),
    leadAgentId: `team-lead@${ledTeam}`,
    leadSessionId: 'lead-session-S',
    members: [
      {
        agentId: `team-lead@${ledTeam}`,
        name: 'team-lead',
        joinedAt: 111,
        tmuxPaneId: '',
        cwd: '/w',
        subscriptions: [],
      },
      {
        agentId: `scout@${ledTeam}`,
        name: 'scout',
        agentType: 'mercury-general',
        color: 'blue',
        joinedAt: 222,
        tmuxPaneId: '',
        cwd: '/w',
        subscriptions: [],
      },
    ],
  })
  orch._resetBootRecoveryForTests()
  const report = await orch.runBootRecovery({ scope: 'session', sessionId: 'lead-session-S' })
  const led = report.leaderProjection
  ok(led !== null && led.teamName === ledTeam, 'led team found on disk for the resumed session')
  ok(led !== null && Object.keys(led.teammates).length === 2, 'AppState seed carries the full roster')
  ok(led !== null && led.teammates[`scout@${ledTeam}`]?.spawnedAt === 222, 'roster fields mapped (joinedAt → spawnedAt)')
  ok(getTaskListId() === helpers.sanitizeName(ledTeam), 'leader task-list registration rebuilt (getTaskListId → team)')
  ok(getLeadTeamFallback() === ledTeam, 'lead-aware tool identity rebuilt (leadTeamFallback)')
  const line = orch.bootRecoveryStatusLine(orch.getBootRecovery())
  ok(line !== null && line.text.includes(`team "${ledTeam}" projection rebuilt`), 'status line reports the rebuild')
}

console.log('— boot 4: bounded epoch GC stays quiet —')
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
  ok(report.deadEpochTasks.listsChecked === 64, `epoch-bearing lists bounded at 64 (${report.deadEpochTasks.listsChecked})`)
  const epochNote = report.notes.find(n => n.includes('dead-epoch GC bounded'))
  ok(epochNote !== undefined && epochNote.includes('64/'), `the bound is a NOTE (${epochNote})`)
  ok(report.notes.some(n => n.includes('orphan sweep bounded')), 'the dir bound is ALSO a note (150 lists > 128 dirs)')
  ok(report.errors.length === 0, 'the bound is NOT an error')
  const line = orch.bootRecoveryStatusLine(orch.getBootRecovery())
  ok(line === null || line.tone !== 'warn', 'no amber paint over coverage bookkeeping')
}

console.log('— doctor deep probe: disposable transaction —')
{
  const probes = await import('../../src/utils/healthDeepProbes.ts')
  const res = await probes.probeDurableTransaction()
  ok(res.status === 'ok', `probeDurableTransaction ok (${res.evidence})`)
  ok(process.env.MERCURY_FAULT_INJECT === undefined, 'fault-inject seam restored after the probe')
}

rmSync(tmp, { recursive: true, force: true })
console.log(failures === 0 ? '\n✅ recovery orchestrator: ALL PASS' : `\n❌ recovery orchestrator: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
