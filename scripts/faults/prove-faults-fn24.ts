#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)
let failures = 0

function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
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
  const m = await import('../../src/substrate/launchMilestones.js')
  await withScratchHome(home => {
    m._resetLaunchMilestonesForTesting()
    check('launchMilestones: missing file returns empty rows', m.readLaunchMilestones().length === 0)
    const file = join(home, 'launch-milestones.json')
    const corrupt = '{not-valid-json'
    writeFileSync(file, corrupt, { mode: 0o600 })
    check('launchMilestones: reader keeps answering empty on corrupt file', m.readLaunchMilestones().length === 0)
    m.recordLaunchMilestone('runtime-entry')
    check('launchMilestones: recordLaunchMilestone preserves corrupt file', readFileSync(file, 'utf8') === corrupt)
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
  const oj = await import('../../src/substrate/operationJournal.js')
  const sr = await import('../../src/substrate/storeRecovery.js')
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
  const pidLockPath = realpathSync(join(import.meta.dir, '../../src/substrate/pidLock.ts'))
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
  const sr = await import('../../src/substrate/storeRecovery.js')
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
  const orch = await import('../../src/substrate/recoveryOrchestrator.js')
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
  const sh = await import('../../src/substrate/splashHandover.js')
  const bn = await import('../../src/substrate/bootNotes.js')
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
  const sm = await import('../../src/substrate/startupMenu.js')
  const bn = await import('../../src/substrate/bootNotes.js')
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
  const sl = await import('../../src/substrate/stateLifecycle.js')
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

async function main(): Promise<void> {
  await proveLaunchMilestones()
  await proveOperationJournal()
  await provePidLock()
  await proveStoreRecovery()
  await proveRecoveryOrchestrator()
  await proveSplashHandover()
  await proveStartupMenu()
  await proveStateLifecycle()
  console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
