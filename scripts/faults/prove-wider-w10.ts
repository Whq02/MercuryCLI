#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const HERE = dirname(fileURLToPath(import.meta.url))
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')

function runScenario(body: string, extraEnv: Record<string, string> = {}): Record<string, unknown> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'wider-w10-')))
  const userHome = join(scratch, 'userhome')
  const home = join(scratch, 'home')
  const project = join(scratch, 'project')
  mkdirSync(userHome, { recursive: true })
  mkdirSync(home, { recursive: true })
  mkdirSync(project, { recursive: true })
  const src = `
    process.env.HOME = ${JSON.stringify(userHome)}
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    process.env.MERCURY_CREDENTIAL_STORE = 'file'
    process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
    process.env.NODE_ENV = 'test'
    delete process.env.MERCURY_HOME
    globalThis.MACRO = { VERSION: '1.0.12' }
    process.chdir(${JSON.stringify(project)})
    const USER_HOME = ${JSON.stringify(userHome)}
    const HOME = ${JSON.stringify(home)}
    const PROJECT = ${JSON.stringify(project)}
    const SRC = ${JSON.stringify(SRC)}
    const out = {}
    ${body}
    process.stdout.write('\\n' + JSON.stringify(out))
    process.exit(0)
  `
  try {
    const res = spawnSync(BUN, ['-e', src], {
      encoding: 'utf8',
      env: { ...process.env, HOME: userHome, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '', MERCURY_CREDENTIAL_STORE: 'file', ...extraEnv },
      timeout: 30_000,
    })
    if (res.status !== 0) throw new Error(`scenario exited ${res.status}: ${res.stderr.slice(-1500)}`)
    const line = res.stdout.trim().split('\n').pop() ?? '{}'
    return JSON.parse(line) as Record<string, unknown>
  } finally {
    try {
      chmodSync(join(home, 'versions'), 0o700)
    } catch {}
    rmSync(scratch, { recursive: true, force: true })
  }
}

console.log('\n§1 w10-1 — channelStatus and mercury update --status report unreadable versions dir and launcher')
{
  const r = runScenario(`
    const { chmodSync, mkdirSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { listInstalledVersions, resolveLayoutRoots, shimStatus } = await import(SRC + '/services/privateChannel/installLayout.ts')
    const { channelStatus } = await import(SRC + '/services/privateChannel/updateService.ts')
    const { update } = await import(SRC + '/cli/update.ts')
    const roots = resolveLayoutRoots()
    mkdirSync(roots.versionsDir, { recursive: true })
    mkdirSync(roots.shimPath, { recursive: true })
    chmodSync(roots.versionsDir, 0o000)
    try {
      out.plainVersions = listInstalledVersions(roots)
      out.plainShim = shimStatus(roots)
      const st = await channelStatus(roots)
      out.versionsReadError = st.versionsReadError ?? null
      out.shim = st.shim
      out.shimReadError = st.shimReadError ?? null
      const chunks = []
      const origOut = process.stdout.write.bind(process.stdout)
      const origErr = console.error
      const origExit = process.exit
      process.stdout.write = ((c) => { chunks.push(String(c)); return true })
      console.error = ((...a) => { chunks.push(a.map(String).join(' ')) })
      process.exit = (() => { throw new Error('__EXIT__') })
      try {
        await update({ status: true })
      } catch {} finally {
        process.stdout.write = origOut
        console.error = origErr
        process.exit = origExit
      }
      out.printed = chunks.join('\\n')
      out.shimPath = roots.shimPath
    } finally {
      chmodSync(roots.versionsDir, 0o700)
    }
  `)
  const printed = String(r.printed ?? '')
  check('w10-1: listInstalledVersions keeps []', Array.isArray(r.plainVersions) && r.plainVersions.length === 0, JSON.stringify(r.plainVersions))
  check('w10-1: shimStatus keeps absent', r.plainShim === 'absent', String(r.plainShim))
  check('w10-1: channelStatus reports versionsReadError', typeof r.versionsReadError === 'string' && r.versionsReadError.length > 0, String(r.versionsReadError))
  check('w10-1: channelStatus reports shimReadError', r.shim === 'unreadable' && typeof r.shimReadError === 'string' && r.shimReadError.length > 0, JSON.stringify({ shim: r.shim, err: r.shimReadError }))
  check('w10-1: update --status prints unreadable versions sentence', printed.includes('installed versions could not be read ('), printed)
  check('w10-1: update --status prints unreadable launcher sentence', printed.includes(`the launcher at ${String(r.shimPath)} could not be read (`), printed)
}

