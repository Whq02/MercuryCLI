#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}${!cond ? ' — fix the source file named in the heading line printed above this check (the heading path sits under src/services/), so that it fails loudly or reports the failure instead of hiding it' : ''}`)
}
function skip(label: string, why: string): void {
  console.log(`  [SKIP] ${label} — ${why}`)
}

const HERE = dirname(fileURLToPath(import.meta.url))
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')
const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

function runSub(body: string, extraEnv: Record<string, string> = {}): Record<string, unknown> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'faults-fn20-')))
  try {
    const home = join(scratch, 'home')
    const project = join(scratch, 'project')
    const configDir = join(scratch, 'config')
    for (const dir of [home, project, configDir]) mkdirSync(dir, { recursive: true })
    const src = `
      process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(configDir)}
      process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
      process.env.NODE_ENV = 'test'
      delete process.env.MERCURY_HOME
      globalThis.MACRO = { VERSION: '1.0.0' }
      process.chdir(${JSON.stringify(project)})
      const fs = await import('node:fs')
      const path = await import('node:path')
      const SRC = ${JSON.stringify(SRC)}
      const HOME = ${JSON.stringify(home)}
      const PROJECT = ${JSON.stringify(project)}
      const CONFIG = ${JSON.stringify(configDir)}
      const SCRATCH = ${JSON.stringify(scratch)}
      const out = {}
      ${body}
      process.stdout.write('\\n' + JSON.stringify(out))
      process.exit(0)
    `
    const res = spawnSync(BUN, ['-e', src], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, MERCURY_CONFIG_DIR: configDir, MERCURY_HOME: '', ...extraEnv },
    })
    if (res.status !== 0) throw new Error(`sub failed: ${res.stderr.slice(-1200)}`)
    return JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

console.log('\nremoteFiles/hosts.ts — an ssh config file or include folder that cannot be read is skipped, the rest is listed and the list says which')
if (!POSIX_MODES) {
  skip('hosts-unreadable-config', 'needs non-root POSIX')
  skip('hosts-unreadable-include-dir', 'needs non-root POSIX')
} else {
  const r1 = runSub(`
    const { remoteHostNames, renderRemoteHosts } = await import(path.join(SRC, 'platform/remote-files/hosts.ts'))
    const sshDir = path.join(HOME, '.ssh')
    const incDir = path.join(sshDir, 'conf.d')
    fs.mkdirSync(incDir, { recursive: true })
    const shut = path.join(incDir, 'shut.conf')
    fs.writeFileSync(path.join(incDir, 'open.conf'), 'Host app1\\n')
    fs.writeFileSync(shut, 'Host app2\\n', { mode: 0o600 })
    fs.writeFileSync(path.join(sshDir, 'config'), 'Host web1\\nInclude conf.d/*\\n')
    fs.chmodSync(shut, 0o000)
    const unread = []
    try {
      out.hosts = remoteHostNames(() => true, unread)
      out.unread = unread
      out.content = renderRemoteHosts(out.hosts, unread).content
    } catch (e) {
      out.code = e.code ?? e.name
    } finally {
      fs.chmodSync(shut, 0o600)
    }
  `)
  const hosts1 = (r1.hosts ?? []) as string[]
  const unread1 = (r1.unread ?? []) as string[]
  check('hosts-unreadable-config', r1.code === undefined && hosts1.includes('web1') && hosts1.includes('app1') && !hosts1.includes('app2') && unread1.length === 1 && unread1[0]!.includes('shut.conf'), JSON.stringify(r1))
  check('hosts-unreadable-config-said', String(r1.content ?? '').includes('Not read, so its hosts are not listed: ') && String(r1.content ?? '').includes('shut.conf') && String(r1.content ?? '').includes('EACCES'), JSON.stringify(r1))

  const r2 = runSub(`
    const { remoteHostNames } = await import(path.join(SRC, 'platform/remote-files/hosts.ts'))
    const sshDir = path.join(HOME, '.ssh')
    const incDir = path.join(sshDir, 'conf.d')
    fs.mkdirSync(incDir, { recursive: true })
    fs.writeFileSync(path.join(incDir, 'a.conf'), 'Host app1\\n')
    fs.writeFileSync(path.join(sshDir, 'config'), 'Host web1\\nInclude conf.d/*\\n')
    fs.chmodSync(incDir, 0o000)
    const unread = []
    try {
      out.hosts = remoteHostNames(() => true, unread)
      out.unread = unread
    } catch (e) {
      out.code = e.code ?? e.name
    } finally {
      fs.chmodSync(incDir, 0o700)
    }
  `)
  check('hosts-unreadable-include-dir', r2.code === undefined && ((r2.hosts ?? []) as string[]).includes('web1') && ((r2.unread ?? []) as string[]).length === 1, JSON.stringify(r2))

  const r3 = runSub(`
    const { remoteHostNames, renderRemoteHosts } = await import(path.join(SRC, 'platform/remote-files/hosts.ts'))
    const unread = []
    out.hosts = remoteHostNames(() => true, unread)
    out.unread = unread.length
    out.content = renderRemoteHosts(out.hosts, unread).content
  `)
  check('hosts-absent-config-ok', Array.isArray(r3.hosts) && r3.unread === 0 && !String(r3.content ?? '').includes('Not read'), JSON.stringify(r3))
}

