#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  const where = 'the behaviour in the label must hold: change the function named in the heading line above this check, in the file of that name under src/ (the JSON before this hint is what the child bun scenario returned)'
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${detail ? `${detail} — ` : ''}${where}` : ''}`)
}
function skip(label: string, why: string): void {
  console.log(`  [SKIP] ${label} — ${why}`)
}

const HERE = import.meta.dir
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')
const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

function runScenario(body: string, extraEnv: Record<string, string> = {}): Record<string, unknown> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'faults-fn31-')))
  const home = join(scratch, 'home')
  const project = join(scratch, 'project')
  mkdirSync(home, { recursive: true })
  mkdirSync(project, { recursive: true })
  const src = `
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    process.env.MERCURY_CREDENTIAL_STORE = 'file'
    process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
    process.env.NODE_ENV = 'test'
    delete process.env.MERCURY_HOME
    globalThis.MACRO = { VERSION: '1.0.0' }
    process.chdir(${JSON.stringify(project)})
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
      env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '', MERCURY_CREDENTIAL_STORE: 'file', ...extraEnv },
      timeout: 30_000,
    })
    if (res.status !== 0) throw new Error(`scenario exited ${res.status}: ${res.stderr.slice(-1500)}`)
    const line = res.stdout.trim().split('\n').pop() ?? '{}'
    return JSON.parse(line) as Record<string, unknown>
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

console.log('\ngatewayTrust.ts — a failed TLS fingerprint probe says so once and the gateway is still activated')
{
  const r = runScenario(`
    const net = await import('node:net')
    const srv = net.createServer()
    await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve))
    const port = srv.address().port
    await new Promise(resolve => srv.close(resolve))
    const { mock } = await import('bun:test')
    const logs = []
    const realDebug = await import(SRC + '/platform/logs/debugLog.ts')
    mock.module(SRC + '/platform/logs/debugLog.js', () => ({
      ...realDebug,
      logForDebugging: (msg) => { logs.push(String(msg)) },
    }))
    const realStorage = await import(SRC + '/platform/secure-storage/index.ts')
    mock.module(SRC + '/platform/secure-storage/index.js', () => ({
      ...realStorage,
      getSecureStorage: () => ({
        readAsync: async () => ({
          enterpriseGateway: { url: 'https://127.0.0.1:' + port, expiresAt: Date.now() + 60_000 },
          gatewayTrust: { '127.0.0.1': 'deadbeef' },
        }),
        update: () => ({ success: true }),
      }),
    }))
    const realState = await import(SRC + '/boot/process-state/processState.ts')
    mock.module(SRC + '/boot/process-state/processState.js', () => ({
      ...realState,
      getIsNonInteractiveSession: () => false,
    }))
    const stderrLines = []
    const origStderrWrite = process.stderr.write
    process.stderr.write = ((chunk) => { stderrLines.push(String(chunk)); return true })
    const { restoreGatewayAuth } = await import(SRC + '/boot/entrypoints/gatewayTrust.ts')
    try {
      await restoreGatewayAuth()
    } finally {
      process.stderr.write = origStderrWrite
    }
    out.activated = logs.some(l => l.includes('verified session'))
    out.unchecked = logs.some(l => l.includes('proceeding without re-verify'))
    out.stderr = stderrLines.join('')
  `)
  const stderr = typeof r.stderr === 'string' ? r.stderr : ''
  check(
    'gatewayTrust:restore-goes-on-when-tls-probe-fails',
    r.activated === true && r.unchecked === true && /^Cloud gateway 127\.0\.0\.1 could not be verified \(.+\), so its TLS certificate was not checked this time — run \/logins to verify and reconnect\.\n$/.test(stderr),
    JSON.stringify(r),
  )
}

console.log('\ngitConfigParser.ts — unreadable git config rejects instead of answering null')
if (!POSIX_MODES) skip('gitConfigParser:unreadable-config-rejects', 'mode 0000 needs POSIX non-root')
else {
  const r = runScenario(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { parseGitConfigValue } = await import(SRC + '/platform/git/gitConfigParser.ts')
    const emptyDir = path.join(PROJECT, 'empty-git')
    fs.mkdirSync(emptyDir, { recursive: true })
    out.absent = await parseGitConfigValue(emptyDir, 'remote', 'origin', 'url')
    const lockedDir = path.join(PROJECT, 'locked-git')
    fs.mkdirSync(lockedDir, { recursive: true })
    const cfg = path.join(lockedDir, 'config')
    fs.writeFileSync(cfg, '[remote "origin"]\\n\\turl = https://example.com/a/b.git\\n')
    fs.chmodSync(cfg, 0o000)
    try {
      out.locked = await parseGitConfigValue(lockedDir, 'remote', 'origin', 'url')
      out.threw = null
    } catch (e) {
      out.threw = e?.code ?? String(e)
    } finally {
      fs.chmodSync(cfg, 0o600)
    }
  `)
  check(
    'gitConfigParser:unreadable-config-rejects',
    r.absent === null && r.threw === 'EACCES',
    JSON.stringify(r),
  )
}