console.log('\n§2 w10-2 — unparseable MERCURY_GH_CMD runs plain gh and prints notice once in cli/update')
{
  const r = runScenario(`
    const { chmodSync, existsSync, mkdirSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const binDir = join(PROJECT, 'fakebin')
    const marker = join(PROJECT, 'plain-gh-ran')
    mkdirSync(binDir, { recursive: true })
    const fakeGh = join(binDir, 'gh')
    writeFileSync(fakeGh, '#!/bin/sh\\necho ran >> ' + JSON.stringify(marker) + '\\necho true\\n')
    chmodSync(fakeGh, 0o755)
    process.env.PATH = binDir + ':' + (process.env.PATH ?? '')
    process.env.MERCURY_UPDATE_CHANNEL_REPO = 'example/mercury'
    process.env.MERCURY_GH_CMD = '{bad json'
    const { update } = await import(SRC + '/cli/update.ts')
    const errs = []
    const origOut = process.stdout.write.bind(process.stdout)
    const origErr = console.error
    const origExit = process.exit
    process.stdout.write = (() => true)
    console.error = ((...a) => { errs.push(a.map(String).join(' ')) })
    process.exit = (() => { throw new Error('__EXIT__') })
    try {
      await update({ status: true })
    } catch {} finally {
      process.stdout.write = origOut
      console.error = origErr
      process.exit = origExit
    }
    out.plainRan = existsSync(marker)
    out.errs = errs
  `)
  const errs = Array.isArray(r.errs) ? (r.errs as string[]) : []
  const matches = errs.filter(
    l => l.includes('MERCURY_GH_CMD is not a JSON list of strings (') && l.includes('), so it is not used and plain gh ran; fix or unset it.'),
  )
  check('w10-2: plain gh still ran', r.plainRan === true, JSON.stringify(r))
  check('w10-2: cli/update prints skipped MERCURY_GH_CMD sentence once', matches.length === 1, JSON.stringify(errs))
}

console.log('\n§3 w10-3 — zsh startup probe failure still writes ~/.zshrc and surfaces note in cli/installVerb')
{
  const r = runScenario(`
    const { chmodSync, mkdirSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { ensureBinDirOnPath, realPathEntryIo } = await import(SRC + '/services/privateChannel/installPath.ts')
    const { describePathOutcome } = await import(SRC + '/cli/installVerb.ts')
    const roots = {
      versionsDir: join(HOME, 'versions'),
      binDir: join(USER_HOME, '.local', 'bin'),
      shimPath: join(USER_HOME, '.local', 'bin', 'mercury'),
      isWindows: false,
    }
    const appended = []
    const io = {
      env: { SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' },
      home: USER_HOME,
      readFile: () => null,
      appendFile: (p, t) => appended.push({ p, t }),
      writeFile: () => {},
      removeFile: () => {},
      resolveCommand: () => null,
      zshDotDir: () => { throw new Error('zsh probe timed out') },
      readUserPath: () => ({ state: 'absent' }),
      writeUserPath: () => {},
    }
    const outcome = ensureBinDirOnPath(roots, io)
    out.outcome = outcome
    out.described = describePathOutcome(outcome, false, USER_HOME)
    out.appendedCount = appended.length

    const fakeBin = join(PROJECT, 'fake-zsh-bin')
    mkdirSync(fakeBin, { recursive: true })
    const fakeZsh = join(fakeBin, 'zsh')
    writeFileSync(fakeZsh, '#!/bin/sh\\nexit 2\\n')
    chmodSync(fakeZsh, 0o755)
    process.env.PATH = fakeBin
    process.env.SHELL = '/bin/zsh'
    delete process.env.ZDOTDIR
    const realOutcome = ensureBinDirOnPath(roots, realPathEntryIo())
    out.realOutcome = realOutcome
    out.realDescribed = describePathOutcome(realOutcome, false, USER_HOME)
  `)
  const expected = 'zsh could not be asked for its startup folder (zsh probe timed out), so the PATH line went to ~/.zshrc; move it if your zsh reads another folder.'
  const outcome = r.outcome as { state?: string; note?: string } | undefined
  const realOutcome = r.realOutcome as { state?: string; note?: string } | undefined
  check('w10-3: ensureBinDirOnPath writes ~/.zshrc and sets note on thrown zshDotDir', outcome?.state === 'written' && outcome?.note === expected, JSON.stringify(outcome))
  check('w10-3: describePathOutcome prints the note', String(r.described ?? '').includes(expected), String(r.described))
  check(
    'w10-3: realPathEntryIo carries note when zsh exits non-zero',
    realOutcome?.state === 'written' && typeof realOutcome?.note === 'string' && realOutcome.note.includes('zsh could not be asked for its startup folder (') && String(r.realDescribed ?? '').includes('move it if your zsh reads another folder.'),
    JSON.stringify({ realOutcome, realDescribed: r.realDescribed }),
  )
}

