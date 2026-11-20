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

function runSubprocess(body: string): Record<string, unknown> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'faults-fn22-')))
  const home = join(scratch, 'home')
  const project = join(scratch, 'project')
  mkdirSync(home, { recursive: true })
  mkdirSync(project, { recursive: true })
  const src = `
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
    process.env.NODE_ENV = 'test'
    delete process.env.MERCURY_HOME
    globalThis.MACRO = { VERSION: '1.0.0' }
    process.chdir(${JSON.stringify(project)})
    const fs = await import('node:fs')
    const path = await import('node:path')
    const SRC = ${JSON.stringify(SRC)}
    const PROJECT = ${JSON.stringify(project)}
    const HOME = ${JSON.stringify(home)}
    const attempt = async fn => {
      try { return { ok: true, value: await fn() } }
      catch (e) { return { ok: false, code: e?.code ?? null, name: e?.name ?? null, message: String(e?.message ?? e) } }
    }
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
    if (res.status !== 0) throw new Error(`subprocess exited ${res.status}: ${(res.stderr || res.stdout).slice(-1200)}`)
    return JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

type Attempt = { ok: boolean; value?: unknown; code?: string | null; name?: string | null; message?: string }

console.log('\n1. unity/bridgeInstaller.ts — readProjectBridgePort throws on corrupt or unreadable settings')
{
  const r = runSubprocess(`
    const m = await import(path.join(SRC, 'services/unity/bridgeInstaller.ts'))
    const settingsDir = path.join(PROJECT, 'ProjectSettings')
    const settingsFile = path.join(settingsDir, 'MercuryUnityBridge.json')
    out.absent = await attempt(() => m.readProjectBridgePort(PROJECT))
    fs.mkdirSync(settingsDir, { recursive: true })
    fs.writeFileSync(settingsFile, JSON.stringify({ port: 7123 }))
    out.valid = await attempt(() => m.readProjectBridgePort(PROJECT))
    fs.writeFileSync(settingsFile, '{not valid json')
    out.corrupt = await attempt(() => m.readProjectBridgePort(PROJECT))
    if (${JSON.stringify(POSIX_MODES)}) {
      fs.writeFileSync(settingsFile, JSON.stringify({ port: 7123 }))
      fs.chmodSync(settingsFile, 0o200)
      out.unreadable = await attempt(() => m.readProjectBridgePort(PROJECT))
      fs.chmodSync(settingsFile, 0o600)
    }
  `)
  const absent = r.absent as Attempt
  const valid = r.valid as Attempt
  const corrupt = r.corrupt as Attempt
  check('bridgeInstaller-readProjectBridgePort: absent file returns undefined', absent.ok && absent.value === undefined, JSON.stringify(absent))
  check('bridgeInstaller-readProjectBridgePort: valid settings file returns port', valid.ok && valid.value === 7123, JSON.stringify(valid))
  check('bridgeInstaller-readProjectBridgePort: corrupt JSON throws SyntaxError', !corrupt.ok && corrupt.name === 'SyntaxError', JSON.stringify(corrupt))
  if (!POSIX_MODES) skip('bridgeInstaller-readProjectBridgePort: unreadable file', 'needs non-root POSIX')
  else {
    const unreadable = r.unreadable as Attempt
    check('bridgeInstaller-readProjectBridgePort: unreadable settings throws EACCES', !unreadable.ok && unreadable.code === 'EACCES', JSON.stringify(unreadable))
  }
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
