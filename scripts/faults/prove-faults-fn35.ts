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
  const { readUsageHistory, recordUsageObservations } = await import('../../src/models/usage/usageHistory.ts')
  const storeFile = join(HOME, 'usage-history.json')
  const at = Date.parse('2026-10-23T12:00:00Z')
  const seeded = await recordUsageObservations('fixture', 'acct-1', [{ key: '5h', state: 'live', observedAtMs: at, usedPct: 42 }])
  check('usageHistory: seed store written', seeded === true, 'recordUsageObservations in src/models/usage/usageHistory.ts returned false on a fresh store in the config home')
  const before = readFileSync(storeFile, 'utf8')
  if (POSIX_MODES) {
    chmodSync(storeFile, 0o200)
    try {
      const wrote = await recordUsageObservations('fixture', 'acct-2', [{ key: '5h', state: 'live', observedAtMs: at + 1000, usedPct: 99 }])
      const report = await readUsageHistory()
      chmodSync(storeFile, 0o600)
      const after = readFileSync(storeFile, 'utf8')
      check('usageHistory: unreadable store refuses overwrite on recordUsageObservations', wrote === false && after === before, `wrote=${String(wrote)} preserved=${String(after === before)} | recordUsageObservations in src/models/usage/usageHistory.ts must return false and leave the file untouched when the store cannot be read`)
      check('usageHistory: unreadable store warns and stays intact on readUsageHistory', report.warnings.length > 0 && after === before, JSON.stringify(report.warnings) + ' | readUsageHistory in src/models/usage/usageHistory.ts must add a warning for an unreadable store and not rewrite it')
    } finally {
      chmodSync(storeFile, 0o600)
    }
  }
}

async function runBaselineRows(): Promise<void> {
  const { readWorktreeBaseline, resolveWorktreeAdminDir, writeWorktreeBaseline } = await import('../../src/platform/git/worktree/baseline.ts')
  const wt = join(SCRATCH, 'wt-baseline')
  const admin = join(SCRATCH, 'wt-admin')
  mkdirSync(wt, { recursive: true })
  mkdirSync(admin, { recursive: true })
  const dotGit = join(wt, '.git')
  writeFileSync(dotGit, `gitdir: ${admin}\n`)
  const sha = 'a'.repeat(40)
  await writeWorktreeBaseline(wt, sha)
  check('baseline: readable baseline round-trips', (await readWorktreeBaseline(wt)) === sha, 'writeWorktreeBaseline then readWorktreeBaseline in src/platform/git/worktree/baseline.ts must return the same sha')
  const absentWt = join(SCRATCH, 'wt-absent')
  mkdirSync(absentWt, { recursive: true })
  check('baseline: absent .git returns null', (await resolveWorktreeAdminDir(absentWt)) === null, 'resolveWorktreeAdminDir in src/platform/git/worktree/baseline.ts must return null when the folder has no .git')
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
    check('baseline: unreadable WORKTREE_BASE throws EACCES', (readErr as NodeJS.ErrnoException | null)?.code === 'EACCES', String(readErr) + ' | readWorktreeBaseline in src/platform/git/worktree/baseline.ts must let an EACCES from reading WORKTREE_BASE propagate')

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
    check('baseline: unreadable .git keeps default null and throws with throwOnReadError', defaultAdmin === null && (adminErr as NodeJS.ErrnoException | null)?.code === 'EACCES', `default=${String(defaultAdmin)} err=${String(adminErr)} | resolveWorktreeAdminDir in src/platform/git/worktree/baseline.ts must return null by default and throw EACCES only with throwOnReadError`)

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
    check('baseline: unwritable admin dir throws on writeWorktreeBaseline', (writeErr as NodeJS.ErrnoException | null)?.code === 'EACCES', String(writeErr) + ' | writeWorktreeBaseline in src/platform/git/worktree/baseline.ts must let the EACCES from an unwritable admin dir propagate')
  }
}