console.log('\n§4 w10-4 — cockpit heartbeat reports whether it landed and beat retries failed registration or heartbeat')
{
  const r = runScenario(`
    const { existsSync, rmSync } = await import('node:fs')
    const mod = await import(SRC + '/daemon/processSweepRun.ts')
    const reg1 = await mod.registerCockpit({ terminal: null, home: HOME, daemonDirPath: HOME + '/daemon' })
    out.reg1Ok = reg1 !== null
    out.beatOk = reg1 ? await reg1.heartbeat() : null
    if (reg1) rmSync(reg1.path, { force: true })
    out.beatMissing = reg1 ? await reg1.heartbeat() : null
    out.hasBeatHelper = typeof mod.beatCockpitRegistration === 'function'
    if (typeof mod.beatCockpitRegistration === 'function') {
      let calls = 0
      const register = () => {
        calls++
        return mod.registerCockpit({ terminal: null, home: HOME, daemonDirPath: HOME + '/daemon' })
      }
      const recoveredFromNull = await mod.beatCockpitRegistration(null, register)
      out.recoveredFromNull = recoveredFromNull !== null && existsSync(recoveredFromNull.path)
      if (recoveredFromNull) rmSync(recoveredFromNull.path, { force: true })
      const recoveredFromMiss = await mod.beatCockpitRegistration(recoveredFromNull, register)
      out.recoveredFromMiss = recoveredFromMiss !== null && recoveredFromMiss.id !== recoveredFromNull?.id && existsSync(recoveredFromMiss.path)
      out.registerCalls = calls
      await recoveredFromMiss?.clear()
    }
  `)
  check('w10-4: heartbeat returns true when utimes lands', r.reg1Ok === true && r.beatOk === true, JSON.stringify(r))
  check('w10-4: heartbeat returns false when utimes fails', r.beatMissing === false, JSON.stringify(r))
  check('w10-4: beatCockpitRegistration retries failed initial registration and failed heartbeat', r.hasBeatHelper === true && r.recoveredFromNull === true && r.recoveredFromMiss === true && r.registerCalls === 2, JSON.stringify(r))
}

console.log('\n§5 w10-5 — daemon status reports unreadable or damaged daemon record instead of not running')
{
  const r = runScenario(`
    const { mkdirSync, rmSync, writeFileSync } = await import('node:fs')
    const { dirname } = await import('node:path')
    const { daemonStatePath } = await import(SRC + '/daemon/controlSocket.ts')
    const { formatMercuryDaemonStatus, getMercuryDaemonStatus } = await import(SRC + '/daemon/status.ts')
    const statePath = daemonStatePath()
    out.statePath = statePath
    const absent = await getMercuryDaemonStatus()
    out.absentErr = absent.daemonRecordError ?? null
    out.absentText = formatMercuryDaemonStatus(absent)

    mkdirSync(dirname(statePath), { recursive: true })
    writeFileSync(statePath, '{not json')
    const corrupt = await getMercuryDaemonStatus()
    out.corruptErr = corrupt.daemonRecordError ?? null
    out.corruptText = formatMercuryDaemonStatus(corrupt)

    rmSync(statePath, { force: true })
    mkdirSync(statePath, { recursive: true })
    const unreadable = await getMercuryDaemonStatus()
    out.unreadableErr = unreadable.daemonRecordError ?? null
    out.unreadableText = formatMercuryDaemonStatus(unreadable)
  `)
  const statePath = String(r.statePath ?? '')
  const prefix = `the daemon record at ${statePath} could not be read (`
  check('w10-5: absent record still says not running with no error', r.absentErr === null && String(r.absentText ?? '').includes('not running'), JSON.stringify({ err: r.absentErr, text: r.absentText }))
  check('w10-5: corrupt record reports unreadable daemon record sentence', typeof r.corruptErr === 'string' && r.corruptErr.startsWith(prefix) && String(r.corruptText ?? '').includes(prefix) && !String(r.corruptText ?? '').includes('not running'), JSON.stringify({ err: r.corruptErr, text: r.corruptText }))
  check('w10-5: unreadable record reports unreadable daemon record sentence', typeof r.unreadableErr === 'string' && r.unreadableErr.startsWith(prefix) && String(r.unreadableText ?? '').includes(prefix) && !String(r.unreadableText ?? '').includes('not running'), JSON.stringify({ err: r.unreadableErr, text: r.unreadableText }))
}

