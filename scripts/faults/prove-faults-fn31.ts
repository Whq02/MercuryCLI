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
    const { restoreGatewayAuth } = await import(SRC + '/utils/gatewayTrust.ts')
    await restoreGatewayAuth()
    out.activated = logs.some(l => l.includes('verified session'))
    out.refused = logs.some(l => l.includes('TLS fingerprint probe failed'))
  `)
  check(
    'gatewayTrust:restore-refuses-on-tls-probe-failure',
    r.activated === false && r.refused === true,
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

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