console.log('\ngitFilesystem.ts — unreadable packed-refs, loose ref, symref and worktrees dir reject instead of returning empty')
if (!POSIX_MODES) skip('gitFilesystem:unreadable-files-reject', 'mode 0000 needs POSIX non-root')
else {
  const r = runScenario(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const repo = path.join(PROJECT, 'repo')
    const gitDir = path.join(repo, '.git')
    fs.mkdirSync(path.join(gitDir, 'refs', 'heads'), { recursive: true })
    fs.mkdirSync(path.join(gitDir, 'refs', 'remotes', 'origin'), { recursive: true })
    fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\\n')
    const packed = path.join(gitDir, 'packed-refs')
    fs.writeFileSync(packed, '0123456789abcdef0123456789abcdef01234567 refs/heads/main\\n')
    process.chdir(repo)
    const gf = await import(SRC + '/platform/git/gitFilesystem.ts')
    out.absentWorktrees = await gf.getWorktreeCountFromFs()
    fs.chmodSync(packed, 0o000)
    gf.regroundGitWatch()
    try {
      await gf.getCachedHead()
      out.packedErr = null
    } catch (e) {
      out.packedErr = e?.code ?? String(e)
    } finally {
      fs.chmodSync(packed, 0o600)
    }
    const loose = path.join(gitDir, 'refs', 'heads', 'main')
    fs.writeFileSync(loose, '0123456789abcdef0123456789abcdef01234567\\n')
    fs.chmodSync(loose, 0o000)
    gf.regroundGitWatch()
    try {
      await gf.getCachedHead()
      out.looseErr = null
    } catch (e) {
      out.looseErr = e?.code ?? String(e)
    } finally {
      fs.chmodSync(loose, 0o600)
    }
    const sym = path.join(gitDir, 'refs', 'remotes', 'origin', 'HEAD')
    fs.writeFileSync(sym, 'ref: refs/remotes/origin/main\\n')
    fs.chmodSync(sym, 0o000)
    gf.regroundGitWatch()
    try {
      await gf.getCachedDefaultBranch()
      out.symErr = null
    } catch (e) {
      out.symErr = e?.code ?? String(e)
    } finally {
      fs.chmodSync(sym, 0o600)
    }
    const wtDir = path.join(gitDir, 'worktrees')
    fs.mkdirSync(wtDir, { recursive: true })
    fs.chmodSync(wtDir, 0o000)
    try {
      await gf.getWorktreeCountFromFs()
      out.wtErr = null
    } catch (e) {
      out.wtErr = e?.code ?? String(e)
    } finally {
      fs.chmodSync(wtDir, 0o700)
    }
  `)
  check('gitFilesystem:unreadable-loose-ref-rejects', r.looseErr === 'EACCES', JSON.stringify(r))
  check('gitFilesystem:unreadable-packed-refs-rejects', r.packedErr === 'EACCES', JSON.stringify(r))
  check('gitFilesystem:unreadable-symref-rejects', r.symErr === 'EACCES', JSON.stringify(r))
  check('gitFilesystem:unreadable-worktrees-dir-rejects', r.absentWorktrees === 1 && r.wtErr === 'EACCES', JSON.stringify(r))
}

console.log('\ngit.ts — getGitState propagates read failures and unreadable .git file fails closed')
if (!POSIX_MODES) skip('git:read-failures-and-unreadable-gitdir', 'mode 0000 needs POSIX non-root')
else {
  const r = runScenario(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const repo = path.join(PROJECT, 'repo')
    const gitDir = path.join(repo, '.git')
    fs.mkdirSync(path.join(gitDir, 'refs', 'heads'), { recursive: true })
    fs.mkdirSync(path.join(gitDir, 'objects'), { recursive: true })
    fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\\n')
    fs.writeFileSync(path.join(gitDir, 'refs', 'heads', 'main'), '0123456789abcdef0123456789abcdef01234567\\n')
    const cfg = path.join(gitDir, 'config')
    fs.writeFileSync(cfg, '[core]\\n\\trepositoryformatversion = 0\\n')
    fs.chmodSync(cfg, 0o000)
    process.chdir(repo)
    const { getGitState, isCurrentDirectoryBareGitRepo } = await import(SRC + '/platform/git/git.ts')
    try {
      out.state = await getGitState()
      out.stateErr = null
    } catch (e) {
      out.stateErr = e?.code ?? String(e)
    } finally {
      fs.chmodSync(cfg, 0o600)
    }
    const sub = path.join(repo, 'sub')
    fs.mkdirSync(sub, { recursive: true })
    const dotGitFile = path.join(sub, '.git')
    fs.writeFileSync(dotGitFile, 'gitdir: ./evil\\n')
    fs.chmodSync(dotGitFile, 0o000)
    try {
      out.verdict = isCurrentDirectoryBareGitRepo(sub)
    } finally {
      fs.chmodSync(dotGitFile, 0o600)
    }
  `)
  check('git:getGitState-propagates-read-error', r.stateErr === 'EACCES', JSON.stringify(r))
  check('git:unreadable-dotgit-file-is-passed-over', r.verdict === false, JSON.stringify(r))
}