console.log('\n§6 w10-6 — health rows throw strictly on unreadable launch-milestones, operation-journal, and crash-reports')
{
  const r = runScenario(`
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { dirname } = await import('node:path')
    const { launchMilestonesPath, lastBootReachedInputLive } = await import(SRC + '/substrate/launchMilestones.ts')
    const { launchSpineCheck } = await import(SRC + '/utils/health/sections/crew/boot.ts')
    const { listJournalOperations } = await import(SRC + '/substrate/operationJournal.ts')
    const { changeSetJournalDir } = await import(SRC + '/services/changeTransaction/changeSetContracts.ts')
    const { durabilityChecks } = await import(SRC + '/utils/health/sections/durability.ts')
    const { crashReportDir, listCrashReports } = await import(SRC + '/utils/crashReport.ts')
    const { crashReportsCheck } = await import(SRC + '/utils/health/sections/runtime/host.ts')

    mkdirSync(launchMilestonesPath(), { recursive: true })
    out.bootSafe = lastBootReachedInputLive()
    try {
      out.bootProbe = await launchSpineCheck().run()
      out.bootThrew = null
    } catch (e) {
      out.bootThrew = e instanceof Error ? e.message : String(e)
    }

    const jDir = changeSetJournalDir()
    mkdirSync(dirname(jDir), { recursive: true })
    writeFileSync(jDir, 'not-a-dir')
    out.journalSafe = await listJournalOperations(jDir)
    try {
      const spec = durabilityChecks().find(c => c.id === 'durable-journals')
      out.journalProbe = await spec.run()
      out.journalThrew = null
    } catch (e) {
      out.journalThrew = e instanceof Error ? e.message : String(e)
    }

    const cDir = crashReportDir()
    mkdirSync(dirname(cDir), { recursive: true })
    writeFileSync(cDir, 'not-a-dir')
    out.crashSafe = listCrashReports(3)
    try {
      out.crashProbe = await crashReportsCheck().run()
      out.crashThrew = null
    } catch (e) {
      out.crashThrew = e instanceof Error ? e.message : String(e)
    }
  `)
  check('w10-6: launchSpineCheck throws on unreadable milestones while non-strict reader keeps null', r.bootSafe === null && typeof r.bootThrew === 'string' && r.bootThrew.length > 0, JSON.stringify({ safe: r.bootSafe, threw: r.bootThrew, probe: r.bootProbe }))
  check('w10-6: durable-journals throws on unreadable journal dir while non-strict reader keeps []', Array.isArray(r.journalSafe) && r.journalSafe.length === 0 && typeof r.journalThrew === 'string' && r.journalThrew.length > 0, JSON.stringify({ safe: r.journalSafe, threw: r.journalThrew, probe: r.journalProbe }))
  check('w10-6: crashReportsCheck throws on unreadable crash dir while non-strict reader keeps []', Array.isArray(r.crashSafe) && r.crashSafe.length === 0 && typeof r.crashThrew === 'string' && r.crashThrew.length > 0, JSON.stringify({ safe: r.crashSafe, threw: r.crashThrew, probe: r.crashProbe }))
}