async function runWorktreeRows(): Promise<void> {
  const { cleanupStaleCrewmateWorktrees, createCrewmateWorktree, keepWorktree, prepareWorktreeFiles, restoreWorktreeSession } = await import('../../src/platform/git/worktree/worktree.ts')
  const { runWithCwdOverride } = await import('../../src/platform/files/cwd.ts')
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
    check('worktree: an unreadable .worktreeinclude does not fail the preparation', includeErr === null, String(includeErr) + ' | prepareWorktreeFiles in src/platform/git/worktree/worktree.ts must tolerate an unreadable .worktreeinclude without throwing')

    chmodSync(includeFile, 0o200)
    let launchErr: unknown = null
    try {
      await createCrewmateWorktree('agent-a1111111', { from: repo, foldersBehindLaunch: true })
    } catch (error) {
      launchErr = error
    } finally {
      chmodSync(includeFile, 0o600)
      rmSync(includeFile, { force: true })
    }
    check('worktree: createAgentWorktree goes on with an unreadable .worktreeinclude', launchErr === null, String(launchErr) + ' | createAgentWorktree in src/platform/git/worktree/worktree.ts must carry on when .worktreeinclude is unreadable')

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
    check('worktree: unreadable settings.local.json throws on preserveExisting=false', settingsErr instanceof Error && settingsErr.message.includes('The worktree local settings could not be copied'), String(settingsErr) + ' | prepareWorktreeFiles in src/platform/git/worktree/worktree.ts must throw an Error with that message when settings.local.json cannot be read and preserveExisting is false')

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
      check('worktree: unreadable .git/info/exclude is not overwritten', excludeAfter === excludeBefore, `after=${JSON.stringify(excludeAfter)} | prepareWorktreeFiles in src/platform/git/worktree/worktree.ts must leave .git/info/exclude as it was when it cannot be read`)
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
  check('worktree: keepWorktree rethrows when chdir fails', (keepErr as NodeJS.ErrnoException | null)?.code === 'ENOENT', String(keepErr) + ' | keepWorktree in src/platform/git/worktree/worktree.ts must rethrow the chdir error when the original cwd is gone')

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
      await runWithCwdOverride(jRepo, () => cleanupStaleCrewmateWorktrees(new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)))
    } finally {
      if (existsSync(badDotGit)) chmodSync(badDotGit, 0o600)
      if (existsSync(badGitdirFile)) chmodSync(badGitdirFile, 0o600)
    }
    check('worktree: janitor keeps ephemeral dir when .git is unreadable', existsSync(join(badDotGitDir, 'keep.txt')), 'cleanupStaleAgentWorktrees in src/platform/git/worktree/worktree.ts must not remove a stale dir whose .git it cannot read')
    check('worktree: janitor keeps ephemeral dir when admin gitdir is unreadable', existsSync(join(badReturnDir, 'keep.txt')), 'cleanupStaleAgentWorktrees in src/platform/git/worktree/worktree.ts must not remove a stale dir whose admin gitdir file it cannot read')
    check('worktree: janitor still reaps real orphan dir without .git', !existsSync(realOrphan), 'cleanupStaleAgentWorktrees in src/platform/git/worktree/worktree.ts must still remove a stale dir that has no .git')
  }
}

async function runWorktreeCloneRows(): Promise<void> {
  if (!POSIX_MODES) return
  const { cloneIntoWorktree } = await import('../../src/platform/git/worktree/worktreeClone.ts')
  const checkout = join(SCRATCH, 'clone-checkout')
  const wt = join(SCRATCH, 'clone-wt')
  const lockedParent = join(checkout, 'locked')
  const hiddenSource = join(lockedParent, 'deps')
  mkdirSync(hiddenSource, { recursive: true })
  mkdirSync(wt, { recursive: true })
  chmodSync(lockedParent, 0o000)
  try {
    const outcomes = await cloneIntoWorktree(
      [
        { source: hiddenSource, target: join(wt, 'deps') },
        { source: join(checkout, 'does-not-exist'), target: join(wt, 'absent') },
      ],
      checkout,
      wt,
    )
    check(
      'worktreeClone: unreadable source answers failed instead of missing while absent answers missing',
      outcomes[0] === 'failed' && outcomes[1] === 'missing',
      JSON.stringify(outcomes) + ' | cloneIntoWorktree in src/platform/git/worktree/worktreeClone.ts must answer failed for a source it cannot read and missing only for an absent one',
    )
  } finally {
    chmodSync(lockedParent, 0o700)
  }
}

