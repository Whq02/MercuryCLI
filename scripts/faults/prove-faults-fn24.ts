#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)
let failures = 0

const AREA_FIX_HINTS: Record<string, string> = {
  launchMilestones: 'fix readLaunchMilestones, recordLaunchMilestone or lastBootReachedInputLive in src/platform/substrate/launchMilestones.ts so a torn file heals and an unreadable file is kept',
  operationJournal: 'fix listJournalOperations or recoverJournalDir in src/platform/substrate/operationJournal.ts so an unreadable op file is reported and ledgered',
  pidLock: 'fix probePidLock in src/platform/substrate/pidLock.ts so a failed relink restores a live holder or keeps the moved record',
  storeRecovery: 'fix readStoreRecoveryEvents in src/platform/substrate/storeRecovery.ts so an unreadable ledger throws',
  recoveryOrchestrator: 'fix runBootRecovery or countOrphanDurableTemps in src/platform/substrate/recoveryOrchestrator.ts so a read failure is reported, not swallowed',
  splashHandover: 'fix consumeSplashHandover in src/platform/substrate/splashHandover.ts so a failure leaves a warn boot note and keeps the receipt',
  startupMenu: 'fix applyBootMenuEnv, writeBootEnvChoice or saveBootDefaultsProfile in src/platform/substrate/startupMenu.ts so a corrupt or unreadable boot-env file is refused and left as it was',
  stateLifecycle: 'fix installedBuildFacts in src/platform/substrate/stateLifecycle.ts so a corrupt build manifest throws',
  pauseCarry: 'fix readAgentPauseRecord or carryPausedCrewmatesOnResume in src/engine/tasks/local-agent/pauseCarry.ts',
  taskLaunchLedger: 'fix recordTaskLaunch or settleTaskLaunch in src/engine/tasks/taskLaunchLedger.ts so a corrupt or unreadable ledger is preserved',
  taskOutcomeEnvelope: 'fix recordTaskOutcome or loadTaskOutcomes in src/engine/tasks/taskOutcomeEnvelope.ts so a corrupt or unreadable file is preserved',
  tools: 'fix getTools in src/tools/kit/toolList.ts so a tool whose isEnabled throws is logged and left out alone',
}
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  const hint = AREA_FIX_HINTS[label.split(':')[0] ?? '']
  const shown = !cond ? [detail, hint].filter(Boolean).join(' | ') : ''
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${shown ? ` — ${shown}` : ''}`)
}

async function withScratchHome(fn: (home: string) => Promise<void> | void): Promise<void> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'faults-fn24-')))
  const prevConfig = process.env.MERCURY_CONFIG_DIR
  const prevHome = process.env.MERCURY_HOME
  process.env.MERCURY_CONFIG_DIR = scratch
  delete process.env.MERCURY_HOME
  try {
    await fn(scratch)
  } finally {
    if (prevConfig === undefined) delete process.env.MERCURY_CONFIG_DIR
    else process.env.MERCURY_CONFIG_DIR = prevConfig
    if (prevHome === undefined) delete process.env.MERCURY_HOME
    else process.env.MERCURY_HOME = prevHome
    rmSync(scratch, { recursive: true, force: true })
  }
}

async function proveLaunchMilestones(): Promise<void> {
  const m = await import('../../src/platform/substrate/launchMilestones.js')
  await withScratchHome(home => {
    m._resetLaunchMilestonesForTesting()
    check('launchMilestones: missing file returns empty rows', m.readLaunchMilestones().length === 0)
    const file = join(home, 'launch-milestones.json')
    const corrupt = '{not-valid-json'
    writeFileSync(file, corrupt, { mode: 0o600 })
    check('launchMilestones: reader keeps answering empty on corrupt file', m.readLaunchMilestones().length === 0)
    m.recordLaunchMilestone('runtime-entry')
    check('launchMilestones: recordLaunchMilestone heals torn file', m.readLaunchMilestones().some(r => r.milestone === 'runtime-entry'))
    if (POSIX_MODES) {
      const valid = JSON.stringify({ version: 1, rows: [{ schema: 1, pid: 1, milestone: 'input-live', atMs: 1 }] })
      writeFileSync(file, valid, { mode: 0o600 })
      chmodSync(file, 0o200)
      const reached = m.lastBootReachedInputLive()
      m._resetLaunchMilestonesForTesting()
      m.recordLaunchMilestone('runtime-entry')
      chmodSync(file, 0o600)
      check('launchMilestones: reader keeps answering null on unreadable file', reached === null, String(reached))
      check('launchMilestones: recordLaunchMilestone preserves unreadable file', readFileSync(file, 'utf8') === valid)
    }
  })
}

async function proveOperationJournal(): Promise<void> {
  const oj = await import('../../src/platform/substrate/operationJournal.js')
  const sr = await import('../../src/platform/substrate/storeRecovery.js')
  await withScratchHome(async home => {
    const missing = join(home, 'no-such-journal')
    check('operationJournal: missing dir lists empty', (await oj.listJournalOperations(missing)).length === 0)
    if (POSIX_MODES) {
      const dir = join(home, 'journal-unreadable-op')
      mkdirSync(dir, { recursive: true })
      const opFile = join(dir, 'op-unreadable-1.json')
      writeFileSync(opFile, JSON.stringify({ schema: 1, operationId: 'unreadable-1' }), { mode: 0o600 })
      chmodSync(opFile, 0o200)
      try {
        const summary = await oj.recoverJournalDir(dir, {})
        const refused = (await sr.readStoreRecoveryEvents()).filter(e => e.kind === 'refused' && e.path === opFile)
        check('operationJournal: unreadable op file is reported in unrecoverable', summary.unrecoverable.includes('op-unreadable-1.json'), JSON.stringify(summary))
        check('operationJournal: unreadable op file recorded on recovery ledger', refused.length === 1 && refused[0]!.store === 'operation-journal', JSON.stringify(refused))
      } finally {
        chmodSync(opFile, 0o600)
      }
    }
  })
}

async function provePidLock(): Promise<void> {
  const bun = process.execPath
  const pidLockPath = realpathSync(join(import.meta.dir, '../../src/platform/substrate/pidLock.ts'))
  await withScratchHome(home => {
    const script = `
      import { mock } from 'bun:test'
      import * as realFsp from 'node:fs/promises'
      import * as fs from 'node:fs'
      import { join } from 'node:path'

      const home = ${JSON.stringify(home)}
      const liveRecord = JSON.stringify({ owner: 'live-owner', pid: process.pid, acquiredAt: Date.now() })
      const deadRecord = JSON.stringify({ owner: 'dead-owner', pid: 99999999, acquiredAt: Date.now() - 60000 })
      let failLinkCode = 'EPERM'
      let swapOnRename = true
      let unreadableTaken = false

      const origRename = realFsp.rename
      const origReadFile = realFsp.readFile
      const mocked = {
        ...realFsp,
        rename: async (src, dst) => {
          await origRename(src, dst)
          if (swapOnRename) fs.writeFileSync(dst, liveRecord)
        },
        readFile: async (p, enc) => {
          if (unreadableTaken && String(p).includes('.reap-')) {
            throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
          }
          return origReadFile(p, enc)
        },
        link: async () => {
          throw Object.assign(new Error(failLinkCode), { code: failLinkCode })
        },
      }
      mock.module('fs/promises', () => mocked)
      mock.module('node:fs/promises', () => mocked)

      const { probePidLock } = await import(${JSON.stringify(pidLockPath)})

      const lock1 = join(home, 'a.lock')
      fs.writeFileSync(lock1, deadRecord)
      await probePidLock(lock1, { liveness: 'assume-dead', reclaimStale: true })
      const restoredA = fs.existsSync(lock1) && fs.readFileSync(lock1, 'utf8') === liveRecord

      failLinkCode = 'EIO'
      swapOnRename = false
      unreadableTaken = true
      const lock2 = join(home, 'b.lock')
      fs.writeFileSync(lock2, deadRecord)
      await probePidLock(lock2, { liveness: 'assume-dead', reclaimStale: true })
      const leftoverB = fs.readdirSync(home).filter(n => n.startsWith('b.lock.reap-'))

      process.stdout.write('\\n' + JSON.stringify({ restoredA, keptB: leftoverB.length === 1 }))
    `
    const res = spawnSync(bun, ['-e', script], { encoding: 'utf8', env: { ...process.env, MERCURY_CONFIG_DIR: home } })
    if (res.status !== 0) {
      check('pidLock: probePidLock relink fallback subprocess ran', false, res.stderr.slice(-400))
      return
    }
    const out = JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as { restoredA?: boolean; keptB?: boolean }
    check('pidLock: EPERM relink restores live holder via wx write', out.restoredA === true, JSON.stringify(out))
    check('pidLock: failed relink of unreadable record preserves moved file', out.keptB === true, JSON.stringify(out))
  })
}

async function proveStoreRecovery(): Promise<void> {
  const sr = await import('../../src/platform/substrate/storeRecovery.js')
  await withScratchHome(async home => {
    check('storeRecovery: missing ledger returns empty', (await sr.readStoreRecoveryEvents()).length === 0)
    if (POSIX_MODES) {
      const ledgerDir = join(home, 'recovery')
      mkdirSync(ledgerDir, { recursive: true })
      const ledger = join(ledgerDir, 'store-recovery.jsonl')
      writeFileSync(ledger, JSON.stringify({ ts: new Date().toISOString(), store: 'x', path: '/p', reason: 'r', quarantinePath: null, resumedFrom: 'empty' }) + '\n', { mode: 0o600 })
      chmodSync(ledger, 0o200)
      let code: string | undefined
      try {
        await sr.readStoreRecoveryEvents()
      } catch (e) {
        code = (e as NodeJS.ErrnoException).code
      } finally {
        chmodSync(ledger, 0o600)
      }
      check('storeRecovery: unreadable ledger throws EACCES', code === 'EACCES', String(code))
    }
  })
}

async function proveRecoveryOrchestrator(): Promise<void> {
  const orch = await import('../../src/platform/substrate/recoveryOrchestrator.js')
  await withScratchHome(async home => {
    if (POSIX_MODES) {
      orch._resetBootRecoveryForTests()
      const ledgerDir = join(home, 'recovery')
      mkdirSync(ledgerDir, { recursive: true })
      const ledger = join(ledgerDir, 'store-recovery.jsonl')
      writeFileSync(ledger, '{"ts":"2026-01-01T00:00:00.000Z","store":"x"}\n', { mode: 0o600 })
      chmodSync(ledger, 0o200)
      try {
        const report = await orch.runBootRecovery({ scope: 'session' })
        check('recoveryOrchestrator: unreadable recovery ledger adds report error', report.errors.some(e => e.includes('store-recovery ledger read failed')), JSON.stringify(report.errors))
      } finally {
        chmodSync(ledger, 0o600)
        orch._resetBootRecoveryForTests()
      }

      const lockedRecovery = join(home, 'recovery')
      chmodSync(lockedRecovery, 0o000)
      let dirErr: string | undefined
      try {
        await orch.countOrphanDurableTemps()
      } catch (e) {
        dirErr = (e as NodeJS.ErrnoException).code
      } finally {
        chmodSync(lockedRecovery, 0o700)
      }
      check('recoveryOrchestrator: countOrphanDurableTemps throws EACCES on unreadable dir', dirErr === 'EACCES', String(dirErr))

      const lockedTasks = join(home, 'tasks')
      mkdirSync(lockedTasks, { recursive: true })
      chmodSync(lockedTasks, 0o000)
      try {
        const report = await orch.runBootRecovery({ scope: 'session' })
        check('recoveryOrchestrator: unreadable tasks dir records dead-epoch GC error', report.errors.some(e => e.includes('dead-epoch GC failed')), JSON.stringify(report.errors))
      } finally {
        chmodSync(lockedTasks, 0o700)
        orch._resetBootRecoveryForTests()
      }
    }
  })
}

async function proveSplashHandover(): Promise<void> {
  const sh = await import('../../src/platform/substrate/splashHandover.js')
  const bn = await import('../../src/platform/substrate/bootNotes.js')
  await withScratchHome(home => {
    bn._resetBootNotesForTesting()
    const origChdir = process.chdir
    const targetDir = join(home, 'chosen-project')
    mkdirSync(targetDir, { recursive: true })
    const receiptPath = join(home, 'splash-action.json')
    writeFileSync(receiptPath, JSON.stringify({ version: 1, ts: Date.now(), action: 'project', dir: targetDir }))
    process.env.MERCURY_SPLASH_HANDOFF = '1'
    process.chdir = (() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    }) as typeof process.chdir
    try {
      sh.consumeSplashHandover()
    } finally {
      process.chdir = origChdir
      delete process.env.MERCURY_SPLASH_HANDOFF
    }
    const notes = bn.bootNotes()
    check('splashHandover: chdir failure records warn boot note naming dir and error', notes.some(n => n.kind === 'warn' && n.text.includes(targetDir) && n.text.includes('permission denied')), JSON.stringify(notes))

    if (POSIX_MODES) {
      bn._resetBootNotesForTesting()
      const payload = JSON.stringify({ version: 1, ts: Date.now(), action: 'project', dir: targetDir })
      writeFileSync(receiptPath, payload, { mode: 0o600 })
      chmodSync(receiptPath, 0o200)
      process.env.MERCURY_SPLASH_HANDOFF = '1'
      try {
        sh.consumeSplashHandover()
      } finally {
        delete process.env.MERCURY_SPLASH_HANDOFF
        chmodSync(receiptPath, 0o600)
      }
      const notes2 = bn.bootNotes()
      check('splashHandover: unreadable receipt records warn boot note', notes2.some(n => n.kind === 'warn' && n.text.includes('Could not read your startup choice')), JSON.stringify(notes2))
      check('splashHandover: unreadable receipt is not deleted', readFileSync(receiptPath, 'utf8') === payload)
    }
  })
}

async function proveStartupMenu(): Promise<void> {
  const sm = await import('../../src/platform/substrate/startupMenu.js')
  const bn = await import('../../src/platform/substrate/bootNotes.js')
  await withScratchHome(home => {
    const file = join(home, 'boot-env.json')
    const corrupt = '{not-json'
    writeFileSync(file, corrupt, { mode: 0o600 })
    const rCorrupt = sm.writeBootEnvChoice('MERCURY_COMPUTER_ACCESS', 'full', file)
    check('startupMenu: writeBootEnvChoice refuses corrupt file', !rCorrupt.ok && readFileSync(file, 'utf8') === corrupt, JSON.stringify(rCorrupt))
    const sCorrupt = sm.saveBootDefaultsProfile({ MERCURY_COMPUTER_ACCESS: 'full' }, file)
    check('startupMenu: saveBootDefaultsProfile refuses corrupt file', !sCorrupt.ok && readFileSync(file, 'utf8') === corrupt, JSON.stringify(sCorrupt))

    if (POSIX_MODES) {
      const saved = JSON.stringify({ version: 1, savedAt: new Date().toISOString(), env: { MERCURY_COMPUTER_ACCESS: 'permissive', MERCURY_SKIP_PERMISSIONS: '1' }, revision: 4, digest: 'abc', receipt: 'ok' })
      writeFileSync(file, saved, { mode: 0o600 })
      chmodSync(file, 0o200)
      bn._resetBootNotesForTesting()
      const env: NodeJS.ProcessEnv = { MERCURY_ENTER_MENU: '1' }
      const applied = sm.applyBootMenuEnv(file, env)
      const wRes = sm.writeBootEnvChoice('MERCURY_COMPUTER_ACCESS', 'full', file)
      const sRes = sm.saveBootDefaultsProfile({ MERCURY_COMPUTER_ACCESS: 'full' }, file)
      chmodSync(file, 0o600)
      check('startupMenu: applyBootMenuEnv reports unreadable file in refused and boot notes', applied !== null && applied.refused.length === 1 && bn.bootNotes().some(n => n.text.includes('could not be read')), JSON.stringify({ applied, notes: bn.bootNotes() }))
      check('startupMenu: writeBootEnvChoice refuses unreadable file and preserves bytes', !wRes.ok && readFileSync(file, 'utf8') === saved, JSON.stringify(wRes))
      check('startupMenu: saveBootDefaultsProfile refuses unreadable file and preserves bytes', !sRes.ok && readFileSync(file, 'utf8') === saved, JSON.stringify(sRes))
    }
  })
}

async function proveStateLifecycle(): Promise<void> {
  const sl = await import('../../src/platform/substrate/stateLifecycle.js')
  await withScratchHome(async home => {
    const buildDir = join(home, 'runtime', 'builds', 'broken-build')
    mkdirSync(buildDir, { recursive: true })
    writeFileSync(join(buildDir, 'manifest.json'), '{not-valid-json')
    let threw = false
    try {
      await sl.installedBuildFacts(home)
    } catch {
      threw = true
    }
    check('stateLifecycle: corrupt build manifest throws instead of dropping versions from keep set', threw)
  })
}

async function provePauseCarry(): Promise<void> {
  const bootstrap = await import('../../src/boot/process-state/processState.js')
  const pc = await import('../../src/engine/tasks/local-agent/pauseCarry.js')
  const { getCommandQueue, resetCommandQueue } = await import('../../src/screen/composer/input-core/command-queue.js')
  const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.js')
  await withScratchHome(async home => {
    const project = join(home, 'proj')
    mkdirSync(project, { recursive: true })
    bootstrap.setOriginalCwd(project)
    bootstrap.setProjectRoot(project)
    bootstrap.setCwdState(project)
    bootstrap.switchSession('00000000-0000-4000-8000-00000000f024' as never, project)

    const corruptId = 'corrupt01'
    const corruptPath = pc.agentPauseRecordPath(corruptId)
    mkdirSync(join(corruptPath, '..'), { recursive: true })
    writeFileSync(corruptPath, '{corrupt-json', { mode: 0o600 })
    let parseThrew = false
    try {
      await pc.readAgentPauseRecord(corruptId)
    } catch {
      parseThrew = true
    }
    check('pauseCarry: corrupt pause file throws from readAgentPauseRecord', parseThrew)

    resetCommandQueue()
    let state = getDefaultAppState()
    await pc.carryPausedCrewmatesOnResume({
      getAppState: () => state,
      setAppState: updater => { state = updater(state) },
      relaunchContext: async () => ({} as never),
    })
    const notices = getCommandQueue().map(c => String(c.value))
    check('pauseCarry: corrupt pause file surfaces notice during resume carry', notices.some(n => n.includes(corruptId) && n.includes('could not be resumed automatically')), JSON.stringify(notices))

    if (POSIX_MODES) {
      const lockedId = 'locked01'
      const lockedPath = pc.agentPauseRecordPath(lockedId)
      writeFileSync(lockedPath, JSON.stringify({ description: 'x', armedAt: Date.now(), pause: { why: 'usage limit', words: 'wait', resumesAtMs: Date.now() + 60_000 } }), { mode: 0o600 })
      chmodSync(lockedPath, 0o200)
      let eaccesCode: string | undefined
      try {
        await pc.readAgentPauseRecord(lockedId)
      } catch (e) {
        eaccesCode = (e as NodeJS.ErrnoException).code
      } finally {
        chmodSync(lockedPath, 0o600)
      }
      check('pauseCarry: unreadable pause file throws EACCES', eaccesCode === 'EACCES', String(eaccesCode))
    }
  })
}

async function proveTaskLaunchLedger(): Promise<void> {
  const bootstrap = await import('../../src/boot/process-state/processState.js')
  const { getTranscriptPathForSession } = await import('../../src/sessions/transcripts/paths.js')
  const tl = await import('../../src/engine/tasks/taskLaunchLedger.js')
  await withScratchHome(async home => {
    const project = join(home, 'proj')
    mkdirSync(project, { recursive: true })
    bootstrap.setOriginalCwd(project)
    bootstrap.setProjectRoot(project)
    bootstrap.setCwdState(project)
    const sid = '00000000-0000-4000-8000-00000000f025'
    bootstrap.switchSession(sid as never, project)
    const ledgerPath = join(getTranscriptPathForSession(sid), '..', `${sid}.task-launches.json`)
    mkdirSync(join(ledgerPath, '..'), { recursive: true })

    const corrupt = '{not-json'
    writeFileSync(ledgerPath, corrupt, { mode: 0o600 })
    await tl.recordTaskLaunch(sid, { taskId: 't2', kind: 'shell', toolUseId: 'u2', description: 'd', command: 'echo 2', persistent: false, outputPath: null, pid: null, armedAt: Date.now() })
    check('taskLaunchLedger: recordTaskLaunch preserves corrupt ledger', readFileSync(ledgerPath, 'utf8') === corrupt)

    if (POSIX_MODES) {
      const existing = JSON.stringify({ v: 1, launches: [{ v: 1, taskId: 't1', kind: 'shell', toolUseId: 'u1', description: 'd1', command: 'sleep 1', persistent: false, outputPath: null, pid: 12345, startToken: null, armedAt: 1 }] })
      writeFileSync(ledgerPath, existing, { mode: 0o600 })
      chmodSync(ledgerPath, 0o200)
      try {
        await tl.recordTaskLaunch(sid, { taskId: 't2', kind: 'shell', toolUseId: 'u2', description: 'd2', command: 'echo 2', persistent: false, outputPath: null, pid: null, armedAt: Date.now() })
        await tl.settleTaskLaunch(sid, 't1')
      } finally {
        chmodSync(ledgerPath, 0o600)
      }
      check('taskLaunchLedger: unreadable ledger is preserved byte-for-byte after record/settle', readFileSync(ledgerPath, 'utf8') === existing)
    }
  })
}

async function proveTaskOutcomeEnvelope(): Promise<void> {
  const bootstrap = await import('../../src/boot/process-state/processState.js')
  const toe = await import('../../src/engine/tasks/taskOutcomeEnvelope.js')
  await withScratchHome(async home => {
    const project = join(home, 'proj')
    mkdirSync(project, { recursive: true })
    bootstrap.setOriginalCwd(project)
    bootstrap.setProjectRoot(project)
    bootstrap.setCwdState(project)

    const sid1 = '00000000-0000-4000-8000-00000000f026'
    bootstrap.switchSession(sid1 as never, project)
    const p1 = toe.taskOutcomesPath(sid1)
    mkdirSync(join(p1, '..'), { recursive: true })
    const corrupt = '{not-json'
    writeFileSync(p1, corrupt, { mode: 0o600 })
    await toe.recordTaskOutcome(sid1, { taskId: 'e2', taskType: 'local_bash', command: 'echo 2', spawn: 'confirmed', state: 'succeeded', exitCode: 0, interrupted: false, startTime: 1, endTime: 2 })
    check('taskOutcomeEnvelope: recordTaskOutcome preserves corrupt file', readFileSync(p1, 'utf8') === corrupt)

    if (POSIX_MODES) {
      const sid2 = '00000000-0000-4000-8000-00000000f027'
      bootstrap.switchSession(sid2 as never, project)
      const p2 = toe.taskOutcomesPath(sid2)
      const existing = JSON.stringify({ v: 1, envelopes: [{ v: 1, taskId: 'e1', taskType: 'local_bash', command: 'echo 1', spawn: 'confirmed', state: 'succeeded', exitCode: 0, interrupted: false, startTime: 1, endTime: 2, durationMs: 1 }] })
      writeFileSync(p2, existing, { mode: 0o600 })
      chmodSync(p2, 0o200)
      try {
        await toe.recordTaskOutcome(sid2, { taskId: 'e2', taskType: 'local_bash', command: 'echo 2', spawn: 'confirmed', state: 'succeeded', exitCode: 0, interrupted: false, startTime: 1, endTime: 2 })
      } finally {
        chmodSync(p2, 0o600)
      }
      check('taskOutcomeEnvelope: recordTaskOutcome preserves unreadable file', readFileSync(p2, 'utf8') === existing)
      const after = await toe.loadTaskOutcomes(sid2)
      check('taskOutcomeEnvelope: failed read did not poison cache', after.some(e => e.taskId === 'e1'), JSON.stringify(after))
    }
  })
}

async function proveTools(): Promise<void> {
  const bun = process.execPath
  const toolsPath = realpathSync(join(import.meta.dir, '../../src/tools/kit/toolList.ts'))
  const logPath = realpathSync(join(import.meta.dir, '../../src/platform/logs/errorLog.ts'))
  const bashToolPath = realpathSync(join(import.meta.dir, '../../src/tools/shell/BashTool.tsx'))
  const toolTypePath = realpathSync(join(import.meta.dir, '../../src/tools/kit/tool.ts'))
  await withScratchHome(home => {
    const script = `
      import { mock } from 'bun:test'
      const logged = []
      const realLog = await import(${JSON.stringify(logPath)})
      mock.module(${JSON.stringify(logPath)}, () => ({
        ...realLog,
        logError: err => { logged.push(err instanceof Error ? err.message : String(err)) },
      }))
      const realBash = await import(${JSON.stringify(bashToolPath)})
      mock.module(${JSON.stringify(bashToolPath)}, () => ({
        ...realBash,
        BashTool: {
          ...realBash.BashTool,
          isEnabled: () => { throw new Error('isEnabled-boom') },
        },
      }))
      const { getEmptyToolPermissionContext } = await import(${JSON.stringify(toolTypePath)})
      const { getTools } = await import(${JSON.stringify(toolsPath)})
      const tools = getTools(getEmptyToolPermissionContext())
      process.stdout.write('\\n' + JSON.stringify({ logged, hasOtherTools: tools.length > 0, hasBash: tools.some(t => t.name === 'Bash') }))
    `
    const res = spawnSync(bun, ['-e', script], { encoding: 'utf8', env: { ...process.env, MERCURY_CONFIG_DIR: home } })
    if (res.status !== 0) {
      check('tools: settledTools subprocess ran', false, res.stderr.slice(-400))
      return
    }
    const out = JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as { logged?: string[]; hasOtherTools?: boolean; hasBash?: boolean }
    check('tools: throwing isEnabled logs error and omits only the broken tool', Array.isArray(out.logged) && out.logged.includes('isEnabled-boom') && out.hasOtherTools === true && out.hasBash === false, JSON.stringify(out))
  })
}

async function main(): Promise<void> {
  await proveLaunchMilestones()
  await proveOperationJournal()
  await provePidLock()
  await proveStoreRecovery()
  await proveRecoveryOrchestrator()
  await proveSplashHandover()
  await proveStartupMenu()
  await proveStateLifecycle()
  await provePauseCarry()
  await proveTaskLaunchLedger()
  await proveTaskOutcomeEnvelope()
  await proveTools()
  console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