console.log('\n§7 w10-7 — resolveGitDir does not cache null on transient/permission error reading .git')
{
  const r = runScenario(`
    const { chmodSync, mkdirSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { clearResolveGitDirCache, resolveGitDir } = await import(SRC + '/utils/git/gitFilesystem.ts')
    const repo = join(PROJECT, 'git-transient')
    const realGit = join(PROJECT, 'real-gitdir')
    mkdirSync(repo, { recursive: true })
    mkdirSync(realGit, { recursive: true })
    const dotGit = join(repo, '.git')
    writeFileSync(dotGit, 'gitdir: ' + realGit + '\\n')
    chmodSync(dotGit, 0o000)
    clearResolveGitDirCache()
    try {
      out.whileUnreadable = await resolveGitDir(repo)
    } finally {
      chmodSync(dotGit, 0o644)
    }
    out.afterRecover = await resolveGitDir(repo)
    out.expected = realGit
  `)
  check('w10-7: returns null while .git file is unreadable (EACCES)', r.whileUnreadable === null, JSON.stringify(r))
  check('w10-7: does not cache null so recovery succeeds without cache clear', r.afterRecover === r.expected, JSON.stringify(r))
}

console.log('\n§8 w10-8 — createBaselineWorktree catches scratch lease error, cleans up added worktree, returns refusal')
{
  const r = runScenario(`
    const { execFileSync } = await import('node:child_process')
    const { existsSync, mkdirSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const tmpBase = join(PROJECT, 'tmpbase')
    mkdirSync(tmpBase, { recursive: true })
    process.env.MERCURY_TMPDIR = tmpBase
    const repo = join(PROJECT, 'repo')
    mkdirSync(repo, { recursive: true })
    const sh = (args) => execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@l', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@l' },
    })
    sh(['init', '--quiet', '--initial-branch=main'])
    writeFileSync(join(repo, 'a.txt'), 'v1\\n')
    sh(['add', '.'])
    sh(['commit', '--quiet', '-m', 'v1'])
    const sha = sh(['rev-parse', 'HEAD']).trim()
    const { getProjectTempDir } = await import(SRC + '/utils/permissions/filesystem.ts')
    const projTmp = getProjectTempDir()
    mkdirSync(projTmp, { recursive: true })
    writeFileSync(join(projTmp, 'scratch-leases.json'), '{not json')
    const { createBaselineWorktree } = await import(SRC + '/utils/worktree.ts')
    const targetPath = join(projTmp, 'baselines', sha.slice(0, 12))
    try {
      out.result = await createBaselineWorktree(sha, repo)
      out.threw = null
    } catch (e) {
      out.result = null
      out.threw = e instanceof Error ? e.message : String(e)
    }
    out.targetLeftBehind = existsSync(targetPath)
    out.worktrees = sh(['worktree', 'list', '--porcelain']).split('\\n').filter(l => l.startsWith('worktree ')).length
  `)
  const res = r.result as { ok?: boolean; reason?: string } | null
  check('w10-8: does not reject and returns { ok: false, reason } naming scratch lease error', r.threw === null && res?.ok === false && typeof res.reason === 'string' && res.reason.includes('scratch lease registry') && res.reason.includes('could not be read'), JSON.stringify(r))
  check('w10-8: removes newly added baseline worktree on lease error', r.targetLeftBehind === false && r.worktrees === 1, JSON.stringify(r))
}

console.log('\n§9 w10-9 — getSettingsWithAllErrors passes over ConfigAccessBeforeAllowedError and reports real MCP read throws')
{
  const r = runScenario(`
    delete process.env.NODE_ENV
    const { mkdirSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { getSettingsWithAllErrors } = await import(SRC + '/utils/settings/allErrors.ts')
    const { enableConfigs } = await import(SRC + '/utils/config.ts')
    out.beforeAllowedErrors = getSettingsWithAllErrors().errors
    enableConfigs()
    mkdirSync(join(HOME, '.mercury.json'), { recursive: true })
    out.afterUnreadableErrors = getSettingsWithAllErrors().errors
  `)
  const before = Array.isArray(r.beforeAllowedErrors) ? (r.beforeAllowedErrors as Array<{ message?: string }>) : []
  const after = Array.isArray(r.afterUnreadableErrors) ? (r.afterUnreadableErrors as Array<{ message?: string; mcpErrorMetadata?: { scope?: string } }>) : []
  check('w10-9: Config accessed before allowed guard is passed over with zero errors', before.length === 0, JSON.stringify(before))
  check(
    'w10-9: real MCP config read throw appends Failed to read MCP configuration file error',
    after.some(e => typeof e.message === 'string' && e.message.startsWith('Failed to read MCP configuration file:') && e.mcpErrorMetadata?.scope === 'user'),
    JSON.stringify(after),
  )
}

console.log(failures === 0 ? '\nprove-wider-w10: all green' : `\nprove-wider-w10: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