async function runProjectGatesRows(): Promise<void> {
  const { _resetDeclaredGatesForTesting, loadDeclaredGates } = await import('../../src/platform/verification/projectGates.ts')
  const emptyWs = join(SCRATCH, 'pg-empty')
  mkdirSync(emptyWs, { recursive: true })
  _resetDeclaredGatesForTesting()
  check('projectGates: absent gates.json returns empty array', loadDeclaredGates(emptyWs).length === 0, 'loadDeclaredGates in src/platform/verification/projectGates.ts must return an empty array when .mercury/gates.json does not exist')

  const badJsonWs = join(SCRATCH, 'pg-bad-json')
  mkdirSync(join(badJsonWs, '.mercury'), { recursive: true })
  writeFileSync(join(badJsonWs, '.mercury', 'gates.json'), '{not valid json')
  _resetDeclaredGatesForTesting()
  let badJsonErr: unknown = null
  try {
    loadDeclaredGates(badJsonWs)
  } catch (error) {
    badJsonErr = error
  }
  check('projectGates: malformed JSON throws SyntaxError', badJsonErr instanceof SyntaxError, String(badJsonErr) + ' | loadDeclaredGates in src/platform/verification/projectGates.ts must throw SyntaxError for malformed gates.json')

  const badRegexWs = join(SCRATCH, 'pg-bad-regex')
  mkdirSync(join(badRegexWs, '.mercury'), { recursive: true })
  writeFileSync(
    join(badRegexWs, '.mercury', 'gates.json'),
    JSON.stringify({ schema: 1, gates: [{ id: 'bad', argv: ['check.sh'], match: '[unterminated' }] }),
  )
  _resetDeclaredGatesForTesting()
  let badRegexErr: unknown = null
  try {
    loadDeclaredGates(badRegexWs)
  } catch (error) {
    badRegexErr = error
  }
  check('projectGates: invalid match regex throws SyntaxError', badRegexErr instanceof SyntaxError, String(badRegexErr) + ' | loadDeclaredGates in src/platform/verification/projectGates.ts must throw SyntaxError for a gate whose match is not a valid regex')

  if (POSIX_MODES) {
    const unreadableFileWs = join(SCRATCH, 'pg-unreadable-file')
    mkdirSync(join(unreadableFileWs, '.mercury'), { recursive: true })
    const gatesFile = join(unreadableFileWs, '.mercury', 'gates.json')
    writeFileSync(gatesFile, JSON.stringify({ schema: 1, gates: [{ id: 'g1', argv: ['check.sh'] }] }))
    chmodSync(gatesFile, 0o200)
    _resetDeclaredGatesForTesting()
    let readErr: unknown = null
    try {
      loadDeclaredGates(unreadableFileWs)
    } catch (error) {
      readErr = error
    } finally {
      chmodSync(gatesFile, 0o600)
    }
    check('projectGates: unreadable gates.json throws EACCES', (readErr as NodeJS.ErrnoException | null)?.code === 'EACCES', String(readErr) + ' | loadDeclaredGates in src/platform/verification/projectGates.ts must let EACCES from reading gates.json propagate')

    const unreadableDirWs = join(SCRATCH, 'pg-unreadable-dir')
    const dotMercury = join(unreadableDirWs, '.mercury')
    mkdirSync(dotMercury, { recursive: true })
    writeFileSync(join(dotMercury, 'gates.json'), JSON.stringify({ schema: 1, gates: [{ id: 'g2', argv: ['check.sh'] }] }))
    chmodSync(dotMercury, 0o000)
    _resetDeclaredGatesForTesting()
    let statErr: unknown = null
    try {
      loadDeclaredGates(unreadableDirWs)
    } catch (error) {
      statErr = error
    } finally {
      chmodSync(dotMercury, 0o700)
    }
    check('projectGates: stat EACCES on .mercury throws EACCES', (statErr as NodeJS.ErrnoException | null)?.code === 'EACCES', String(statErr) + ' | loadDeclaredGates in src/platform/verification/projectGates.ts must let EACCES from checking the .mercury folder propagate')
  }
}

