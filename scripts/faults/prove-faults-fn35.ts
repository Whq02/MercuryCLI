#!/usr/bin/env bun
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'faults-fn35-')))
const HOME = join(SCRATCH, 'home')
mkdirSync(HOME, { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME

const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

async function runUsageHistoryRows(): Promise<void> {
  const { readUsageHistory, recordUsageObservations } = await import('../../src/utils/usageHistory.ts')
  const storeFile = join(HOME, 'usage-history.json')
  const at = Date.parse('2026-10-23T12:00:00Z')
  const seeded = await recordUsageObservations('fixture', 'acct-1', [{ key: '5h', state: 'live', observedAtMs: at, usedPct: 42 }])
  check('usageHistory: seed store written', seeded === true)
  const before = readFileSync(storeFile, 'utf8')
  if (POSIX_MODES) {
    chmodSync(storeFile, 0o200)
    try {
      const wrote = await recordUsageObservations('fixture', 'acct-2', [{ key: '5h', state: 'live', observedAtMs: at + 1000, usedPct: 99 }])
      const report = await readUsageHistory()
      chmodSync(storeFile, 0o600)
      const after = readFileSync(storeFile, 'utf8')
      check('usageHistory: unreadable store refuses overwrite on recordUsageObservations', wrote === false && after === before, `wrote=${String(wrote)} preserved=${String(after === before)}`)
      check('usageHistory: unreadable store warns and stays intact on readUsageHistory', report.warnings.length > 0 && after === before, JSON.stringify(report.warnings))
    } finally {
      chmodSync(storeFile, 0o600)
    }
  }
}

async function runBaselineRows(): Promise<void> {
  const { readWorktreeBaseline, resolveWorktreeAdminDir, writeWorktreeBaseline } = await import('../../src/utils/worktree/baseline.ts')
  const wt = join(SCRATCH, 'wt-baseline')
  const admin = join(SCRATCH, 'wt-admin')
  mkdirSync(wt, { recursive: true })
  mkdirSync(admin, { recursive: true })
  const dotGit = join(wt, '.git')
  writeFileSync(dotGit, `gitdir: ${admin}\n`)
  const sha = 'a'.repeat(40)
  await writeWorktreeBaseline(wt, sha)
  check('baseline: readable baseline round-trips', (await readWorktreeBaseline(wt)) === sha)
  const absentWt = join(SCRATCH, 'wt-absent')
  mkdirSync(absentWt, { recursive: true })
  check('baseline: absent .git returns null', (await resolveWorktreeAdminDir(absentWt)) === null)
  if (POSIX_MODES) {
    const baseFile = join(admin, 'WORKTREE_BASE')
    chmodSync(baseFile, 0o200)
    let readErr: unknown = null
    try {
      await readWorktreeBaseline(wt)
    } catch (error) {
      readErr = error
    } finally {
      chmodSync(baseFile, 0o600)
    }
    check('baseline: unreadable WORKTREE_BASE throws EACCES', (readErr as NodeJS.ErrnoException | null)?.code === 'EACCES', String(readErr))

    chmodSync(dotGit, 0o200)
    let adminErr: unknown = null
    let defaultAdmin: string | null = 'unset'
    try {
      defaultAdmin = await resolveWorktreeAdminDir(wt)
      await resolveWorktreeAdminDir(wt, { throwOnReadError: true })
    } catch (error) {
      adminErr = error
    } finally {
      chmodSync(dotGit, 0o600)
    }
    check('baseline: unreadable .git keeps default null and throws with throwOnReadError', defaultAdmin === null && (adminErr as NodeJS.ErrnoException | null)?.code === 'EACCES', `default=${String(defaultAdmin)} err=${String(adminErr)}`)

    rmSync(baseFile, { force: true })
    chmodSync(admin, 0o500)
    let writeErr: unknown = null
    try {
      await writeWorktreeBaseline(wt, sha)
    } catch (error) {
      writeErr = error
    } finally {
      chmodSync(admin, 0o700)
    }
    check('baseline: unwritable admin dir throws on writeWorktreeBaseline', (writeErr as NodeJS.ErrnoException | null)?.code === 'EACCES', String(writeErr))
  }
}

try {
  await runUsageHistoryRows()
  await runBaselineRows()
} finally {
  rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