console.log('\nremoteFiles/ops.ts — a probe file that cannot be placed does not stop remote work: the host is read as before')
{
  const r = runSub(`
    const { mock } = await import('bun:test')
    const connPath = path.join(SRC, 'platform/remote-files/connection.ts')
    const realConn = await import(connPath)
    const scripts = []
    mock.module(connPath, () => ({
      ...realConn,
      remoteRun: async (authority, request) => {
        scripts.push(request.script)
        return { status: 0, stdout: Buffer.from('/home/u\\0Linux\\0' + '0' + '\\0ripgrep 14.1.0'), stderr: Buffer.from('') }
      },
    }))
    const { remoteIsThisMachine } = await import(path.join(SRC, 'platform/remote-files/ops.ts'))
    try {
      out.here = await remoteIsThisMachine({ host: 'example.invalid' })
    } catch (e) {
      out.code = e.code ?? e.name
    }
    out.ran = scripts.length
  `, { TMPDIR: '/nonexistent-faults-fn20-dir' })
  check('ops-remote-facts-probe-unplaced-goes-on', r.code === undefined && r.here === false && r.ran === 1, JSON.stringify(r))
}

console.log('\nrepoHost/repoHost.ts — corrupt or unreadable latest.json throws instead of returning null')
{
  const r = runSub(`
    const { latestReview } = await import(path.join(SRC, 'platform/repo-host/repoHost.ts'))
    const { projectHomeStore } = await import(path.join(SRC, 'platform/storage/projectHomeStores.ts'))
    out.absent = latestReview(PROJECT)
    const dir = projectHomeStore(PROJECT, 'reviews')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'latest.json')
    fs.writeFileSync(file, '{broken json', { mode: 0o600 })
    try {
      out.corrupt = latestReview(PROJECT)
    } catch (e) {
      out.corruptErr = e.name
    }
    if (${JSON.stringify(POSIX_MODES)}) {
      fs.writeFileSync(file, '{"schema":1,"id":"r1","at":1,"scope":"worktree","inspected":[],"findings":[]}', { mode: 0o600 })
      fs.chmodSync(file, 0o000)
      try {
        out.unreadable = latestReview(PROJECT)
      } catch (e) {
        out.unreadableCode = e.code ?? e.name
      } finally {
        fs.chmodSync(file, 0o600)
      }
    }
  `)
  check('repoHost-latest-review-absent-null', r.absent === null, JSON.stringify(r))
  check('repoHost-latest-review-corrupt-throws', r.corruptErr === 'SyntaxError', JSON.stringify(r))
  if (POSIX_MODES) check('repoHost-latest-review-unreadable-throws', r.unreadableCode === 'EACCES', JSON.stringify(r))
}