console.log('\ngitDiff.ts — unreadable transient-state marker rejects instead of pretending no merge in progress')
if (!POSIX_MODES) skip('gitDiff:unreadable-transient-marker-rejects', 'mode 0000 needs POSIX non-root')
else {
  const r = runScenario(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { execFileSync } = await import('node:child_process')
    const repo = path.join(PROJECT, 'diff-repo')
    fs.mkdirSync(repo, { recursive: true })
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
    execFileSync('git', ['init', '-q'], { cwd: repo, env })
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\\n')
    execFileSync('git', ['add', 'a.txt'], { cwd: repo, env })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo, env })
    fs.writeFileSync(path.join(repo, 'a.txt'), 'two\\n')
    const { fetchGitDiffFor, fetchGitDiffHunksFor } = await import(SRC + '/screen/diff/gitDiff.ts')
    out.cleanDiffOk = (await fetchGitDiffFor({ args: ['HEAD'], cwd: repo })) !== null
    const gitDir = path.join(repo, '.git')
    const block = path.join(gitDir, 'MERGE_HEAD')
    fs.mkdirSync(block, { recursive: true })
    const inner = path.join(gitDir, 'rebase-merge')
    fs.mkdirSync(inner, { recursive: true })
    fs.rmSync(block, { recursive: true, force: true })
    fs.rmSync(inner, { recursive: true, force: true })
    const lockedParent = path.join(PROJECT, 'locked-gitdir')
    fs.mkdirSync(lockedParent, { recursive: true })
    const fakeGitDir = path.join(lockedParent, 'inner')
    fs.mkdirSync(fakeGitDir, { recursive: true })
    fs.writeFileSync(path.join(fakeGitDir, 'MERGE_HEAD'), '0123456789abcdef0123456789abcdef01234567\\n')
    const linkedRepo = path.join(PROJECT, 'linked-repo')
    fs.mkdirSync(linkedRepo, { recursive: true })
    fs.writeFileSync(path.join(linkedRepo, '.git'), 'gitdir: ' + fakeGitDir + '\\n')
    const { mock } = await import('bun:test')
    mock.module(SRC + '/platform/processes/execFileNoThrow.js', () => ({
      execFileNoThrow: async () => ({ stdout: '', stderr: '', code: 0 }),
      execFileNoThrowWithCwd: async (_cmd, args) => {
        if (args.includes('--git-dir')) return { stdout: fakeGitDir + '\\n', stderr: '', code: 0 }
        return { stdout: '1\\t1\\ta.txt\\n', stderr: '', code: 0 }
      },
    }))
    const diffMod = await import(SRC + '/screen/diff/gitDiff.ts?locked')
    fs.chmodSync(fakeGitDir, 0o000)
    try {
      await diffMod.fetchGitDiffFor({ args: ['HEAD'], cwd: linkedRepo })
      out.diffErr = null
    } catch (e) {
      out.diffErr = e?.code ?? String(e)
    }
    try {
      await diffMod.fetchGitDiffHunksFor({ args: ['HEAD'], cwd: linkedRepo })
      out.hunksErr = null
    } catch (e) {
      out.hunksErr = e?.code ?? String(e)
    } finally {
      fs.chmodSync(fakeGitDir, 0o700)
    }
  `)
  check('gitDiff:unreadable-marker-rejects-diff', r.cleanDiffOk === true && r.diffErr === 'EACCES', JSON.stringify(r))
  check('gitDiff:unreadable-marker-rejects-hunks', r.hunksErr === 'EACCES', JSON.stringify(r))
}

console.log('\ngracefulShutdown.ts — background hooks end on fireHooks throw and gracefulShutdownSync still forces exit when terminal restoration throws')
{
  const r1 = runScenario(`
    const { mock } = await import('bun:test')
    let backgroundEnded = false
    const realFire = await import(SRC + '/integrations/event-hooks/fire.ts')
    mock.module(SRC + '/integrations/event-hooks/fire.js', () => ({
      ...realFire,
      fireHooks: async () => { throw new Error('fire boom') },
    }))
    const realBg = await import(SRC + '/integrations/event-hooks/background.ts')
    mock.module(SRC + '/integrations/event-hooks/background.js', () => ({
      ...realBg,
      endBackgroundHooks: async () => { backgroundEnded = true },
    }))
    const realLin = await import(SRC + '/sessions/mneme/lineageSession.ts')
    mock.module(SRC + '/sessions/mneme/lineageSession.js', () => ({
      ...realLin,
      closeLineageSession: async () => {},
    }))
    const realDrain = await import(SRC + '/platform/processes/exitCliffDrain.ts')
    mock.module(SRC + '/platform/processes/exitCliffDrain.js', () => ({
      ...realDrain,
      drainExitCliffSeams: async () => {},
    }))
    const origExit = process.exit
    let exitCodeSeen = null
    process.exit = ((code) => { exitCodeSeen = code; throw new Error('EXIT_SENTINEL') })
    const { gracefulShutdown } = await import(SRC + '/platform/processes/gracefulShutdown.ts')
    try {
      await gracefulShutdown(0)
    } catch (e) {
      if (e?.message !== 'EXIT_SENTINEL') throw e
    } finally {
      process.exit = origExit
    }
    out.backgroundEnded = backgroundEnded
    out.exitCodeSeen = exitCodeSeen
  `)
  check(
    'gracefulShutdown:ends-background-hooks-when-fireHooks-throws',
    r1.backgroundEnded === true && r1.exitCodeSeen === 0,
    JSON.stringify(r1),
  )

  const r2 = runScenario(`
    const { mock } = await import('bun:test')
    const realRestore = await import(SRC + '/screen/renderer/terminal-session/shutdownRestoration.ts')
    mock.module(SRC + '/screen/renderer/terminal-session/shutdownRestoration.js', () => ({
      ...realRestore,
      cleanupTerminalModes: () => { throw new Error('tty restore boom') },
      printResumeHint: () => {},
      drainStdinForExit: () => {},
    }))
    const realInk = await import(SRC + '/screen/renderer/instances.ts')
    mock.module(SRC + '/screen/renderer/instances.js', () => ({
      ...realInk,
      default: { get: () => ({ awaitTerminalQueries: async () => {} }) },
    }))
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
    const origExit = process.exit
    let exitCodeSeen = null
    process.exit = ((code) => { exitCodeSeen = code })
    const { gracefulShutdownSync } = await import(SRC + '/platform/processes/gracefulShutdown.ts')
    gracefulShutdownSync(7)
    await new Promise(resolve => setTimeout(resolve, 100))
    process.exit = origExit
    out.exitCodeSeen = exitCodeSeen
  `)
  check(
    'gracefulShutdown:sync-still-forces-exit-when-restoration-throws',
    r2.exitCodeSeen === 7,
    JSON.stringify(r2),
  )
}

console.log('\nhaltAll.ts — thrown daemonControlRpc error is reported as the reason instead of no daemon running')
{
  const r = runScenario(`
    const { mock } = await import('bun:test')
    const real = await import(SRC + '/daemon/control/controlSocket.ts')
    mock.module(SRC + '/daemon/control/controlSocket.js', () => ({
      ...real,
      daemonControlRpc: async () => { throw new Error('control key unreadable') },
    }))
    const { haltAll } = await import(SRC + '/daemon/control/haltAll.ts')
    out.result = await haltAll({ getAppState: () => ({ tasks: {} }), setAppState: () => {} })
  `)
  const daemon = (r.result as { daemon?: { ok?: boolean; reason?: string } } | undefined)?.daemon
  check(
    'haltAll:reports-rpc-throw-reason',
    daemon?.ok === false && daemon.reason === 'control key unreadable',
    JSON.stringify(r),
  )
}

console.log('\ndurability.ts — EPERM from process.kill(pid, 0) counts journal writer as alive')
{
  const r = runScenario(`
    const { mock } = await import('bun:test')
    const realJournal = await import(SRC + '/platform/substrate/operationJournal.ts')
    mock.module(SRC + '/platform/substrate/operationJournal.js', () => ({
      ...realJournal,
      listJournalOperations: async () => [{ state: 'applying', writerPid: 424242 }],
    }))
    const origKill = process.kill
    process.kill = ((pid, sig) => {
      if (pid === 424242 && sig === 0) {
        const err = new Error('operation not permitted')
        err.code = 'EPERM'
        throw err
      }
      return origKill(pid, sig)
    })
    try {
      const { durabilityChecks } = await import(SRC + '/platform/health/sections/durability.ts')
      const spec = durabilityChecks().find(c => c.id === 'durable-journals')
      out.row = await spec.run()
    } finally {
      process.kill = origKill
    }
  `)
  const row = r.row as { status?: string; evidence?: string } | undefined
  check(
    'durability:eperm-writer-counts-as-in-flight',
    row?.status === 'ok' && Boolean(row.evidence?.includes('1 in flight')) && Boolean(row.evidence?.includes('0 interrupted')),
    JSON.stringify(r),
  )
}

console.log('\nauth.ts — routing failure does not default to anthropic and usage failure emits a failing check')
{
  const r = runScenario(`
    const { mock } = await import('bun:test')
    const realModel = await import(SRC + '/models/catalogue/engineModel.ts')
    mock.module(SRC + '/models/catalogue/engineModel.js', () => ({
      ...realModel,
      getUserSpecifiedModelSetting: () => 'broken',
      getEngineModel: () => { throw new Error('route read boom') },
    }))
    const realUsage = await import(SRC + '/models/roads/providerUsage.ts')
    mock.module(SRC + '/models/roads/providerUsage.js', () => ({
      ...realUsage,
      anthropicCredentialPresence: () => ({ credentialed: false, expired: false }),
      providerFamilyPresences: () => { throw new Error('usage read boom') },
    }))
    const { authChecks } = await import(SRC + '/platform/health/sections/auth.ts')
    const specs = await authChecks()
    const anth = specs.find(c => c.id === 'auth-anthropic')
    try {
      out.anthRow = await anth.run()
      out.anthErr = null
    } catch (e) {
      out.anthErr = e?.message ?? String(e)
    }
    const usage = specs.find(c => c.id === 'usage')
    out.hasUsage = Boolean(usage)
    if (usage) {
      try {
        await usage.run()
        out.usageErr = null
      } catch (e) {
        out.usageErr = e?.message ?? String(e)
      }
    }
  `)
  check('auth:routing-failure-throws-in-run', r.anthErr === 'route read boom', JSON.stringify(r))
  check('auth:usage-assembly-failure-emits-throwing-check', r.hasUsage === true && r.usageErr === 'usage read boom', JSON.stringify(r))
}

console.log('\nruntime.ts — editOutcomeLedgerEnabled throw emits a throwing Edit outcomes check instead of omitting the row')
{
  const r = runScenario(`
    const { mock } = await import('bun:test')
    const real = await import(SRC + '/tools/engines/change-transaction/editOutcomeLedger.ts')
    mock.module(SRC + '/tools/engines/change-transaction/editOutcomeLedger.js', () => ({
      ...real,
      editOutcomeLedgerEnabled: () => { throw new Error('ledger check boom') },
    }))
    const { runtimeChecks } = await import(SRC + '/platform/health/sections/runtime.ts')
    const row = runtimeChecks().find(c => c.id === 'edit-outcomes')
    out.present = Boolean(row)
    out.label = row?.label ?? null
    if (row) {
      try {
        await row.run()
        out.err = null
      } catch (e) {
        out.err = e?.message ?? String(e)
      }
    }
  `)
  check(
    'runtime:edit-outcomes-assembly-failure-emits-throwing-check',
    r.present === true && r.label === 'Edit outcomes' && r.err === 'ledger check boom',
    JSON.stringify(r),
  )
}

console.log('\nruntime/services.ts — mcpCheck propagates getMcpPolicyRejects throw instead of hiding rejects')
{
  const r = runScenario(`
    const { mock } = await import('bun:test')
    const realPolicy = await import(SRC + '/integrations/mcp-shapes/toolPolicy.ts')
    mock.module(SRC + '/integrations/mcp-shapes/toolPolicy.js', () => ({
      ...realPolicy,
      getMcpPolicyRejects: () => { throw new Error('policy parser boom') },
    }))
    const { mcpCheck } = await import(SRC + '/platform/health/sections/runtime/services.ts')
    try {
      out.row = mcpCheck().run()
      out.err = null
    } catch (e) {
      out.err = e?.message ?? String(e)
    }
  `)
  check('runtime/services:mcp-policy-rejects-throw-propagates', r.err === 'policy parser boom', JSON.stringify(r))
}

console.log('\nhealthDeepProbes.ts — probeServiceLifecycle kills child PID if stopService throws in finally')
{
  const r = runScenario(`
    const { mock } = await import('bun:test')
    const realContracts = await import(SRC + '/tools/engines/project-services/contracts.ts')
    mock.module(SRC + '/tools/engines/project-services/contracts.js', () => ({
      ...realContracts,
      servicesEnabled: () => true,
    }))
    const realSvc = await import(SRC + '/tools/engines/project-services/serviceManager.ts')
    mock.module(SRC + '/tools/engines/project-services/serviceManager.js', () => ({
      ...realSvc,
      startService: async () => ({ record: { pid: 424243, state: 'running' } }),
      waitForReady: async () => { throw new Error('wait boom') },
      readLogs: async () => ({ lines: [] }),
      stopService: async () => { throw new Error('stop boom') },
    }))
    const kills = []
    const realPg = await import(SRC + '/platform/processes/processGroup.ts')
    mock.module(SRC + '/platform/processes/processGroup.js', () => ({
      ...realPg,
      endProcessTree: async (pid, sig) => { kills.push({ pid, sig }); return { ended: 1, survivors: [] } },
    }))
    const { probeServiceLifecycle } = await import(SRC + '/platform/health/healthDeepProbes.ts')
    try {
      await probeServiceLifecycle()
      out.err = null
    } catch (e) {
      out.err = e?.message ?? String(e)
    }
    out.kills = kills
  `)
  const kills = (r.kills as Array<{ pid: number; sig: string }> | undefined) ?? []
  check(
    'healthDeepProbes:probeServiceLifecycle-kills-pid-when-stopService-throws',
    r.err === 'wait boom' && kills.some(k => k.pid === 424243 && k.sig === 'SIGKILL'),
    JSON.stringify(r),
  )
}

console.log('\nsettings/model.ts — modelCheck propagates getSettingsWithAllErrors throw instead of saying no settings pin')
{
  const r = runScenario(`
    const { mock } = await import('bun:test')
    const realAllErrors = await import(SRC + '/platform/settings-faults/allErrors.ts')
    mock.module(SRC + '/platform/settings-faults/allErrors.js', () => ({
      ...realAllErrors,
      getSettingsWithAllErrors: () => { throw new Error('settings read boom') },
    }))
    const { modelCheck } = await import(SRC + '/platform/health/sections/settings/model.ts')
    try {
      out.row = modelCheck().run()
      out.err = null
    } catch (e) {
      out.err = e?.message ?? String(e)
    }
  `)
  check('settings/model:getSettingsWithAllErrors-throw-propagates', r.err === 'settings read boom', JSON.stringify(r))
}

console.log('\nsettings/prompt.ts — hiddenCharactersCheck propagates skill scan failure instead of reporting ok')
{
  const r = runScenario(`
    const { mock } = await import('bun:test')
    const realSkills = await import(SRC + '/integrations/skills/loadSkillsDir.ts')
    mock.module(SRC + '/integrations/skills/loadSkillsDir.js', () => ({
      ...realSkills,
      getSkillDirCommands: async () => { throw new Error('skills scan boom') },
    }))
    const { hiddenCharactersCheck } = await import(SRC + '/platform/health/sections/settings/prompt.ts')
    try {
      out.row = await hiddenCharactersCheck().run()
      out.err = null
    } catch (e) {
      out.err = e?.message ?? String(e)
    }
  `)
  check('settings/prompt:skill-scan-throw-propagates', r.err === 'skills scan boom', JSON.stringify(r))
}

console.log('\nsettings/sources.ts — killsCheck propagates getAgentCapParseRejects throw and settingsCheck reports unreadable policy lock')
{
  const r = runScenario(`
    const { mock } = await import('bun:test')
    const realCap = await import(SRC + '/permissions/rules/capabilityGate.ts')
    mock.module(SRC + '/permissions/rules/capabilityGate.js', () => ({
      ...realCap,
      getAgentCapParseRejects: () => { throw new Error('cap parser boom') },
    }))
    const realSettings = await import(SRC + '/platform/settings/settings.ts')
    mock.module(SRC + '/platform/settings/settings.js', () => ({
      ...realSettings,
      getSettingsForSource: () => { throw new Error('policy read boom') },
    }))
    const { killsCheck, settingsCheck } = await import(SRC + '/platform/health/sections/settings/sources.ts')
    out.settingsRow = settingsCheck().run()
    try {
      out.killsRow = await killsCheck().run()
      out.killsErr = null
    } catch (e) {
      out.killsErr = e?.message ?? String(e)
    }
  `)
  const settingsRow = r.settingsRow as { evidence?: string } | undefined
  check('settings/sources:kills-cap-rejects-throw-propagates', r.killsErr === 'cap parser boom', JSON.stringify(r))
  check(
    'settings/sources:unreadable-policy-lock-reported',
    Boolean(settingsRow?.evidence?.includes('managed extension-only lock unreadable (policy read boom)')),
    JSON.stringify(r),
  )
}

console.log('\nproofs.ts — gate check rejects corrupt verdict JSON instead of reporting no verdict recorded')
{
  const r = runScenario(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { gateVerdictPath } = await import(SRC + '/platform/health/healthReport.ts')
    const vp = gateVerdictPath()
    fs.mkdirSync(path.dirname(vp), { recursive: true })
    fs.writeFileSync(vp, '{not-json')
    fs.mkdirSync(path.join(PROJECT, 'scripts'), { recursive: true })
    fs.writeFileSync(path.join(PROJECT, 'scripts', 'run-all-suites.sh'), '#!/bin/sh\\n')
    const { proofsChecks } = await import(SRC + '/platform/health/sections/proofs.ts')
    const gate = proofsChecks({ cwd: PROJECT, version: '1.0.0', git: { state: 'unavailable', data: { git: null } }, repo: null, head: { sha: null, branch: null, dirty: null } }).find(c => c.id === 'gate')
    try {
      out.row = await gate.run()
      out.err = null
    } catch (e) {
      out.err = e?.name ?? String(e)
    }
  `)
  check('proofs:corrupt-verdict-throws', r.err === 'SyntaxError', JSON.stringify(r))
}

