#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
const W10_FIX_AT: Record<string, string> = {
  '1': 'src/platform/update-channel/installLayout.ts, src/platform/update-channel/updateService.ts (channelStatus) and src/commands/verbs/update.ts',
  '2': 'src/commands/verbs/update.ts',
  '3': 'ensureBinDirOnPath and realPathEntryIo in src/platform/update-channel/installPath.ts, describePathOutcome in src/commands/verbs/installVerb.ts',
  '4': 'registerCockpit and beatCockpitRegistration in src/daemon/process-sweep/processSweepRun.ts',
  '5': 'getMercuryDaemonStatus and formatMercuryDaemonStatus in src/daemon/control/status.ts',
  '6': 'src/platform/substrate/launchMilestones.ts, src/platform/health/sections/crew/boot.ts, src/platform/health/sections/durability.ts, src/platform/health/sections/runtime/host.ts, src/platform/logs/crashReport.ts',
  '7': 'resolveGitDir in src/platform/git/gitFilesystem.ts',
  '9': 'getSettingsWithAllErrors in src/platform/settings-faults/allErrors.ts',
  '10': 'beforeToolHooks in src/engine/tool-dispatch/toolHooks.ts',
  '11': 'matchingRuleForInput in src/permissions/rules/filesystem.ts',
  '12': 'startCommandHook in src/integrations/event-hooks/commandRunner.ts',
  '13': 'addMcpConfig in src/integrations/mcp/serverConfigs.ts, setSwitch in src/integrations/extensions/install.ts, the exit flush in src/platform/settings/config.ts and src/platform/files/file.ts',
}
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  const where = W10_FIX_AT[label.match(/^w10-(\d+)/)?.[1] ?? '']
  const shown = [detail, where ? `change the code under test at ${where}` : ''].filter(Boolean).join(' \u2014 ')
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && shown ? ` \u2014 ${shown}` : ''}`)
}

const HERE = dirname(fileURLToPath(import.meta.url))
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')

function runScenario(body: string, extraEnv: Record<string, string> = {}): Record<string, unknown> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'wider-w10-')))
  const userHome = join(scratch, 'userhome')
  const home = join(scratch, 'home')
  const versionsDir = join(home, 'versions')
  const localAppData = join(userHome, 'AppData', 'Local')
  const appData = join(userHome, 'AppData', 'Roaming')
  const xdgConfigHome = join(userHome, '.config')
  const project = join(scratch, 'project')
  mkdirSync(userHome, { recursive: true })
  mkdirSync(home, { recursive: true })
  mkdirSync(localAppData, { recursive: true })
  mkdirSync(appData, { recursive: true })
  mkdirSync(project, { recursive: true })
  const src = `
    process.env.HOME = ${JSON.stringify(userHome)}
    process.env.USERPROFILE = ${JSON.stringify(userHome)}
    process.env.LOCALAPPDATA = ${JSON.stringify(localAppData)}
    process.env.APPDATA = ${JSON.stringify(appData)}
    process.env.XDG_CONFIG_HOME = ${JSON.stringify(xdgConfigHome)}
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    process.env.MERCURY_VERSIONS_DIR = ${JSON.stringify(versionsDir)}
    process.env.MERCURY_CREDENTIAL_STORE = 'file'
    process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
    process.env.NODE_ENV = 'test'
    delete process.env.MERCURY_HOME
    delete process.env.HOMEDRIVE
    delete process.env.HOMEPATH
    globalThis.MACRO = { VERSION: '1.0.12' }
    process.chdir(${JSON.stringify(project)})
    const SCRATCH = ${JSON.stringify(scratch)}
    const USER_HOME = ${JSON.stringify(userHome)}
    const HOME = ${JSON.stringify(home)}
    const PROJECT = ${JSON.stringify(project)}
    const SRC = ${JSON.stringify(SRC)}
    const out = {}
    ${body}
    process.stdout.write('\\n' + JSON.stringify(out))
    process.exit(0)
  `
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: userHome,
    USERPROFILE: userHome,
    LOCALAPPDATA: localAppData,
    APPDATA: appData,
    XDG_CONFIG_HOME: xdgConfigHome,
    MERCURY_CONFIG_DIR: home,
    MERCURY_VERSIONS_DIR: versionsDir,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    ...extraEnv,
  }
  delete childEnv.MERCURY_HOME
  delete childEnv.HOMEDRIVE
  delete childEnv.HOMEPATH
  try {
    const res = spawnSync(BUN, ['-e', src], {
      encoding: 'utf8',
      env: childEnv,
      timeout: 30_000,
    })
    if (res.status !== 0) throw new Error(`scenario exited ${res.status}: ${res.stderr.slice(-1500)}`)
    const line = res.stdout.trim().split('\n').pop() ?? '{}'
    return JSON.parse(line) as Record<string, unknown>
  } finally {
    try {
      chmodSync(versionsDir, 0o700)
    } catch {}
    rmSync(scratch, { recursive: true, force: true })
  }
}

console.log('\n§1 w10-1 — channelStatus and mercury update --status report unreadable versions dir and launcher')
{
  const r = runScenario(`
    const { chmodSync, mkdirSync, writeFileSync } = await import('node:fs')
    const { isAbsolute, join, relative, resolve } = await import('node:path')
    const { listInstalledVersions, resolveLayoutRoots, shimStatus } = await import(SRC + '/platform/update-channel/installLayout.ts')
    const { channelStatus } = await import(SRC + '/platform/update-channel/updateService.ts')
    const { update } = await import(SRC + '/commands/verbs/update.ts')
    const roots = resolveLayoutRoots()
    const base = resolve(SCRATCH)
    for (const p of [roots.versionsDir, roots.binDir, roots.shimPath, ...(roots.shimSetPaths ?? [])]) {
      const rel = relative(base, resolve(p))
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
        throw new Error('resolved layout root escapes scratch: ' + p)
      }
    }
    out.rootsUnderScratch = true
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
  check('w10-1: every resolved layout root lies under the scenario scratch folder', r.rootsUnderScratch === true, JSON.stringify(r))
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
    const { update } = await import(SRC + '/commands/verbs/update.ts')
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
    const { ensureBinDirOnPath, realPathEntryIo } = await import(SRC + '/platform/update-channel/installPath.ts')
    const { describePathOutcome } = await import(SRC + '/commands/verbs/installVerb.ts')
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
    const mod = await import(SRC + '/daemon/process-sweep/processSweepRun.ts')
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
    const { daemonStatePath } = await import(SRC + '/daemon/control/controlSocket.ts')
    const { formatMercuryDaemonStatus, getMercuryDaemonStatus } = await import(SRC + '/daemon/control/status.ts')
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
    const { launchMilestonesPath, lastBootReachedInputLive } = await import(SRC + '/platform/substrate/launchMilestones.ts')
    const { launchSpineCheck } = await import(SRC + '/platform/health/sections/crew/boot.ts')
    const { listJournalOperations } = await import(SRC + '/platform/substrate/operationJournal.ts')
    const { changeSetJournalDir } = await import(SRC + '/tools/engines/change-transaction/changeSetContracts.ts')
    const { durabilityChecks } = await import(SRC + '/platform/health/sections/durability.ts')
    const { crashReportDir, listCrashReports } = await import(SRC + '/platform/logs/crashReport.ts')
    const { crashReportsCheck } = await import(SRC + '/platform/health/sections/runtime/host.ts')

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
    const { clearResolveGitDirCache, resolveGitDir } = await import(SRC + '/platform/git/gitFilesystem.ts')
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

