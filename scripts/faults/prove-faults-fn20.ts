#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
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

console.log('\nremoteFiles/hosts.ts — unreadable ssh config or include folder throws instead of returning empty')
if (!POSIX_MODES) {
  skip('hosts-unreadable-config', 'needs non-root POSIX')
  skip('hosts-unreadable-include-dir', 'needs non-root POSIX')
} else {
  const r1 = runSub(`
    const { remoteHostNames } = await import(path.join(SRC, 'services/remoteFiles/hosts.ts'))
    const sshDir = path.join(HOME, '.ssh')
    fs.mkdirSync(sshDir, { recursive: true })
    const cfg = path.join(sshDir, 'config')
    fs.writeFileSync(cfg, 'Host web1\\n', { mode: 0o600 })
    fs.chmodSync(cfg, 0o000)
    try {
      out.hosts = remoteHostNames(() => true)
    } catch (e) {
      out.code = e.code ?? e.name
    } finally {
      fs.chmodSync(cfg, 0o600)
    }
  `)
  check('hosts-unreadable-config', r1.code === 'EACCES', JSON.stringify(r1))

  const r2 = runSub(`
    const { remoteHostNames } = await import(path.join(SRC, 'services/remoteFiles/hosts.ts'))
    const sshDir = path.join(HOME, '.ssh')
    const incDir = path.join(sshDir, 'conf.d')
    fs.mkdirSync(incDir, { recursive: true })
    fs.writeFileSync(path.join(incDir, 'a.conf'), 'Host app1\\n')
    fs.writeFileSync(path.join(sshDir, 'config'), 'Include conf.d/*\\n')
    fs.chmodSync(incDir, 0o000)
    try {
      out.hosts = remoteHostNames(() => true)
    } catch (e) {
      out.code = e.code ?? e.name
    } finally {
      fs.chmodSync(incDir, 0o700)
    }
  `)
  check('hosts-unreadable-include-dir', r2.code === 'EACCES', JSON.stringify(r2))

  const r3 = runSub(`
    const { remoteHostNames } = await import(path.join(SRC, 'services/remoteFiles/hosts.ts'))
    out.hosts = remoteHostNames(() => true)
  `)
  check('hosts-absent-config-ok', Array.isArray(r3.hosts), JSON.stringify(r3))
}

console.log('\nremoteFiles/ops.ts — unwritable tmpdir fails closed in remoteIsThisMachine')
{
  const r = runSub(`
    const { remoteIsThisMachine } = await import(path.join(SRC, 'services/remoteFiles/ops.ts'))
    try {
      out.here = await remoteIsThisMachine({ host: 'example.invalid' })
    } catch (e) {
      out.code = e.code ?? e.name
    }
  `, { TMPDIR: '/nonexistent-faults-fn20-dir' })
  check('ops-remote-facts-probe-fails-closed', r.code === 'ENOENT' || r.code === 'EACCES', JSON.stringify(r))
}

console.log('\nrepoHost/repoHost.ts — corrupt or unreadable latest.json throws instead of returning null')
{
  const r = runSub(`
    const { latestReview } = await import(path.join(SRC, 'services/repoHost/repoHost.ts'))
    const { projectHomeStore } = await import(path.join(SRC, 'utils/projectHomeStores.ts'))
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
    const { resolveResource } = await import(path.join(SRC, 'services/resources/registry.ts'))
    const { processMainOwner } = await import(path.join(SRC, 'services/run/resolveOwner.ts'))
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
    const { resolveResource } = await import(path.join(SRC, 'services/resources/registry.ts'))
    const { processMainOwner } = await import(path.join(SRC, 'services/run/resolveOwner.ts'))
    const { gateVerdictPath, lastCertPath } = await import(path.join(SRC, 'utils/healthReport.ts'))
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
    const { jsonlConciseRows } = await import(path.join(SRC, 'services/resources/adapters/transcript.ts'))
    const { listResourceKind } = await import(path.join(SRC, 'services/resources/registry.ts'))
    const { makeOwnerKey, MAIN_LANE } = await import(path.join(SRC, 'services/run/ownerKey.ts'))
    const { getTranscriptPathForSession } = await import(path.join(SRC, 'utils/sessionStorage/paths.ts'))
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

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
