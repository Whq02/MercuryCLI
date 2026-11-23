#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}${!cond ? ' — fix the failure path in the src file named by the heading line above this check so the read or write error is reported (EACCES, ELOOP, EBUSY) and not swallowed; the JSON shows what the probe returned' : ''}`)
}
function skip(label: string, why: string): void {
  console.log(`  [SKIP] ${label} — ${why}`)
}

const HERE = dirname(fileURLToPath(import.meta.url))
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')
const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

function runCase(body: string): Record<string, unknown> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'faults-fn06-')))
  const home = join(scratch, 'home')
  const project = join(scratch, 'project')
  for (const dir of [home, project]) mkdirSync(dir, { recursive: true })
  const src = `
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
    process.env.NODE_ENV = 'test'
    delete process.env.MERCURY_HOME
    globalThis.MACRO = { VERSION: '1.0.0' }
    process.chdir(${JSON.stringify(project)})
    const fs = await import('node:fs')
    const path = await import('node:path')
    const home = ${JSON.stringify(home)}
    const project = ${JSON.stringify(project)}
    const SRC = ${JSON.stringify(SRC)}
    const out = {}
    ${body}
    process.stdout.write('\\n' + JSON.stringify(out))
    process.exit(0)
  `
  try {
    const res = spawnSync(BUN, ['-e', src], {
      encoding: 'utf8',
      env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '' },
    })
    if (res.status !== 0) throw new Error(`case failed: ${res.stderr.slice(-1500)} — the probe script for the src file named by the heading line above crashed; read the stderr tail and fix that module or its import path under PROVE_SRC`)
    return JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

console.log('\nsrc/screen/keys/loadUserBindings.ts')
if (!POSIX_MODES) {
  skip('keybindings-sync-unreadable', 'needs non-root POSIX chmod')
  skip('keybindings-async-project-unreadable', 'needs non-root POSIX chmod')
} else {
  const r = runCase(`
    const { enableConfigs } = await import(${JSON.stringify(join(SRC, 'platform/config/globalConfig.ts'))})
    const { setPathTrusted } = await import(${JSON.stringify(join(SRC, 'platform/config/trust.ts'))})
    const kb = await import(${JSON.stringify(join(SRC, 'screen/keys/loadUserBindings.ts'))})
    enableConfigs()
    setPathTrusted(project)
    out.absentSync = kb.loadKeybindingsSyncWithWarnings().warnings
    const userFile = kb.getKeybindingsPath()
    fs.writeFileSync(userFile, '{"bindings":[]}', { mode: 0o600 })
    fs.chmodSync(userFile, 0o200)
    kb.invalidateKeybindingsCache()
    out.unreadableSync = kb.loadKeybindingsSyncWithWarnings().warnings
    fs.chmodSync(userFile, 0o600)
    fs.unlinkSync(userFile)

    const projDir = path.join(project, '.mercury')
    const projFile = path.join(projDir, 'keybindings.json')
    fs.mkdirSync(projDir, { recursive: true })
    fs.writeFileSync(projFile, '{"bindings":[]}', { mode: 0o600 })
    fs.chmodSync(projFile, 0o200)
    out.unreadableAsyncProject = (await kb.loadKeybindings()).warnings
    kb.invalidateKeybindingsCache()
    out.unreadableSyncProject = kb.loadKeybindingsSyncWithWarnings().warnings
    fs.chmodSync(projFile, 0o600)
  `)
  const absentSync = r.absentSync as Array<{ message: string }>
  const unreadableSync = r.unreadableSync as Array<{ type: string; severity: string; message: string }>
  const unreadableAsyncProject = r.unreadableAsyncProject as Array<{ type: string; severity: string; message: string }>
  const unreadableSyncProject = r.unreadableSyncProject as Array<{ type: string; severity: string; message: string }>
  check(
    'keybindings-sync-unreadable',
    absentSync.length === 0 &&
      unreadableSync.some(w => w.type === 'parse_error' && w.severity === 'error' && w.message.startsWith('Could not read the user keybindings file:')) &&
      unreadableSyncProject.some(w => w.type === 'parse_error' && w.severity === 'error' && w.message.startsWith('Could not read the project keybindings file:')),
    JSON.stringify({ absentSync, unreadableSync, unreadableSyncProject }),
  )
  check(
    'keybindings-async-project-unreadable',
    unreadableAsyncProject.some(w => w.type === 'parse_error' && w.severity === 'error' && w.message.startsWith('Could not read the project keybindings file:')),
    JSON.stringify(unreadableAsyncProject),
  )
}

