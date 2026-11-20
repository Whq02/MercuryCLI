#!/usr/bin/env bun
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

async function main(): Promise<void> {
  await proveLaunchMilestones()
  await proveOperationJournal()
  console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