console.log('\nresources/adapters/file.ts — EACCES statSync throws so registry answers unavailable instead of absent')
if (!POSIX_MODES) {
  skip('file-adapter-stat-eacces-not-absent', 'needs non-root POSIX')
} else {
  const r = runSub(`
    const { resolveResource } = await import(path.join(SRC, 'integrations/resources/registry.ts'))
    const { processMainOwner } = await import(path.join(SRC, 'engine/run-owner/resolveOwner.ts'))
    const locked = path.join(PROJECT, 'locked')
    fs.mkdirSync(locked, { recursive: true })
    const target = path.join(locked, 'secret.txt')
    fs.writeFileSync(target, 'hi')
    fs.chmodSync(locked, 0o000)
    try {
      out.locked = await resolveResource('mercury://file/' + target, { owner: processMainOwner(), cwd: PROJECT })
      out.missing = await resolveResource('mercury://file/' + path.join(PROJECT, 'missing.txt'), { owner: processMainOwner(), cwd: PROJECT })
    } finally {
      fs.chmodSync(locked, 0o700)
    }
  `)
  const locked = r.locked as { state?: string; note?: string }
  const missing = r.missing as { state?: string; note?: string }
  check('file-adapter-stat-eacces-not-absent', locked?.state === 'unavailable' && String(locked?.note).includes('EACCES'), JSON.stringify(locked))
  check('file-adapter-enoent-still-absent', missing?.state === 'absent', JSON.stringify(missing))
}

console.log('\nresources/adapters/health.ts — corrupt gate/cert files throw instead of claiming none written')
{
  const r = runSub(`
    const { resolveResource } = await import(path.join(SRC, 'integrations/resources/registry.ts'))
    const { processMainOwner } = await import(path.join(SRC, 'engine/run-owner/resolveOwner.ts'))
    const { gateVerdictPath, lastCertPath } = await import(path.join(SRC, 'platform/health/healthReport.ts'))
    const ctx = { owner: processMainOwner(), cwd: PROJECT }
    out.gateAbsent = await resolveResource('mercury://health/gate', ctx)
    out.certAbsent = await resolveResource('mercury://health/cert', ctx)
    fs.mkdirSync(path.dirname(gateVerdictPath()), { recursive: true })
    fs.writeFileSync(gateVerdictPath(), '{broken', { mode: 0o600 })
    fs.mkdirSync(path.dirname(lastCertPath()), { recursive: true })
    fs.writeFileSync(lastCertPath(), '{broken', { mode: 0o600 })
    out.gateCorrupt = await resolveResource('mercury://health/gate', ctx)
    out.certCorrupt = await resolveResource('mercury://health/cert', ctx)
  `)
  const gateAbsent = r.gateAbsent as { state?: string }
  const certAbsent = r.certAbsent as { state?: string }
  const gateCorrupt = r.gateCorrupt as { state?: string; note?: string }
  const certCorrupt = r.certCorrupt as { state?: string; note?: string }
  check('health-adapter-absent-ok', gateAbsent?.state === 'absent' && certAbsent?.state === 'absent', JSON.stringify({ gateAbsent, certAbsent }))
  check('health-adapter-gate-corrupt-unavailable', gateCorrupt?.state === 'unavailable', JSON.stringify(gateCorrupt))
  check('health-adapter-cert-corrupt-unavailable', certCorrupt?.state === 'unavailable', JSON.stringify(certCorrupt))
}

console.log('\nresources/adapters/transcript.ts — unreadable transcript or subagents dir fails instead of claiming empty')
if (!POSIX_MODES) {
  skip('transcript-adapter-unreadable-file-throws', 'needs non-root POSIX')
  skip('transcript-adapter-unreadable-subagents-dir-fails', 'needs non-root POSIX')
} else {
  const r = runSub(`
    const { jsonlConciseRows } = await import(path.join(SRC, 'integrations/resources/adapters/transcript.ts'))
    const { listResourceKind } = await import(path.join(SRC, 'integrations/resources/registry.ts'))
    const { makeOwnerKey, MAIN_LANE } = await import(path.join(SRC, 'engine/run-owner/ownerKey.ts'))
    const { getTranscriptPathForSession } = await import(path.join(SRC, 'sessions/transcripts/paths.ts'))
    const file = path.join(PROJECT, 'locked.jsonl')
    fs.writeFileSync(file, '{"type":"user","message":{"content":"hi"}}\\n', { mode: 0o600 })
    fs.chmodSync(file, 0o000)
    try {
      out.rows = jsonlConciseRows(file)
    } catch (e) {
      out.fileErr = e.code ?? e.name
    } finally {
      fs.chmodSync(file, 0o600)
    }
    const sid = '11111111-1111-1111-1111-111111111111'
    const sessionFile = getTranscriptPathForSession(sid)
    const subDir = path.join(path.dirname(sessionFile), sid, 'subagents')
    fs.mkdirSync(subDir, { recursive: true })
    fs.writeFileSync(path.join(subDir, 'agent-1.jsonl'), '')
    fs.chmodSync(subDir, 0o000)
    try {
      const owner = makeOwnerKey({ workspace: PROJECT, sessionId: sid, lane: MAIN_LANE })
      out.listRes = await listResourceKind('transcript', { owner, cwd: PROJECT })
    } finally {
      fs.chmodSync(subDir, 0o700)
    }
  `)
  const listRes = r.listRes as { state?: string; note?: string }
  check('transcript-adapter-unreadable-file-throws', r.fileErr === 'EACCES', JSON.stringify(r))
  check('transcript-adapter-unreadable-subagents-dir-fails', listRes?.state === 'unavailable', JSON.stringify(listRes))
}