console.log('\nsrc/sessions/mneme/mnemeCorrect.ts')
if (!POSIX_MODES) {
  skip('strike-pending-unreadable-dir', 'needs non-root POSIX chmod')
} else {
  const r = runCase(`
    const buf = await import(${JSON.stringify(join(SRC, 'sessions/mneme/mnemeBuffer.ts'))})
    const cor = await import(${JSON.stringify(join(SRC, 'sessions/mneme/mnemeCorrect.ts'))})
    const dir = path.join(home, 'mneme-strike-test')
    fs.mkdirSync(dir, { recursive: true })
    buf.appendObservation({ text: 'a pending fact', source: 'test' }, dir)
    const ts = buf.pendingRows(dir)[0].ts
    fs.chmodSync(dir, 0o300)
    try {
      out.result = cor.strikePendingRow({ ts, dir })
    } finally {
      fs.chmodSync(dir, 0o700)
    }
    out.stillThere = buf.pendingRows(dir).some(row => row.ts === ts)
  `)
  const result = r.result as { ok: boolean; code?: string; message?: string }
  check(
    'strike-pending-unreadable-dir',
    result.ok === false && result.code === 'error' && /EACCES/i.test(result.message ?? '') && r.stillThere === true,
    JSON.stringify(r),
  )
}
console.log('\nsrc/sessions/mneme/mnemeFrontPage.ts')
if (!POSIX_MODES) {
  skip('front-page-unreadable-throws', 'needs non-root POSIX chmod')
} else {
  const r = runCase(`
    const fp = await import(${JSON.stringify(join(SRC, 'sessions/mneme/mnemeFrontPage.ts'))})
    const dir = path.join(home, 'mneme-front-page-test')
    fs.mkdirSync(dir, { recursive: true })
    out.absent = fp.readFrontPage(dir)
    const file = fp.frontPagePath(dir)
    fs.writeFileSync(file, '# Memory\\n', { mode: 0o600 })
    fs.chmodSync(file, 0o200)
    try {
      out.unreadable = fp.readFrontPage(dir)
    } catch (e) {
      out.threw = { code: e?.code ?? null, message: String(e?.message ?? e) }
    } finally {
      fs.chmodSync(file, 0o600)
    }
  `)
  const threw = r.threw as { code: string | null; message: string } | undefined
  check(
    'front-page-unreadable-throws',
    r.absent === null && threw?.code === 'EACCES',
    JSON.stringify(r),
  )
}
console.log('\nsrc/sessions/mneme/mnemeHandover.ts')
{
  const r = runCase(`
    const ho = await import(${JSON.stringify(join(SRC, 'sessions/mneme/mnemeHandover.ts'))})
    const notesDir = path.join(home, 'ho-eloop')
    fs.mkdirSync(notesDir, { recursive: true })
    try {
      fs.symlinkSync(path.join(notesDir, 'b.md'), path.join(notesDir, 'a.md'))
      fs.symlinkSync(path.join(notesDir, 'a.md'), path.join(notesDir, 'b.md'))
    } catch (e) {
      if (process.platform === 'win32' && e?.code === 'EPERM') {
        out.noSymlink = true
      } else {
        throw e
      }
    }
    if (!out.noSymlink) {
      try {
        out.listed = ho.listOldNotes(notesDir)
      } catch (e) {
        out.threw = { code: e?.code ?? null, message: String(e?.message ?? e) }
      }
    }
  `)
  if (r.noSymlink === true) {
    skip('handover-stat-failure-not-dropped', 'not read on Windows: no symlink privilege')
  } else {
    const threw = r.threw as { code: string | null } | undefined
    check('handover-stat-failure-not-dropped', threw?.code === 'ELOOP', JSON.stringify(r))
  }
}
if (!POSIX_MODES) {
  skip('handover-unreadable-notes-dir', 'needs non-root POSIX chmod')
  skip('handover-unreadable-receipt-not-rerun', 'needs non-root POSIX chmod')
  skip('handover-receipt-write-failure-throws', 'needs non-root POSIX chmod')
} else {
  const r = runCase(`
    const ho = await import(${JSON.stringify(join(SRC, 'sessions/mneme/mnemeHandover.ts'))})
    const dir1 = path.join(home, 'ho-unreadable-dir')
    fs.mkdirSync(dir1, { recursive: true })
    fs.writeFileSync(path.join(dir1, 'note.md'), 'remember this')
    fs.chmodSync(dir1, 0o000)
    try {
      out.due1 = ho.handoverDue(dir1)
    } catch (e) {
      out.dirThrew = e?.code ?? String(e)
    } finally {
      fs.chmodSync(dir1, 0o700)
    }

    const dir2 = path.join(home, 'ho-unreadable-receipt')
    const lib2 = path.join(dir2, 'library')
    fs.mkdirSync(lib2, { recursive: true })
    fs.writeFileSync(path.join(dir2, 'old.md'), 'old note body')
    const receiptFile = ho.handoverReceiptPath(lib2)
    const keptBytes = '{"version":1,"ranAt":"2026-01-01T00:00:00.000Z","notes":1}'
    fs.writeFileSync(receiptFile, keptBytes, { mode: 0o600 })
    fs.chmodSync(receiptFile, 0o200)
    out.outsideReceipt = ho.readHandoverReceipt(lib2)
    try {
      out.due2 = ho.handoverDue(dir2)
    } catch (e) {
      out.dueReceiptThrew = e?.code ?? String(e)
    }
    try {
      out.run2 = ho.handoverMemoryDir(dir2)
    } catch (e) {
      out.runReceiptThrew = e?.code ?? String(e)
    }
    fs.chmodSync(receiptFile, 0o600)
    out.receiptSame = fs.readFileSync(receiptFile, 'utf8') === keptBytes

    const dir3 = path.join(home, 'ho-unwritable-receipt')
    const lib3 = path.join(dir3, 'library')
    fs.mkdirSync(lib3, { recursive: true })
    fs.chmodSync(lib3, 0o500)
    try {
      out.run3 = ho.handoverMemoryDir(dir3)
    } catch (e) {
      out.writeThrew = e?.code ?? String(e)
    } finally {
      fs.chmodSync(lib3, 0o700)
    }
  `)
  check('handover-unreadable-notes-dir', r.dirThrew === 'EACCES', JSON.stringify(r))
  check(
    'handover-unreadable-receipt-not-rerun',
    r.outsideReceipt === null && r.dueReceiptThrew === 'EACCES' && r.runReceiptThrew === 'EACCES' && r.receiptSame === true,
    JSON.stringify(r),
  )
  check('handover-receipt-write-failure-throws', typeof r.writeThrew === 'string' && /EACCES|DurablePublishError/i.test(r.writeThrew), JSON.stringify(r))
}
console.log('\nsrc/sessions/mneme/ledger.ts')
if (!POSIX_MODES) {
  skip('ledger-reconcile-unreadable-workers-fails-closed', 'needs non-root POSIX chmod')
  skip('ledger-open-entry-unwritable-throws', 'needs non-root POSIX chmod')
} else {
  const r = runCase(`
    const ledger = await import(${JSON.stringify(join(SRC, 'sessions/mneme/ledger.ts'))})
    const paths = await import(${JSON.stringify(join(SRC, 'sessions/mneme/paths.ts'))})
    const key = 'proj-reconcile-test'
    const lineFile = paths.lineagePath(key)
    fs.mkdirSync(path.dirname(lineFile), { recursive: true })
    const oldEntry = {
      ordinal: 1,
      sessionId: 'sess-live-no-pid',
      startedAt: '2020-01-01T00:00:00.000Z',
      endedAt: null,
      engines: [{ model: 'm', at: '2020-01-01T00:00:00.000Z' }],
      rulings: [],
      retained: [],
      corrected: [],
      files: [],
      outcome: null,
      handoff: null,
    }
    fs.writeFileSync(lineFile, JSON.stringify(oldEntry) + '\\n', 'utf8')
    const workersFile = ledger.sessionWorkersFile()
    fs.mkdirSync(path.dirname(workersFile), { recursive: true })
    fs.writeFileSync(workersFile, '{"version":1,"workers":{}}', { mode: 0o600 })
    fs.chmodSync(workersFile, 0o200)
    out.liveWhileUnreadable = ledger.liveSessions(key)
    out.reconciledUnreadable = ledger.reconcileInterruptedEntries(key, 'sess-cur', () => '2020-01-01T00:05:00.000Z')
    fs.chmodSync(workersFile, 0o600)
    fs.writeFileSync(workersFile, '{torn json', 'utf8')
    out.liveWhileTorn = ledger.liveSessions(key)
    out.reconciledTorn = ledger.reconcileInterruptedEntries(key, 'sess-cur', () => '2020-01-01T00:05:00.000Z')
    fs.unlinkSync(workersFile)
    out.reconciledAbsent = ledger.reconcileInterruptedEntries(key, 'sess-cur', () => '2020-01-01T00:05:00.000Z')

    const roKey = 'proj-open-ro'
    const roFile = paths.lineagePath(roKey)
    fs.mkdirSync(path.dirname(roFile), { recursive: true })
    fs.chmodSync(path.dirname(roFile), 0o500)
    try {
      out.opened = ledger.openEntry(roKey, { sessionId: 's-ro', model: 'm' })
    } catch (e) {
      out.openThrew = e?.code ?? String(e)
    } finally {
      fs.chmodSync(path.dirname(roFile), 0o700)
    }
  `)
  check(
    'ledger-reconcile-unreadable-workers-fails-closed',
    Array.isArray(r.liveWhileUnreadable) &&
      (r.liveWhileUnreadable as unknown[]).length === 0 &&
      (r.reconciledUnreadable as unknown[]).length === 0 &&
      Array.isArray(r.liveWhileTorn) &&
      (r.liveWhileTorn as unknown[]).length === 0 &&
      (r.reconciledTorn as unknown[]).length === 0 &&
      (r.reconciledAbsent as unknown[]).length === 1,
    JSON.stringify(r),
  )
  check('ledger-open-entry-unwritable-throws', r.openThrew === 'EACCES', JSON.stringify(r))
}
console.log('\nsrc/sessions/mneme/mnemeConsolidate.ts')
if (!POSIX_MODES) {
  skip('consolidate-claim-buffer-unwritable-throws', 'needs non-root POSIX chmod')
  skip('consolidate-unreadable-dir-reports-error', 'needs non-root POSIX chmod')
} else {
  const r = runCase(`
    const buf = await import(${JSON.stringify(join(SRC, 'sessions/mneme/mnemeBuffer.ts'))})
    const con = await import(${JSON.stringify(join(SRC, 'sessions/mneme/mnemeConsolidate.ts'))})
    const dir1 = path.join(home, 'con-claim-ro')
    fs.mkdirSync(dir1, { recursive: true })
    buf.appendObservation({ text: 'fact to claim', source: 'test' }, dir1)
    fs.chmodSync(dir1, 0o500)
    try {
      out.claimed = con.claimBufferFile(dir1, 'striking')
    } catch (e) {
      out.claimThrew = e?.code ?? String(e)
    } finally {
      fs.chmodSync(dir1, 0o700)
    }

    const dir2 = path.join(home, 'con-unreadable-dir')
    fs.mkdirSync(dir2, { recursive: true })
    fs.chmodSync(dir2, 0o000)
    try {
      out.consolidateRes = con.maybeConsolidate({ dir: dir2 })
    } finally {
      fs.chmodSync(dir2, 0o700)
    }
  `)
  const consolidateRes = r.consolidateRes as { consolidated: boolean; reason: string } | undefined
  check('consolidate-claim-buffer-unwritable-throws', r.claimThrew === 'EACCES', JSON.stringify(r))
  check(
    'consolidate-unreadable-dir-reports-error',
    consolidateRes?.consolidated === false && /^error:/i.test(consolidateRes.reason) && /EACCES/i.test(consolidateRes.reason),
    JSON.stringify(r),
  )
}
{
  const r = runCase(`
    const { mock } = await import('bun:test')
    const dpPath = path.join(SRC, 'substrate/durablePublish.ts')
    const realDp = await import(dpPath)
    mock.module(dpPath, () => ({
      ...realDp,
      renameWithWin32RetrySync: () => {
        const err = new Error('EBUSY: resource busy')
        err.code = 'EBUSY'
        throw err
      },
    }))
    const buf = await import(${JSON.stringify(join(SRC, 'sessions/mneme/mnemeBuffer.ts'))})
    const con = await import(${JSON.stringify(join(SRC, 'sessions/mneme/mnemeConsolidate.ts'))})
    const dir = path.join(home, 'con-rename-ebusy')
    fs.mkdirSync(dir, { recursive: true })
    buf.appendObservation({ text: 'fact to rename', source: 'test' }, dir)
    out.res = con.maybeConsolidate({ dir, force: true })
  `)
  const res = r.res as { consolidated: boolean; reason: string } | undefined
  check(
    'consolidate-consume-rename-failure-reports-error',
    res?.consolidated === false && /^error:/i.test(res.reason) && /EBUSY/i.test(res.reason),
    JSON.stringify(r),
  )
}
console.log('\nsrc/boot/main/runLaunch.ts')
{
  const r = runCase(`
    const { mock } = await import('bun:test')
    mock.module(path.join(SRC, 'utils/permissions/bypassPermissionsKillswitch.ts'), () => ({
      checkAndDisableSovereignIfNeeded: async () => {
        throw new Error('killswitch policy check failed')
      },
    }))
    mock.module(path.join(SRC, 'cli/run.ts'), () => ({
      runHeadless: async (_prompt, getAppState) => {
        const ctx = getAppState().toolPermissionContext
        out.mode = ctx.mode
        out.available = ctx.isBypassPermissionsModeAvailable
      },
    }))
    process.env.MERCURY_BARE = '1'
    const stderrLines = []
    const realStderrWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = (chunk) => { stderrLines.push(String(chunk)); return true }
    const { getEmptyToolPermissionContext } = await import(${JSON.stringify(join(SRC, 'tools/kit/tool.ts'))})
    const { runLaunch } = await import(${JSON.stringify(join(SRC, 'boot/main/runLaunch.ts'))})
    await runLaunch({
      opts: { continue: true, onlyMcp: true },
      commands: [],
      prompt: 'hi',
      permissionMode: 'sovereign',
      toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'sovereign', isBypassPermissionsModeAvailable: true },
      allowDangerousSkip: true,
      mcpConfigPromise: Promise.resolve({}),
      thinkingConfig: { type: 'disabled' },
      userSpecifiedModel: undefined,
      fallbackModel: undefined,
      mainThreadAgentDefinition: undefined,
      activeAgents: [],
      allAgents: [],
      customSystemPrompt: undefined,
      appendSystemPrompt: undefined,
      inputFormat: 'text',
      outputFormat: 'text',
      includePartialMessages: false,
      door: 'rows',
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    process.stderr.write = realStderrWrite
    out.stderr = stderrLines.join('')
  `)
  check(
    'runlaunch-killswitch-throw-stays-on-and-says-so',
    r.mode === 'sovereign' &&
      r.available === true &&
      String(r.stderr ?? '').includes("bypass permissions stays on: your organization's security policy could not be checked (killswitch policy check failed)"),
    JSON.stringify(r),
  )
}
console.log('\nsrc/boot/main/interactiveLaunch.ts')
{
  const r = runCase(`
    const { mock } = await import('bun:test')
    const inkPath = path.join(SRC, 'ink.ts')
    const realInk = await import(inkPath)
    mock.module(inkPath, () => ({
      ...realInk,
      createRoot: async () => ({ render() {}, unmount() {}, waitUntilExit: async () => {} }),
    }))
    const ihPath = path.join(SRC, 'interactiveHelpers.tsx')
    const realIh = await import(ihPath)
    mock.module(ihPath, () => ({
      ...realIh,
      showSetupScreens: async () => false,
      exitWithError: async (_root, msg) => {
        out.exitMessage = msg
      },
    }))
    const ssPath = path.join(SRC, 'utils/sessionStorage.ts')
    const realSs = await import(ssPath)
    mock.module(ssPath, () => ({
      ...realSs,
      lastSession: async () => {
        const err = new Error('EACCES: permission denied')
        err.code = 'EACCES'
        throw err
      },
    }))
    mock.module(path.join(SRC, 'boot/launchGraph.ts'), () => ({
      armBackgroundDiscovery: () => {},
      registerBackgroundNode: () => {},
    }))
    const { setIsInteractive } = await import(${JSON.stringify(join(SRC, 'boot/process-state/processState.ts'))})
    setIsInteractive(true)
    const { getEmptyToolPermissionContext } = await import(${JSON.stringify(join(SRC, 'tools/kit/tool.ts'))})
    const { interactiveLaunch } = await import(${JSON.stringify(join(SRC, 'boot/main/interactiveLaunch.ts'))})
    const uuid = '11111111-1111-4111-8111-111111111111'
    await interactiveLaunch({
      opts: { resume: uuid },
      commands: [],
      prompt: undefined,
      permissionMode: 'default',
      toolPermissionContext: getEmptyToolPermissionContext(),
      allowDangerousSkip: false,
      dynamicMcpConfig: undefined,
      thinkingConfig: { type: 'disabled' },
      resolvedInitialModel: 'claude-sonnet-4-6',
      userSpecifiedModel: undefined,
      mainThreadAgentDefinition: undefined,
      activeAgents: [],
      allAgents: [],
      sessionTitle: undefined,
    })
  `)
  check(
    'interactive-resume-read-error-not-not-found',
    typeof r.exitMessage === 'string' &&
      r.exitMessage.startsWith('Failed to resume session 11111111-1111-4111-8111-111111111111:') &&
      r.exitMessage.includes('EACCES'),
    JSON.stringify(r),
  )
}
console.log('\nsrc/boot/main/sessionChoices.ts')
{
  const r = runCase(`
    const { mock } = await import('bun:test')
    const cliPath = path.join(SRC, 'main/cli.ts')
    const realCli = await import(cliPath)
    mock.module(cliPath, () => ({
      ...realCli,
      failCli: (message) => {
        out.refused = message
        throw new Error('CLI_REFUSED')
      },
    }))
    const { agentsWithCliDefs } = await import(${JSON.stringify(join(SRC, 'boot/main/sessionChoices.ts'))})
    try {
      out.returned = agentsWithCliDefs({ agentDefs: '{not json' }, { activeAgents: [], allAgents: [] })
    } catch (e) {
      out.caught = e?.message ?? String(e)
    }
  `)
  check(
    'session-choices-invalid-agent-defs-refuses',
    r.caught === 'CLI_REFUSED' && typeof r.refused === 'string' && r.refused.startsWith('Invalid agent definitions ('),
    JSON.stringify(r),
  )
}
console.log('\nsrc/boot/main.tsx')
for (const [label, awaitsRawRead] of [
  ['main-mdm-boot-load-failure-noted-once', true],
  ['main-mdm-background-load-failure-noted-once', false],
] as const) {
  const r = runCase(`
    const { mock } = await import('bun:test')
    const mdmPath = path.join(SRC, 'utils/settings/mdm/settings.ts')
    const realMdm = await import(mdmPath)
    mock.module(mdmPath, () => ({
      ...realMdm,
      mdmBootAwaitsRawRead: () => ${String(awaitsRawRead)},
      ensureMdmSettingsLoaded: async () => {
        throw new Error('mdm plist unreadable')
      },
    }))
    const extCliPath = path.join(SRC, 'extensions/cli.ts')
    const realExtCli = await import(extCliPath)
    mock.module(extCliPath, () => ({
      ...realExtCli,
      listVerb: async () => {
        out.runs = (out.runs ?? 0) + 1
        return { exit: 0 }
      },
    }))
    const origArgv = process.argv
    process.argv = ['node', 'mercury', 'extensions', 'list']
    try {
      const { main } = await import(${JSON.stringify(join(SRC, 'boot/main.tsx'))})
      await main()
      await main()
      await new Promise(resolve => setTimeout(resolve, 20))
      const { bootNotes } = await import(${JSON.stringify(join(SRC, 'platform/substrate/bootNotes.ts'))})
      out.notes = bootNotes().filter(n => n.kind === 'warn').map(n => n.text)
    } finally {
      process.argv = origArgv
    }
  `)
  const expected = 'the managed policy could not be loaded (mdm plist unreadable), so it is not applied in this session'
  const notes = (r.notes as string[] | undefined) ?? []
  const matches = notes.filter(text => text === expected)
  check(label, r.runs === 2 && matches.length === 1, JSON.stringify(r))
}
console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
