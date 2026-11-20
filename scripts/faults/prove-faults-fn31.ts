#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
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

console.log('\ngatewayTrust.ts — failed TLS fingerprint probe refuses to activate the gateway')
{
  const r = runScenario(`
    const net = await import('node:net')
    const srv = net.createServer()
    await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve))
    const port = srv.address().port
    await new Promise(resolve => srv.close(resolve))
    const { mock } = await import('bun:test')
    const logs = []
    mock.module(SRC + '/utils/debug.js', () => ({
      logForDebugging: (msg) => { logs.push(String(msg)) },
    }))
    mock.module(SRC + '/utils/secureStorage/index.js', () => ({
      getSecureStorage: () => ({
        readAsync: async () => ({
          enterpriseGateway: { url: 'https://127.0.0.1:' + port, expiresAt: Date.now() + 60_000 },
          gatewayTrust: { '127.0.0.1': 'deadbeef' },
        }),
        update: () => ({ success: true }),
      }),
    }))
    mock.module(SRC + '/bootstrap/state.js', () => ({
      getIsNonInteractiveSession: () => false,
    }))
    const stderrLines = []
    const origStderrWrite = process.stderr.write
    process.stderr.write = ((chunk) => { stderrLines.push(String(chunk)); return true })
    const { restoreGatewayAuth } = await import(SRC + '/utils/gatewayTrust.ts')
    try {
      await restoreGatewayAuth()
    } finally {
      process.stderr.write = origStderrWrite
    }
    out.activated = logs.some(l => l.includes('verified session'))
    out.refused = logs.some(l => l.includes('TLS fingerprint probe failed'))
    out.stderr = stderrLines.join('')
  `)
  const stderr = typeof r.stderr === 'string' ? r.stderr : ''
  check(
    'gatewayTrust:restore-refuses-on-tls-probe-failure',
    r.activated === false && r.refused === true && /^Cloud gateway 127\.0\.0\.1 could not be verified \(.+\) — run \/logins to reconnect\.\n$/.test(stderr),
    JSON.stringify(r),
  )
}

console.log('\ngitConfigParser.ts — unreadable git config rejects instead of answering null')
if (!POSIX_MODES) skip('gitConfigParser:unreadable-config-rejects', 'mode 0000 needs POSIX non-root')
else {
  const r = runScenario(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { parseGitConfigValue } = await import(SRC + '/utils/git/gitConfigParser.ts')
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
    const gf = await import(SRC + '/utils/git/gitFilesystem.ts')
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
    const { getGitState, isCurrentDirectoryBareGitRepo } = await import(SRC + '/utils/git.ts')
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
  check('git:unreadable-dotgit-file-fails-closed', r.verdict === 'gitdir-redirect-plantable', JSON.stringify(r))
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
    const { fetchGitDiffFor, fetchGitDiffHunksFor } = await import(SRC + '/utils/gitDiff.ts')
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
    mock.module(SRC + '/utils/execFileNoThrow.js', () => ({
      execFileNoThrow: async () => ({ stdout: '', stderr: '', code: 0 }),
      execFileNoThrowWithCwd: async (_cmd, args) => {
        if (args.includes('--git-dir')) return { stdout: fakeGitDir + '\\n', stderr: '', code: 0 }
        return { stdout: '1\\t1\\ta.txt\\n', stderr: '', code: 0 }
      },
    }))
    const diffMod = await import(SRC + '/utils/gitDiff.ts?locked')
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
    mock.module(SRC + '/utils/hooks/fire.js', () => ({
      fireHooks: async () => { throw new Error('fire boom') },
    }))
    mock.module(SRC + '/utils/hooks/background.js', () => ({
      endBackgroundHooks: async () => { backgroundEnded = true },
    }))
    mock.module(SRC + '/mneme/lineageSession.js', () => ({
      closeLineageSession: async () => {},
    }))
    mock.module(SRC + '/utils/exitCliffDrain.js', () => ({
      drainExitCliffSeams: async () => {},
    }))
    const origExit = process.exit
    let exitCodeSeen = null
    process.exit = ((code) => { exitCodeSeen = code; throw new Error('EXIT_SENTINEL') })
    const { gracefulShutdown } = await import(SRC + '/utils/gracefulShutdown.ts')
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
    mock.module(SRC + '/utils/shutdownRestoration.js', () => ({
      cleanupTerminalModes: () => { throw new Error('tty restore boom') },
      printResumeHint: () => {},
      drainStdinForExit: () => {},
    }))
    mock.module(SRC + '/ink/instances.js', () => ({
      default: { get: () => ({ awaitTerminalQueries: async () => {} }) },
    }))
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
    const origExit = process.exit
    let exitCodeSeen = null
    process.exit = ((code) => { exitCodeSeen = code })
    const { gracefulShutdownSync } = await import(SRC + '/utils/gracefulShutdown.ts')
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
    const real = await import(SRC + '/daemon/controlSocket.ts')
    mock.module(SRC + '/daemon/controlSocket.js', () => ({
      ...real,
      daemonControlRpc: async () => { throw new Error('control key unreadable') },
    }))
    const { haltAll } = await import(SRC + '/utils/haltAll.ts')
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
    mock.module(SRC + '/substrate/operationJournal.js', () => ({
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
      const { durabilityChecks } = await import(SRC + '/utils/health/sections/durability.ts')
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
    const realModel = await import(SRC + '/utils/model/model.ts')
    mock.module(SRC + '/utils/model/model.js', () => ({
      ...realModel,
      getUserSpecifiedModelSetting: () => 'broken',
      getEngineModel: () => { throw new Error('route read boom') },
    }))
    const realUsage = await import(SRC + '/services/providers/providerUsage.ts')
    mock.module(SRC + '/services/providers/providerUsage.js', () => ({
      ...realUsage,
      anthropicCredentialPresence: () => ({ credentialed: false, expired: false }),
      providerFamilyPresences: () => { throw new Error('usage read boom') },
    }))
    const { authChecks } = await import(SRC + '/utils/health/sections/auth.ts')
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

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