console.log('\nresources/adapters/artifact.ts — computeWorkingTreeDigest throw makes artifact unavailable instead of dropping STALE')
{
  const r = runSub(`
    const { mock } = await import('bun:test')
    const verPath = path.join(SRC, 'platform/verification/verificationState.ts')
    const storePath = path.join(SRC, 'sessions/artifact-reviews/reviewStore.ts')
    const realVer = await import(verPath)
    const realStore = await import(storePath)
    mock.module(verPath, () => ({ ...realVer, computeWorkingTreeDigest: () => { throw new Error('digest boom') } }))
    mock.module(storePath, () => ({
      ...realStore,
      isReviewArtifactId: (id) => id === 'ra-test1',
      readReviewArtifactState: () => ({
        id: 'ra-test1',
        kind: 'plan',
        title: 'Test',
        latestVersion: 1,
        statuses: { 1: 'draft' },
        comments: [],
        versions: [{
          version: 1,
          kind: 'plan',
          title: 'Test',
          createdAt: 1,
          producer: { sessionId: 's1' },
          workspace: { roots: [PROJECT], treeDigest: 'deadbeef1234' },
          body: { kind: 'plan', markdown: 'hi' },
          evidenceRefs: [],
        }],
      }),
    }))
    const { resolveResource } = await import(path.join(SRC, 'integrations/resources/registry.ts'))
    const { processMainOwner } = await import(path.join(SRC, 'engine/run-owner/resolveOwner.ts'))
    out.res = await resolveResource('mercury://artifact/ra-test1', { owner: processMainOwner(), cwd: PROJECT })
  `)
  const res = r.res as { state?: string; note?: string }
  check('artifact-adapter-digest-throw-unavailable', res?.state === 'unavailable' && String(res?.note).includes('digest boom'), JSON.stringify(res))
}

console.log('\nresources/adapters/execution.ts — owner and DAP tree bugs propagate to registry unavailable')
{
  const r1 = runSub(`
    const { mock } = await import('bun:test')
    const resolveOwnerPath = path.join(SRC, 'engine/run-owner/resolveOwner.ts')
    const realOwner = await import(resolveOwnerPath)
    const owner = realOwner.processMainOwner()
    mock.module(resolveOwnerPath, () => ({ ...realOwner, processMainOwner: () => { throw new Error('owner boom') } }))
    const { listResourceKind } = await import(path.join(SRC, 'integrations/resources/registry.ts'))
    out.res = await listResourceKind('execution', { owner, cwd: PROJECT })
  `)
  const res1 = r1.res as { state?: string; note?: string }
  check('execution-adapter-owner-bug-propagates', res1?.state === 'unavailable' && String(res1?.note).includes('owner boom'), JSON.stringify(res1))

  const r2 = runSub(`
    const { mock } = await import('bun:test')
    const dapPath = path.join(SRC, 'integrations/debugger/dapClient.ts')
    const realDap = await import(dapPath)
    mock.module(dapPath, () => ({ ...realDap, getDapSession: () => { throw new Error('dap boom') } }))
    const { registerExecution } = await import(path.join(SRC, 'engine/execution-plane/executionPlane.ts'))
    const { resolveResource } = await import(path.join(SRC, 'integrations/resources/registry.ts'))
    const { processMainOwner } = await import(path.join(SRC, 'engine/run-owner/resolveOwner.ts'))
    const owner = processMainOwner()
    registerExecution({
      owner,
      id: 'dap-test-1',
      kind: 'debug-adapter',
      label: 'dap',
      lifecycle: 'owner',
      cwd: PROJECT,
      startedBy: 'test',
      metadata: { alias: 'a1' },
      initialState: 'running',
    })
    out.res = await resolveResource('mercury://execution/dap-test-1', { owner, cwd: PROJECT })
  `)
  const res2 = r2.res as { state?: string; note?: string }
  check('execution-adapter-dap-children-bug-propagates', res2?.state === 'unavailable' && String(res2?.note).includes('dap boom'), JSON.stringify(res2))
}