console.log('\ncrew/home.ts — transcriptStoreCheck rejects unreadable projects dir and isolation remedy reports rename failure')
if (!POSIX_MODES) skip('crew/home:unreadable-projects-and-rename-failure', 'mode 0300/0500 needs POSIX non-root')
else {
  const r = runScenario(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const projectsDir = path.join(HOME, 'projects')
    fs.mkdirSync(projectsDir, { recursive: true })
    fs.chmodSync(projectsDir, 0o300)
    const { transcriptStoreCheck } = await import(SRC + '/platform/health/sections/crew/home.ts')
    try {
      out.row = await transcriptStoreCheck().run()
      out.readdirErr = null
    } catch (e) {
      out.readdirErr = e?.code ?? String(e)
    } finally {
      fs.chmodSync(projectsDir, 0o700)
    }
    const { mock } = await import('bun:test')
    const realFsP = await import('node:fs/promises')
    mock.module('node:fs/promises', () => ({
      ...realFsP,
      rename: async () => { const err = new Error('permission denied'); err.code = 'EACCES'; throw err },
    }))
    mock.module(SRC + '/platform/health/healthFix.js', () => ({ healthFixEnabled: () => true }))
    mock.module(SRC + '/platform/environment/knownAgentClis.js', () => ({
      classifyHarnessHome: async () => ({
        foreign: [{ rel: 'foreign.json', evidence: 'foreign.json', tool: { displayName: 'Other' } }],
        oursStale: [],
      }),
      harnessArtifactPath: (home, rel) => path.join(home, rel),
    }))
    const homeMod = await import(SRC + '/platform/health/sections/crew/home.ts?iso')
    const iso = await homeMod.isolationCheck().run()
    out.remedyRes = await iso.remedy.apply()
  `)
  const remedyRes = r.remedyRes as { ok?: boolean; note?: string } | undefined
  check('crew/home:unreadable-projects-dir-throws', r.readdirErr === 'EACCES', JSON.stringify(r))
  check(
    'crew/home:isolation-remedy-reports-rename-error',
    remedyRes?.ok === false && Boolean(remedyRes.note?.startsWith('archive failed:')),
    JSON.stringify(r),
  )
}

console.log('\ncrew/appends.ts — historyCheck propagates non-ENOENT statSync failure on history.jsonl or its lock')
if (!POSIX_MODES) skip('crew/appends:history-stat-eacces-throws', 'mode 0000 needs POSIX non-root')
else {
  const r = runScenario(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const lockedHome = path.join(PROJECT, 'locked-home')
    fs.mkdirSync(lockedHome, { recursive: true })
    process.env.MERCURY_CONFIG_DIR = lockedHome
    const { historyCheck } = await import(SRC + '/platform/health/sections/crew/appends.ts')
    fs.chmodSync(lockedHome, 0o000)
    try {
      out.row = historyCheck().run()
      out.err = null
    } catch (e) {
      out.err = e?.code ?? String(e)
    } finally {
      fs.chmodSync(lockedHome, 0o700)
    }
  `)
  check('crew/appends:history-stat-eacces-throws', r.err === 'EACCES', JSON.stringify(r))
}

