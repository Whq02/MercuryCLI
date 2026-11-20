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

const HERE = dirname(fileURLToPath(import.meta.url))
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')
const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

function runScenario(body: string, extraEnv: Record<string, string> = {}): Record<string, unknown> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'prove-faults-fn11-')))
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
    const fsp = await import('node:fs/promises')
    const path = await import('node:path')
    const SRC = ${JSON.stringify(SRC)}
    const HOME = ${JSON.stringify(home)}
    const SCRATCH = ${JSON.stringify(scratch)}
    const out = {}
    ${body}
    process.stdout.write('\\n' + JSON.stringify(out))
    process.exit(0)
  `
  try {
    const res = spawnSync(BUN, ['-e', src], {
      encoding: 'utf8',
      env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '', ...extraEnv },
    })
    if (res.status !== 0) throw new Error(`scenario failed (rc=${res.status}): ${res.stderr.slice(-1500)}`)
    return JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

console.log('\ncomputerGrant.clearComputerGrant — non-ENOENT unlink failure throws')
{
  const r = runScenario(`
    const cg = await import(path.join(SRC, 'services/desktop/computerGrant.ts'))
    const grantFile = cg.computerGrantPath('sess-1', HOME)
    cg.writeComputerGrant('sess-1', cg.sessionComputerGrant(1000), HOME)
    const dir = path.dirname(grantFile)
    if (${JSON.stringify(POSIX_MODES)}) {
      fs.chmodSync(dir, 0o500)
      try {
        cg.clearComputerGrant('sess-1', HOME)
        out.clearDenied = null
      } catch (e) {
        out.clearDenied = { code: e.code ?? null, message: String(e.message ?? e) }
      } finally {
        fs.chmodSync(dir, 0o700)
      }
      out.stillOnDisk = fs.existsSync(grantFile)
      cg.writeComputerGrant('sess-exp', cg.timedComputerGrant(1, 1000), HOME)
      const expDir = path.dirname(cg.computerGrantPath('sess-exp', HOME))
      fs.chmodSync(expDir, 0o500)
      try {
        out.expiredRead = cg.readComputerGrant('sess-exp', 1000 + cg.HOUR_MS + 1, HOME)
      } finally {
        fs.chmodSync(expDir, 0o700)
      }
    } else {
      fs.rmSync(grantFile)
      fs.mkdirSync(grantFile)
      try {
        cg.clearComputerGrant('sess-1', HOME)
        out.clearDenied = null
      } catch (e) {
        out.clearDenied = { code: e.code ?? null, message: String(e.message ?? e) }
      }
      out.stillOnDisk = fs.existsSync(grantFile)
      fs.rmdirSync(grantFile)
      out.expiredRead = null
    }
    cg.clearComputerGrant('sess-absent', HOME)
    out.absentOk = true
  `)
  check('clearComputerGrant throws when unlink fails with non-ENOENT', r.clearDenied !== null && r.stillOnDisk === true, JSON.stringify(r))
  check('clearComputerGrant ignores ENOENT and readComputerGrant still returns null on expired grant', r.absentOk === true && r.expiredRead === null, JSON.stringify(r))
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