async function runVerificationStateRows(): Promise<void> {
  const { _resetDeclaredGatesForTesting } = await import('../../src/platform/verification/projectGates.ts')
  const { _resetVerificationStateForTesting, classifyVerifySegment, verificationSummary, workspaceVerifiable } = await import('../../src/platform/verification/verificationState.ts')

  const badJsonWs = join(SCRATCH, 'vs-bad-gates')
  mkdirSync(join(badJsonWs, '.mercury'), { recursive: true })
  writeFileSync(join(badJsonWs, '.mercury', 'gates.json'), '{broken')
  _resetDeclaredGatesForTesting()
  _resetVerificationStateForTesting()
  check(
    'verificationState: a malformed gates.json alone does not put the workspace under the gate',
    workspaceVerifiable(badJsonWs) === false,
    'workspaceVerifiable in src/platform/verification/verificationState.ts must treat a malformed gates.json as no declared gates',
  )
  let clsErr: unknown = null
  let cls: ReturnType<typeof classifyVerifySegment> = null
  try {
    cls = classifyVerifySegment('npm test', badJsonWs)
  } catch (error) {
    clsErr = error
  }
  check(
    'verificationState: classifyVerifySegment does not crash on malformed gates.json',
    clsErr === null && cls?.scope === 'test',
    `err=${String(clsErr)} cls=${JSON.stringify(cls)} | classifyVerifySegment in src/platform/verification/verificationState.ts must catch the gates.json error and classify npm test as scope test`,
  )

  if (POSIX_MODES) {
    const unreadableWs = join(SCRATCH, 'vs-unreadable-gates')
    mkdirSync(join(unreadableWs, '.mercury'), { recursive: true })
    const gatesFile = join(unreadableWs, '.mercury', 'gates.json')
    writeFileSync(gatesFile, JSON.stringify({ schema: 1, gates: [{ id: 'g1', argv: ['run.sh'] }] }))
    chmodSync(gatesFile, 0o200)
    _resetDeclaredGatesForTesting()
    _resetVerificationStateForTesting()
    try {
      check(
        'verificationState: an unreadable gates.json alone does not put the workspace under the gate',
        workspaceVerifiable(unreadableWs) === false,
        'workspaceVerifiable in src/platform/verification/verificationState.ts must treat an unreadable gates.json as no declared gates',
      )
    } finally {
      chmodSync(gatesFile, 0o600)
    }
  }
  const priorPattern = process.env.MERCURY_VERIFY_PATTERN
  process.env.MERCURY_VERIFY_PATTERN = '[unterminated'
  try {
    const badSnap = verificationSummary(badJsonWs, { skipDigest: true })
    check(
      'verificationState: invalid MERCURY_VERIFY_PATTERN surfaces in verificationSummary',
      badSnap.detail.includes('MERCURY_VERIFY_PATTERN is not a valid regular expression (') &&
        badSnap.detail.includes('); fix it so matching commands count as verification.'),
      badSnap.detail + ' | verificationSummary in src/platform/verification/verificationState.ts must put the invalid-pattern note in its detail',
    )
    process.env.MERCURY_VERIFY_PATTERN = 'custom-verify'
    const okSnap = verificationSummary(badJsonWs, { skipDigest: true })
    check(
      'verificationState: valid MERCURY_VERIFY_PATTERN adds no error note',
      !okSnap.detail.includes('MERCURY_VERIFY_PATTERN is not a valid regular expression'),
      okSnap.detail + ' | verificationSummary in src/platform/verification/verificationState.ts must add no pattern note for a valid MERCURY_VERIFY_PATTERN',
    )
  } finally {
    if (priorPattern === undefined) delete process.env.MERCURY_VERIFY_PATTERN
    else process.env.MERCURY_VERIFY_PATTERN = priorPattern
  }
}

try {
  await runUsageHistoryRows()
  await runBaselineRows()
  await runWorktreeRows()
  await runWorktreeCloneRows()
  await runProjectGatesRows()
  await runVerificationStateRows()
} finally {
  rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