console.log('\ncrew/boot.ts — invocationTraceCheck reports unreadable prior trace instead of no records')
if (!POSIX_MODES) skip('crew/boot:unreadable-trace-reported', 'mode 0000 needs POSIX non-root')
else {
  const r = runScenario(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const lockedHome = path.join(PROJECT, 'locked-trace-home')
    fs.mkdirSync(lockedHome, { recursive: true })
    process.env.MERCURY_CONFIG_DIR = lockedHome
    process.env.MERCURY_TRACE = '1'
    const { invocationTraceCheck } = await import(SRC + '/platform/health/sections/crew/boot.ts')
    fs.chmodSync(lockedHome, 0o000)
    try {
      out.row = await invocationTraceCheck().run()
    } finally {
      fs.chmodSync(lockedHome, 0o700)
    }
  `)
  const row = r.row as { evidence?: string } | undefined
  check('crew/boot:unreadable-trace-reported', Boolean(row?.evidence?.includes('prior trace unreadable (')), JSON.stringify(r))
}

console.log('\ncrew/crewmates.ts — agentDefinitionsCheck reports unreadable agents dir instead of absent')
if (!POSIX_MODES) skip('crew/crewmates:unreadable-agents-dir-reported', 'mode 0000 needs POSIX non-root')
else {
  const r = runScenario(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const agentsDir = path.join(HOME, 'agents')
    fs.mkdirSync(agentsDir, { recursive: true })
    fs.chmodSync(agentsDir, 0o000)
    const { agentDefinitionsCheck } = await import(SRC + '/platform/health/sections/crew/crewmates.ts')
    try {
      out.row = await agentDefinitionsCheck().run()
    } finally {
      fs.chmodSync(agentsDir, 0o700)
    }
  `)
  const row = r.row as { evidence?: string } | undefined
  check('crew/crewmates:unreadable-agents-dir-reported', Boolean(row?.evidence?.includes('user dir unreadable (')), JSON.stringify(r))
}