console.log('\nresources/adapters/project.ts — context marks/owner bug propagates instead of building empty pins')
{
  const r = runSub(`
    const { resolveResource } = await import(path.join(SRC, 'integrations/resources/registry.ts'))
    out.res = await resolveResource('mercury://project/current?child=context&q=fix+bug', { owner: 'not-canonical', cwd: PROJECT })
  `)
  const res = r.res as { state?: string; note?: string }
  check('project-adapter-context-marks-bug-propagates', res?.state === 'unavailable' && String(res?.note).includes('not a canonical owner key'), JSON.stringify(res))
}

console.log('\nrun/runCoordinator.ts — syncVerification drops verified state when verificationSummary throws')
{
  const r = runSub(`
    const { mock } = await import('bun:test')
    const verPath = path.join(SRC, 'platform/verification/verificationState.ts')
    const realVer = await import(verPath)
    mock.module(verPath, () => ({ ...realVer, verificationSummary: () => { throw new Error('verify boom') } }))
    const coord = await import(path.join(SRC, 'engine/run/runCoordinator.ts'))
    const { makeOwnerKey, MAIN_LANE } = await import(path.join(SRC, 'engine/run-owner/ownerKey.ts'))
    const owner = makeOwnerKey({ workspace: PROJECT, sessionId: 'sync-ver-test', lane: MAIN_LANE })
    coord.acceptUserRequest(owner, { objective: 'test', rootMessageId: 'u1' })
    coord.noteRunEvent(owner, { type: 'evidence', at: 1, state: 'verified', detail: 'tests green' })
    coord.syncVerification(owner, PROJECT)
    out.verification = coord.getRunSnapshot(owner)?.verification
  `)
  const v = r.verification as { state?: string; detail?: string }
  check('runCoordinator-syncVerification-clears-verified-on-throw', v?.state === 'unverified' && String(v?.detail).includes('verify boom'), JSON.stringify(v))
}

console.log('\nrun/runSidecar.ts — unreadable sidecar is not overwritten and failed delete throws')
if (!POSIX_MODES) {
  skip('runSidecar-save-refuses-unreadable-existing', 'needs non-root POSIX')
  skip('runSidecar-delete-unwritable-dir-throws', 'needs non-root POSIX')
} else {
  const r = runSub(`
    const { saveRunSidecar, deleteRunSidecar, runSidecarPath } = await import(path.join(SRC, 'engine/run/runSidecar.ts'))
    const { emptyRunSnapshot } = await import(path.join(SRC, 'engine/run/runKernel.ts'))
    const { makeOwnerKey, MAIN_LANE } = await import(path.join(SRC, 'engine/run-owner/ownerKey.ts'))
    const owner = makeOwnerKey({ workspace: PROJECT, sessionId: '22222222-2222-2222-2222-222222222222', lane: MAIN_LANE })
    const file = runSidecarPath(owner)
    const dir = path.dirname(file)
    fs.mkdirSync(dir, { recursive: true })
    const original = JSON.stringify({ schema: 1, writeSeq: 7, snapshot: {} })
    fs.writeFileSync(file, original, { mode: 0o600 })
    fs.chmodSync(file, 0o000)
    const snap = emptyRunSnapshot({ runId: 'r1', owner, objective: 'obj', rootMessageId: null, at: 1 })
    try {
      await saveRunSidecar(owner, snap)
      out.saveOk = true
    } catch (e) {
      out.saveCode = e.code ?? e.name
    } finally {
      fs.chmodSync(file, 0o600)
    }
    out.preserved = fs.readFileSync(file, 'utf8') === original

    fs.chmodSync(dir, 0o500)
    try {
      await deleteRunSidecar(owner)
      out.delOk = true
    } catch (e) {
      out.delCode = e.code ?? e.name
    } finally {
      fs.chmodSync(dir, 0o700)
    }
  `)
  check('runSidecar-save-refuses-unreadable-existing', r.saveCode === 'EACCES' && r.preserved === true, JSON.stringify(r))
  check('runSidecar-delete-unwritable-dir-throws', r.delCode === 'EACCES', JSON.stringify(r))
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
