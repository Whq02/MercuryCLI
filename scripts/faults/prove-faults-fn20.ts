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

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