console.log('\n§9 w10-9 — getSettingsWithAllErrors passes over ConfigAccessBeforeAllowedError and reports real MCP read throws')
{
  const r = runScenario(`
    delete process.env.NODE_ENV
    const { mkdirSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { getSettingsWithAllErrors } = await import(SRC + '/platform/settings-faults/allErrors.ts')
    const { enableConfigs } = await import(SRC + '/platform/settings/config.ts')
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

console.log('\n§10 w10-10 — unreadable hook settings file goes on without refusing and notifies once a session')
{
  const r = runScenario(`
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { resetSettingsCache } = await import(SRC + '/platform/settings/settingsCache.ts')
    const { resetHooksSnapshot } = await import(SRC + '/integrations/event-hooks/hooksConfigSnapshot.ts')
    const { beforeToolHooks } = await import(SRC + '/engine/tool-dispatch/toolHooks.ts')

    const notifs = []
    const ctx = {
      getAppState: () => ({ sessionHooks: new Map(), toolPermissionContext: { mode: 'implement' } }),
      addNotification: (n) => { notifs.push(n) },
    }
    const fakeTool = { name: 'Bash' }
    const ac = new AbortController()

    resetSettingsCache()
    resetHooksSnapshot()
    const absentRes = await beforeToolHooks(fakeTool, 'id-0', {}, ctx, ac.signal)
    out.absentBlocked = absentRes.answer.block ?? null
    out.absentNotifs = notifs.length

    const settingsFile = join(HOME, 'settings.json')
    mkdirSync(settingsFile, { recursive: true })
    resetSettingsCache()
    resetHooksSnapshot()
    const res1 = await beforeToolHooks(fakeTool, 'id-1', {}, ctx, ac.signal)
    const res2 = await beforeToolHooks(fakeTool, 'id-2', {}, ctx, ac.signal)
    out.settingsFile = settingsFile
    out.blocked1 = res1.answer.block ?? null
    out.blocked2 = res2.answer.block ?? null
    out.notifs = notifs
  `)
  const settingsFile = String(r.settingsFile ?? '')
  const notifs = Array.isArray(r.notifs) ? (r.notifs as Array<{ text?: string }>) : []
  const prefix = `hook settings at ${settingsFile} could not be read (`
  const suffix = '), so no hook runs — fix the file to bring them back'
  check('w10-10: absent settings emits no notice and does not refuse', r.absentBlocked === null && r.absentNotifs === 0, JSON.stringify(r))
  check('w10-10: unreadable settings does not refuse tool calls', r.blocked1 === null && r.blocked2 === null, JSON.stringify({ b1: r.blocked1, b2: r.blocked2 }))
  check(
    'w10-10: unreadable settings notifies once per session with exact sentence',
    notifs.length === 1 && typeof notifs[0]?.text === 'string' && notifs[0].text.startsWith(prefix) && notifs[0].text.endsWith(suffix),
    JSON.stringify(notifs),
  )
}

console.log('\n§11 w10-11 — rootForSource remembers last good root on throw, and falls back to original cwd for deny only when never computed')
{
  const rA = runScenario(`
    const { mock } = await import('bun:test')
    const { join } = await import('node:path')
    const realEnv = await import(SRC + '/platform/environment/envUtils.ts')
    const origGetMercuryHome = realEnv.getMercuryHome
    let failHome = false
    mock.module(SRC + '/platform/environment/envUtils.js', () => ({
      ...realEnv,
      getMercuryHome: () => {
        if (failHome) throw new Error('homedir unavailable')
        return origGetMercuryHome()
      },
    }))
    const { matchingRuleForInput } = await import(SRC + '/permissions/rules/filesystem.ts')
    const ctx = {
      mode: 'default',
      additionalWorkingDirectories: new Map(),
      alwaysAllowRules: { userSettings: ['Read(/allowed/**)'] },
      alwaysDenyRules: { userSettings: ['Read(/secret/**)'] },
      alwaysAskRules: {},
      isBypassPermissionsModeAvailable: false,
    }
    const secretInHome = join(HOME, 'secret', 'k.txt')
    const allowedInHome = join(HOME, 'allowed', 'ok.txt')
    out.beforeDeny = matchingRuleForInput(secretInHome, ctx, 'read', 'deny') !== null
    out.beforeAllow = matchingRuleForInput(allowedInHome, ctx, 'read', 'allow') !== null
    failHome = true
    out.afterDeny = matchingRuleForInput(secretInHome, ctx, 'read', 'deny') !== null
    out.afterAllow = matchingRuleForInput(allowedInHome, ctx, 'read', 'allow') !== null
  `)
  check('w10-11(a): after computing userSettings root once, throw still denies true target under HOME', rA.beforeDeny === true && rA.afterDeny === true, JSON.stringify(rA))
  check('w10-11(a): after computing userSettings root once, throw still allows true target under HOME', rA.beforeAllow === true && rA.afterAllow === true, JSON.stringify(rA))

  const rB = runScenario(`
    const { mock } = await import('bun:test')
    const { mkdirSync } = await import('node:fs')
    const { join } = await import('node:path')
    const realEnv = await import(SRC + '/platform/environment/envUtils.ts')
    mock.module(SRC + '/platform/environment/envUtils.js', () => ({
      ...realEnv,
      getMercuryHome: () => {
        throw new Error('homedir unavailable')
      },
    }))
    const sub = join(PROJECT, 'sub')
    mkdirSync(sub, { recursive: true })
    const state = await import(SRC + '/boot/process-state/processState.ts')
    state.setOriginalCwd(PROJECT)
    state.setCwdState(sub)
    process.chdir(sub)
    const { matchingRuleForInput } = await import(SRC + '/permissions/rules/filesystem.ts')
    const ctx = {
      mode: 'default',
      additionalWorkingDirectories: new Map(),
      alwaysAllowRules: { userSettings: ['Read(/allowed/**)'] },
      alwaysDenyRules: { userSettings: ['Read(/secret/**)'] },
      alwaysAskRules: {},
      isBypassPermissionsModeAvailable: false,
    }
    out.denyUnderOriginal = matchingRuleForInput(join(PROJECT, 'secret', 'k.txt'), ctx, 'read', 'deny') !== null
    out.allowUnderOriginal = matchingRuleForInput(join(PROJECT, 'allowed', 'ok.txt'), ctx, 'read', 'allow') !== null
    out.allowUnderSub = matchingRuleForInput(join(sub, 'allowed', 'ok.txt'), ctx, 'read', 'allow') !== null
  `)
  check('w10-11(b): never-computed throw roots deny rule at original cwd so it bites', rB.denyUnderOriginal === true, JSON.stringify(rB))
  check('w10-11(b): never-computed throw skips allow rule', rB.allowUnderOriginal === false && rB.allowUnderSub === false, JSON.stringify(rB))
}

console.log('\n§12 w10-12 — extension hook reports real stat error instead of does not exist for unreachable folder')
{
  const r = runScenario(`
    const { chmodSync, mkdirSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { startCommandHook } = await import(SRC + '/integrations/event-hooks/commandRunner.ts')
    const runWithRoot = async (root) => {
      const proc = await startCommandHook({
        command: 'echo hi',
        event: 'tool.before',
        index: 0,
        timeoutMs: 5000,
        payload: {},
        source: { kind: 'extension', name: 'demo', id: 'demo@local', root },
      })
      return proc.result
    }
    const missing = join(PROJECT, 'no-such-ext')
    out.missing = await runWithRoot(missing)

    const blockedParent = join(PROJECT, 'blocked-parent')
    const unreachable = join(blockedParent, 'ext-dir')
    mkdirSync(unreachable, { recursive: true })
    chmodSync(blockedParent, 0o000)
    try {
      out.unreachable = await runWithRoot(unreachable)
    } finally {
      chmodSync(blockedParent, 0o700)
    }
    out.unreachablePath = unreachable
  `)
  const missingDetail = String((r.missing as { ending?: { detail?: string } } | undefined)?.ending?.detail ?? '')
  const unreachDetail = String((r.unreachable as { ending?: { detail?: string } } | undefined)?.ending?.detail ?? '')
  check('w10-12: ENOENT still says Extension folder does not exist', missingDetail.startsWith('Extension folder does not exist:'), missingDetail)
  check(
    'w10-12: non-ENOENT stat error replaces does not exist with error message',
    !unreachDetail.includes('does not exist') && unreachDetail.startsWith('Extension folder ') && unreachDetail.includes(String(r.unreachablePath)) && unreachDetail.includes('EACCES'),
    unreachDetail,
  )
}

console.log('\n§13 w10-13 — held-file rename refusals (R4, R5, R7, R10) show one plain sentence without store internals')
{
  const r457 = runScenario(`
    const { mock } = await import('bun:test')
    const { join } = await import('node:path')
    const realPub = await import(SRC + '/platform/substrate/durablePublish.ts')
    const DurablePublishError = realPub.DurablePublishError
    const makeHeldErr = (targetPath) =>
      new DurablePublishError(
        'rename',
        targetPath,
        Object.assign(new Error("EPERM: operation not permitted, rename 'tmp' -> '" + targetPath + "'"), { code: 'EPERM' }),
        { fsCode: 'EPERM', attempts: 4, elapsedMs: 455, tempCleanup: 'removed' },
      )
    mock.module(SRC + '/platform/substrate/durablePublish.js', () => ({
      ...realPub,
      durableAtomicPublish: async (targetPath) => { throw makeHeldErr(targetPath) },
      durableAtomicPublishSync: (targetPath) => { throw makeHeldErr(targetPath) },
    }))
    const { addMcpConfig } = await import(SRC + '/integrations/mcp/serverConfigs.ts')
    const { setSwitch } = await import(SRC + '/integrations/extensions/install.ts')
    try {
      await addMcpConfig('heldsrv', { type: 'stdio', command: 'node', args: ['-v'] }, 'project')
      out.r4 = null
    } catch (e) {
      out.r4 = e instanceof Error ? e.message : String(e)
    }
    out.r4Path = join(PROJECT, '.mercury', 'mcp.json')
    out.r5 = setSwitch('filmcraft@mercury', false, 'everywhere')
    out.r5Path = join(HOME, 'settings.json')
    out.r7 = setSwitch('filmcraft@mercury', true, 'project', 'shell')
    out.r7Path = join(PROJECT, '.mercury', 'settings.local.json')
  `)
  const r4 = String(r457.r4 ?? '')
  const r5 = (r457.r5 as { ok?: boolean; reason?: string } | undefined) ?? {}
  const r7 = (r457.r7 as { ok?: boolean; reason?: string } | undefined) ?? {}
  const expectR4 = `Could not add MCP server heldsrv: ${String(r457.r4Path)} could not be written (EPERM); nothing was written. Close what holds the file, then try again.`
  const expectR5 = `Could not save settings: ${String(r457.r5Path)} could not be written (EPERM); nothing was written. Close what holds the file, then try again.`
  const expectR7 = `Could not save settings: ${String(r457.r7Path)} could not be written (EPERM); nothing was written. Close what holds the file, then try again.`
  check('w10-13(R4): project mcp add says one plain held-file sentence with no rename/temp internals', r4 === expectR4, r4)
  check('w10-13(R5): user settings switch says one plain held-file sentence with no rename/temp internals', r5.ok === false && r5.reason === expectR5, JSON.stringify(r5))
  check('w10-13(R7): project-local settings switch says one plain held-file sentence with no rename/temp internals', r7.ok === false && r7.reason === expectR7, JSON.stringify(r7))

  const runR10Child = (body: string): { status: number | null; stderr: string; mercuryJson: string | null } => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'wider-w10-r10-')))
    const userHome = join(scratch, 'userhome')
    const home = join(scratch, 'home')
    const versionsDir = join(home, 'versions')
    const localAppData = join(userHome, 'AppData', 'Local')
    const appData = join(userHome, 'AppData', 'Roaming')
    const xdgConfigHome = join(userHome, '.config')
    const project = join(scratch, 'project')
    mkdirSync(userHome, { recursive: true })
    mkdirSync(home, { recursive: true })
    mkdirSync(localAppData, { recursive: true })
    mkdirSync(appData, { recursive: true })
    mkdirSync(project, { recursive: true })
    const script = `
      process.env.HOME = ${JSON.stringify(userHome)}
      process.env.USERPROFILE = ${JSON.stringify(userHome)}
      process.env.LOCALAPPDATA = ${JSON.stringify(localAppData)}
      process.env.APPDATA = ${JSON.stringify(appData)}
      process.env.XDG_CONFIG_HOME = ${JSON.stringify(xdgConfigHome)}
      process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
      process.env.MERCURY_VERSIONS_DIR = ${JSON.stringify(versionsDir)}
      process.env.MERCURY_CREDENTIAL_STORE = 'file'
      process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
      delete process.env.NODE_ENV
      delete process.env.MERCURY_HOME
      delete process.env.HOMEDRIVE
      delete process.env.HOMEPATH
      globalThis.MACRO = { VERSION: '1.0.12' }
      process.chdir(${JSON.stringify(project)})
      const HOME = ${JSON.stringify(home)}
      const SRC = ${JSON.stringify(SRC)}
      ${body}
    `
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: userHome,
      USERPROFILE: userHome,
      LOCALAPPDATA: localAppData,
      APPDATA: appData,
      XDG_CONFIG_HOME: xdgConfigHome,
      MERCURY_CONFIG_DIR: home,
      MERCURY_VERSIONS_DIR: versionsDir,
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
    }
    delete childEnv.MERCURY_HOME
    delete childEnv.HOMEDRIVE
    delete childEnv.HOMEPATH
    try {
      const res = spawnSync(BUN, ['-e', script], {
        encoding: 'utf8',
        env: childEnv,
        timeout: 30_000,
      })
      const cfgPath = join(home, '.mercury.json')
      let mercuryJson: string | null = null
      try {
        mercuryJson = require('node:fs').readFileSync(cfgPath, 'utf8')
      } catch {}
      return { status: res.status, stderr: res.stderr, mercuryJson }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }

  const r10a = runR10Child(`
    const { mock } = await import('bun:test')
    const realFile = await import(SRC + '/platform/files/file.ts')
    const origWrite = realFile.writeFileAndFlushAtomically
    const AtomicWriteRefusal = realFile.AtomicWriteRefusal
    let held = true
    mock.module(SRC + '/platform/files/file.js', () => ({
      ...realFile,
      writeFileAndFlushAtomically: (targetPath, content, opts) => {
        if (held) throw new AtomicWriteRefusal('rename', targetPath, Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }))
        return origWrite(targetPath, content, opts)
      },
    }))
    const { enableConfigs, saveGlobalConfigDeferred } = await import(SRC + '/platform/settings/config.ts')
    enableConfigs()
    saveGlobalConfigDeferred(c => ({ ...c, numStartups: 42 }))
    const { addMcpConfig } = await import(SRC + '/integrations/mcp/serverConfigs.ts')
    try {
      await addMcpConfig('heldu1', { type: 'stdio', command: 'node', args: ['-v'] }, 'user')
    } catch (e) {
      process.stderr.write((e instanceof Error ? e.message : String(e)) + '\\n')
    }
    held = false
    process.exit(1)
  `)
  const parsedA = r10a.mercuryJson ? (JSON.parse(r10a.mercuryJson) as { numStartups?: number }) : null
  check(
    'w10-13(R10a): after a refused save, once the file is free again, exit flush writes pending deferred changes',
    r10a.status === 1 && parsedA?.numStartups === 42,
    `rc=${r10a.status} file=${String(r10a.mercuryJson)} stderr=${r10a.stderr}`,
  )

  const r10b = runR10Child(`
    const { mock } = await import('bun:test')
    const realFile = await import(SRC + '/platform/files/file.ts')
    const AtomicWriteRefusal = realFile.AtomicWriteRefusal
    mock.module(SRC + '/platform/files/file.js', () => ({
      ...realFile,
      writeFileAndFlushAtomically: (targetPath) => {
        throw new AtomicWriteRefusal('rename', targetPath, Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }))
      },
    }))
    const { enableConfigs, saveGlobalConfigDeferred } = await import(SRC + '/platform/settings/config.ts')
    enableConfigs()
    saveGlobalConfigDeferred(c => ({ ...c, numStartups: (c.numStartups ?? 0) + 1 }))
    const { addMcpConfig } = await import(SRC + '/integrations/mcp/serverConfigs.ts')
    try {
      await addMcpConfig('heldu1', { type: 'stdio', command: 'node', args: ['-v'] }, 'user')
      process.exit(0)
    } catch (e) {
      process.stderr.write((e instanceof Error ? e.message : String(e)) + '\\n')
      process.exit(1)
    }
  `)
  const errLinesB = r10b.stderr.split('\n').map(l => l.trim()).filter(Boolean)
  check(
    'w10-13(R10b): file still held at exit after refusal was said prints the refusal once and not twice',
    r10b.status === 1 &&
      errLinesB.length === 1 &&
      /^Could not add MCP server heldu1: .+[/\\]\.mercury\.json could not be written \(EPERM\); nothing was written\. Close what holds the file, then try again\.$/.test(errLinesB[0] ?? ''),
    `rc=${r10b.status} lines=${JSON.stringify(errLinesB)}`,
  )

  const r10c = runR10Child(`
    const { mock } = await import('bun:test')
    const realFile = await import(SRC + '/platform/files/file.ts')
    const AtomicWriteRefusal = realFile.AtomicWriteRefusal
    mock.module(SRC + '/platform/files/file.js', () => ({
      ...realFile,
      writeFileAndFlushAtomically: (targetPath) => {
        throw new AtomicWriteRefusal('rename', targetPath, Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }))
      },
    }))
    const { enableConfigs, saveGlobalConfigDeferred } = await import(SRC + '/platform/settings/config.ts')
    enableConfigs()
    saveGlobalConfigDeferred(c => ({ ...c, numStartups: 99 }))
    process.exit(0)
  `)
  const errLinesC = r10c.stderr.split('\n').map(l => l.trim()).filter(Boolean)
  const expectedFlushRe =
    /^Could not save the settings changed in this session: .+[/\\]\.mercury\.json could not be written \(EPERM\); nothing was written and those changes were lost\. Close what holds the file, then try again\.$/
  check(
    'w10-13(R10c): with no prior refusal, a held-file exit flush prints the unified sentence without naming inner store steps',
    errLinesC.some(l => expectedFlushRe.test(l)) && !r10c.stderr.includes('rename step'),
    `rc=${r10c.status} lines=${JSON.stringify(errLinesC)}`,
  )

  const r10d = runR10Child(`
    const { mock } = await import('bun:test')
    const realFile = await import(SRC + '/platform/files/file.ts')
    const AtomicWriteRefusal = realFile.AtomicWriteRefusal
    mock.module(SRC + '/platform/files/file.js', () => ({
      ...realFile,
      writeFileAndFlushAtomically: (targetPath) => {
        throw new AtomicWriteRefusal('rename', targetPath, Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }))
      },
    }))
    const { enableConfigs, saveGlobalConfig, saveGlobalConfigDeferred } = await import(SRC + '/platform/settings/config.ts')
    enableConfigs()
    saveGlobalConfigDeferred(c => ({ ...c, numStartups: 77 }))
    try {
      saveGlobalConfig(c => ({ ...c, numStartups: 78 }))
    } catch {}
    process.exit(0)
  `)
  const errLinesD = r10d.stderr.split('\n').map(l => l.trim()).filter(Boolean)
  check(
    'w10-13(R10d): when a caller swallows a failed save without saying anything, the held-file exit flush prints the unified sentence',
    errLinesD.some(l => expectedFlushRe.test(l)) && !r10d.stderr.includes('rename step'),
    `rc=${r10d.status} lines=${JSON.stringify(errLinesD)}`,
  )

  const initialBodyE = `${JSON.stringify({ numStartups: 11 }, null, 2)}\n`
  const r10e = runR10Child(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const cfgPath = path.join(HOME, '.mercury.json')
    fs.writeFileSync(cfgPath, ${JSON.stringify(initialBodyE)}, 'utf8')
    const { mock } = await import('bun:test')
    const realFsOps = await import(SRC + '/platform/files/fsOperations.ts')
    const realFs = realFsOps.getFsImplementation()
    let blockRead = false
    mock.module(SRC + '/platform/files/fsOperations.js', () => ({
      ...realFsOps,
      getFsImplementation: () => ({
        ...realFs,
        readFileSync: (filePath, opts) => {
          if (blockRead && String(filePath).endsWith('.mercury.json')) {
            throw Object.assign(new Error("EBUSY: resource busy or locked, open '" + cfgPath + "'"), { code: 'EBUSY' })
          }
          return realFs.readFileSync(filePath, opts)
        },
      }),
    }))
    const { enableConfigs, saveGlobalConfigDeferred } = await import(SRC + '/platform/settings/config.ts')
    enableConfigs()
    saveGlobalConfigDeferred(c => ({ ...c, numStartups: 99 }))
    blockRead = true
    process.exit(0)
  `)
  const errLinesE = r10e.stderr.split('\n').map(l => l.trim()).filter(Boolean)
  const expectedReadFlushRe =
    /^Could not save the settings changed in this session: .+[/\\]\.mercury\.json could not be read \(EBUSY\); nothing was written and those changes were lost\. Close what holds the file, then try again\.$/
  check(
    'w10-13(R10e): with no prior refusal, a read-refused exit flush with deferred saves prints the sentence once and keeps .mercury.json byte-equal',
    errLinesE.length === 1 &&
      expectedReadFlushRe.test(errLinesE[0] ?? '') &&
      r10e.mercuryJson === initialBodyE,
    `rc=${r10e.status} lines=${JSON.stringify(errLinesE)} sameBytes=${String(r10e.mercuryJson === initialBodyE)}`,
  )
  check(
    'w10-13(R10f): read-refused exit flush ends with the same exit status as rename-refused exit flush (R10c)',
    r10e.status === r10c.status,
    `r10e=${String(r10e.status)} r10c=${String(r10c.status)}`,
  )

  const r10g = runR10Child(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const cfgPath = path.join(HOME, '.mercury.json')
    fs.writeFileSync(cfgPath, ${JSON.stringify(initialBodyE)}, 'utf8')
    const { mock } = await import('bun:test')
    const realFsOps = await import(SRC + '/platform/files/fsOperations.ts')
    const realFs = realFsOps.getFsImplementation()
    let blockRead = false
    mock.module(SRC + '/platform/files/fsOperations.js', () => ({
      ...realFsOps,
      getFsImplementation: () => ({
        ...realFs,
        readFileSync: (filePath, opts) => {
          if (blockRead && String(filePath).endsWith('.mercury.json')) {
            throw Object.assign(new Error("EBUSY: resource busy or locked, open '" + cfgPath + "'"), { code: 'EBUSY' })
          }
          return realFs.readFileSync(filePath, opts)
        },
      }),
    }))
    const { enableConfigs } = await import(SRC + '/platform/settings/config.ts')
    enableConfigs()
    blockRead = true
    process.exit(0)
  `)
  const errLinesG = r10g.stderr.split('\n').map(l => l.trim()).filter(Boolean)
  check(
    'w10-13(R10g): control — a read refusal at exit with no deferred save pending prints nothing',
    r10g.status === 0 && errLinesG.length === 0 && r10g.mercuryJson === initialBodyE,
    `rc=${r10g.status} lines=${JSON.stringify(errLinesG)}`,
  )

  const r10h = runR10Child(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const cfgPath = path.join(HOME, '.mercury.json')
    fs.writeFileSync(cfgPath, ${JSON.stringify(initialBodyE)}, 'utf8')
    const { mock } = await import('bun:test')
    const realTimers = await import(SRC + '/platform/async/timers.ts')
    mock.module(SRC + '/platform/async/timers.js', () => ({
      ...realTimers,
      sleepSync: () => {},
    }))
    const realLockfile = await import(SRC + '/platform/storage/lockfile.ts')
    let blockLock = false
    mock.module(SRC + '/platform/storage/lockfile.js', () => ({
      ...realLockfile,
      lockSync: (filePath, opts) => {
        if (blockLock && String(filePath).endsWith('.mercury.json')) {
          throw Object.assign(new Error('Lock file is already being held'), { code: 'ELOCKED' })
        }
        return realLockfile.lockSync(filePath, opts)
      },
    }))
    const { enableConfigs, saveGlobalConfigDeferred } = await import(SRC + '/platform/settings/config.ts')
    enableConfigs()
    saveGlobalConfigDeferred(c => ({ ...c, numStartups: 99 }))
    blockLock = true
    process.exit(0)
  `)
  const errLinesH = r10h.stderr.split('\n').map(l => l.trim()).filter(Boolean)
  const expectedLockFlushRe =
    /^Could not save the settings changed in this session: .+[/\\]\.mercury\.json could not be written \(another Mercury kept its lock\); nothing was written and those changes were lost\. Close what holds the file, then try again\.$/
  check(
    'w10-13(R10h): with no prior refusal, a lock-contention exit flush with deferred saves prints the lock sentence once, keeps .mercury.json byte-equal, and matches R10c status',
    errLinesH.length === 1 &&
      expectedLockFlushRe.test(errLinesH[0] ?? '') &&
      r10h.mercuryJson === initialBodyE &&
      r10h.status === r10c.status,
    `rc=${r10h.status} r10c=${r10c.status} lines=${JSON.stringify(errLinesH)} sameBytes=${String(r10h.mercuryJson === initialBodyE)}`,
  )

  const initialBodyI = `${JSON.stringify({ hasCompletedOnboarding: true, numStartups: 11 }, null, 2)}\n`
  const wipedBodyI = `${JSON.stringify({ numStartups: 11 }, null, 2)}\n`
  const r10i = runR10Child(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const cfgPath = path.join(HOME, '.mercury.json')
    fs.writeFileSync(cfgPath, ${JSON.stringify(initialBodyI)}, 'utf8')
    const { enableConfigs, saveGlobalConfigDeferred } = await import(SRC + '/platform/settings/config.ts')
    enableConfigs()
    saveGlobalConfigDeferred(c => ({ ...c, numStartups: 99 }))
    fs.writeFileSync(cfgPath, ${JSON.stringify(wipedBodyI)}, 'utf8')
    process.exit(0)
  `)
  const errLinesI = r10i.stderr.split('\n').map(l => l.trim()).filter(Boolean)
  const expectedGuardFlushRe =
    /^Could not save the settings changed in this session: .+[/\\]\.mercury\.json was not written over \(it read back without the sign-in this session holds\); nothing was written and those changes were lost\. Set them again next time\.$/
  check(
    'w10-13(R10i): with no prior refusal, an auth-wipe guard refusal at exit flush prints the guard sentence once, keeps .mercury.json byte-equal to the second write, and matches R10c status',
    errLinesI.length === 1 &&
      expectedGuardFlushRe.test(errLinesI[0] ?? '') &&
      r10i.mercuryJson === wipedBodyI &&
      r10i.status === r10c.status,
    `rc=${r10i.status} r10c=${r10c.status} lines=${JSON.stringify(errLinesI)} sameBytes=${String(r10i.mercuryJson === wipedBodyI)}`,
  )

  const r10j = runR10Child(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const cfgPath = path.join(HOME, '.mercury.json')
    fs.writeFileSync(cfgPath, ${JSON.stringify(initialBodyI)}, 'utf8')
    const { enableConfigs, getGlobalConfig } = await import(SRC + '/platform/settings/config.ts')
    enableConfigs()
    getGlobalConfig()
    fs.writeFileSync(cfgPath, ${JSON.stringify(wipedBodyI)}, 'utf8')
    process.exit(0)
  `)
  const errLinesJ = r10j.stderr.split('\n').map(l => l.trim()).filter(Boolean)
  check(
    'w10-13(R10j): control — auth-wipe condition at exit with no deferred save pending prints nothing',
    r10j.status === 0 && errLinesJ.length === 0 && r10j.mercuryJson === wipedBodyI,
    `rc=${r10j.status} lines=${JSON.stringify(errLinesJ)}`,
  )
}

console.log(failures === 0 ? '\nprove-wider-w10: all green' : `\nprove-wider-w10: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