console.log('\ncrew/scratch.ts — lifecycleCollectionCheck reports unreadable cleanup sentinel instead of no sweep recorded')
if (!POSIX_MODES) skip('crew/scratch:unreadable-cleanup-sentinel-reported', 'mode 0000 needs POSIX non-root')
else {
  const r = runScenario(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const lockedSub = path.join(PROJECT, 'locked-cleanup-sub')
    fs.mkdirSync(lockedSub, { recursive: true })
    fs.symlinkSync(path.join(lockedSub, 'target'), path.join(HOME, '.last-cleanup'))
    const { lifecycleCollectionCheck } = await import(SRC + '/platform/health/sections/crew/scratch.ts')
    fs.chmodSync(lockedSub, 0o000)
    try {
      out.row = await lifecycleCollectionCheck().run()
    } finally {
      fs.chmodSync(lockedSub, 0o700)
    }
  `)
  const row = r.row as { evidence?: string } | undefined
  check('crew/scratch:unreadable-cleanup-sentinel-reported', Boolean(row?.evidence?.includes('last sweep unreadable (')), JSON.stringify(r))
}

console.log('\ncoding-loop-fast.ts — anvil-workbench-fast reports unreadable grammar dir instead of 0 missing')
if (!POSIX_MODES) skip('coding-loop-fast:unreadable-grammar-dir-reported', 'mode 0000 needs POSIX non-root')
else {
  const r = runScenario(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { mock } = await import('bun:test')
    const grammarDir = path.join(PROJECT, 'locked-grammars')
    fs.mkdirSync(grammarDir, { recursive: true })
    fs.chmodSync(grammarDir, 0o000)
    const realGram = await import(SRC + '/platform/grammars/grammarFacility.ts')
    mock.module(SRC + '/platform/grammars/grammarFacility.js', () => ({
      ...realGram,
      resolveGrammarEngineDir: () => ({ state: 'ok', source: 'vendored', dir: grammarDir }),
    }))
    const { codingLoopFastChecks } = await import(SRC + '/platform/health/sections/coding-loop-fast.ts')
    const spec = codingLoopFastChecks().find(c => c.id === 'anvil-workbench-fast')
    try {
      out.row = await spec.run()
    } finally {
      fs.chmodSync(grammarDir, 0o700)
    }
  `)
  const row = r.row as { detail?: string } | undefined
  check('coding-loop-fast:unreadable-grammar-dir-reported', Boolean(row?.detail?.includes('grammar dir unreadable (')), JSON.stringify(r))
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
