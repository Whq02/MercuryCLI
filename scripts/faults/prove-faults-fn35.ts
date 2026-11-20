#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { utimes } from 'node:fs/promises'
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

async function runWorktreeRows(): Promise<void> {
  const { cleanupStaleAgentWorktrees, createAgentWorktree, keepWorktree, prepareWorktreeFiles, restoreWorktreeSession } = await import('../../src/utils/worktree.ts')
  const { runWithCwdOverride } = await import('../../src/utils/cwd.ts')
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'proof',
    GIT_AUTHOR_EMAIL: 'proof@invalid',
    GIT_COMMITTER_NAME: 'proof',
    GIT_COMMITTER_EMAIL: 'proof@invalid',
  }
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] }).trim()

  const repo = join(SCRATCH, 'wt-repo')
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\nsecret.env\n')
  writeFileSync(join(repo, 'app.ts'), 'export const x = 1\n')
  git(repo, 'add', '.gitignore', 'app.ts')
  git(repo, 'commit', '-q', '-m', 'init')

  if (POSIX_MODES) {
    const wt1 = join(SCRATCH, 'wt-prep-1')
    mkdirSync(wt1, { recursive: true })
    const includeFile = join(repo, '.worktreeinclude')
    writeFileSync(includeFile, 'secret.env\n')
    chmodSync(includeFile, 0o200)
    let includeErr: unknown = null
    try {
      await prepareWorktreeFiles(repo, wt1)
    } catch (error) {
      includeErr = error
    } finally {
      chmodSync(includeFile, 0o600)
    }
    check('worktree: unreadable .worktreeinclude throws EACCES', (includeErr as NodeJS.ErrnoException | null)?.code === 'EACCES', String(includeErr))

    chmodSync(includeFile, 0o200)
    let launchErr: unknown = null
    try {
      await createAgentWorktree('agent-a1111111', { from: repo, foldersBehindLaunch: true })
    } catch (error) {
      launchErr = error
    } finally {
      chmodSync(includeFile, 0o600)
      rmSync(includeFile, { force: true })
    }
    check('worktree: foldersBehindLaunch waits and throws on unreadable .worktreeinclude', (launchErr as NodeJS.ErrnoException | null)?.code === 'EACCES', String(launchErr))

    const localSettingsDir = join(repo, '.mercury')
    mkdirSync(localSettingsDir, { recursive: true })
    const localSettings = join(localSettingsDir, 'settings.local.json')
    writeFileSync(localSettings, '{"guardrails":{}}\n')
    chmodSync(localSettings, 0o200)
    const wt2 = join(SCRATCH, 'wt-prep-2')
    mkdirSync(wt2, { recursive: true })
    let settingsErr: unknown = null
    try {
      await prepareWorktreeFiles(repo, wt2, undefined, false)
    } catch (error) {
      settingsErr = error
    } finally {
      chmodSync(localSettings, 0o600)
      rmSync(localSettings, { force: true })
    }
    check('worktree: unreadable settings.local.json throws on preserveExisting=false', settingsErr instanceof Error && settingsErr.message.includes('The worktree local settings could not be copied'), String(settingsErr))

    const excludeFile = join(repo, '.git', 'info', 'exclude')
    mkdirSync(join(repo, 'node_modules'), { recursive: true })
    writeFileSync(join(repo, 'node_modules', 'pkg.txt'), 'ok\n')
    const excludeBefore = '# keep-my-custom-exclude\n*.bak\n'
    writeFileSync(excludeFile, excludeBefore)
    const wt3 = join(SCRATCH, 'wt-prep-3')
    git(repo, 'worktree', 'add', '-q', '-b', 'wt-prep-3-branch', wt3)
    writeFileSync(join(wt3, '.gitignore'), 'other/\n')
    chmodSync(excludeFile, 0o200)
    try {
      await prepareWorktreeFiles(repo, wt3, repo, false)
      chmodSync(excludeFile, 0o600)
      const excludeAfter = readFileSync(excludeFile, 'utf8')
      check('worktree: unreadable .git/info/exclude is not overwritten', excludeAfter === excludeBefore, `after=${JSON.stringify(excludeAfter)}`)
    } finally {
      chmodSync(excludeFile, 0o600)
    }
  }

  restoreWorktreeSession({
    originalCwd: join(SCRATCH, 'does-not-exist-cwd'),
    worktreePath: join(SCRATCH, 'wt-keep-dummy'),
    worktreeName: 'dummy',
    sessionId: 'sess-1',
  })
  let keepErr: unknown = null
  try {
    await keepWorktree()
  } catch (error) {
    keepErr = error
  } finally {
    restoreWorktreeSession(null)
  }
  check('worktree: keepWorktree rethrows when chdir fails', (keepErr as NodeJS.ErrnoException | null)?.code === 'ENOENT', String(keepErr))

  if (POSIX_MODES) {
    const jRepo = join(SCRATCH, 'wt-janitor-repo')
    mkdirSync(jRepo, { recursive: true })
    git(jRepo, 'init', '-q', '-b', 'main')
    writeFileSync(join(jRepo, 'a.ts'), 'export const a = 1\n')
    git(jRepo, 'add', '.')
    git(jRepo, 'commit', '-q', '-m', 'init')
    const wtHome = join(jRepo, '.mercury', 'worktrees')
    mkdirSync(wtHome, { recursive: true })
    const oldTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)

    const badDotGitDir = join(wtHome, 'parcel-111111111111')
    mkdirSync(badDotGitDir, { recursive: true })
    writeFileSync(join(badDotGitDir, 'keep.txt'), 'precious\n')
    const badDotGit = join(badDotGitDir, '.git')
    writeFileSync(badDotGit, 'gitdir: /nonexistent\n')
    chmodSync(badDotGit, 0o200)
    await utimes(badDotGitDir, oldTime, oldTime)

    const badAdmin = join(SCRATCH, 'wt-janitor-admin')
    mkdirSync(badAdmin, { recursive: true })
    const badGitdirFile = join(badAdmin, 'gitdir')
    writeFileSync(badGitdirFile, join(wtHome, 'parcel-222222222222', '.git') + '\n')
    chmodSync(badGitdirFile, 0o200)
    const badReturnDir = join(wtHome, 'parcel-222222222222')
    mkdirSync(badReturnDir, { recursive: true })
    writeFileSync(join(badReturnDir, 'keep.txt'), 'precious\n')
    writeFileSync(join(badReturnDir, '.git'), `gitdir: ${badAdmin}\n`)
    await utimes(badReturnDir, oldTime, oldTime)

    const realOrphan = join(wtHome, 'parcel-333333333333')
    mkdirSync(realOrphan, { recursive: true })
    writeFileSync(join(realOrphan, 'junk.txt'), 'x\n')
    await utimes(realOrphan, oldTime, oldTime)

    try {
      await runWithCwdOverride(jRepo, () => cleanupStaleAgentWorktrees(new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)))
    } finally {
      if (existsSync(badDotGit)) chmodSync(badDotGit, 0o600)
      if (existsSync(badGitdirFile)) chmodSync(badGitdirFile, 0o600)
    }
    check('worktree: janitor keeps ephemeral dir when .git is unreadable', existsSync(join(badDotGitDir, 'keep.txt')))
    check('worktree: janitor keeps ephemeral dir when admin gitdir is unreadable', existsSync(join(badReturnDir, 'keep.txt')))
    check('worktree: janitor still reaps real orphan dir without .git', !existsSync(realOrphan))
  }
}

try {
  await runUsageHistoryRows()
  await runBaselineRows()
  await runWorktreeRows()
} finally {
  rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
