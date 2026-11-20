#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const HERE = import.meta.dir
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')
const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

function runSub(body: string, extraEnv: Record<string, string> = {}): Record<string, unknown> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'faults-fn16-')))
  const home = join(scratch, 'home')
  const work = join(scratch, 'work')
  mkdirSync(home, { recursive: true })
  mkdirSync(work, { recursive: true })
  const src = `
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
    process.env.NODE_ENV = 'test'
    delete process.env.MERCURY_HOME
    globalThis.MACRO = { VERSION: '1.0.0' }
    const SCRATCH = ${JSON.stringify(scratch)}
    const HOME_DIR = ${JSON.stringify(home)}
    const WORK = ${JSON.stringify(work)}
    const SRC = ${JSON.stringify(SRC)}
    const out = {}
    ${body}
    process.stdout.write('\\n' + JSON.stringify(out))
    process.exit(0)
  `
  try {
    const res = spawnSync(BUN, ['-e', src], {
      encoding: 'utf8',
      env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_LOCAL_PROBE_TARGETS: 'none', ...extraEnv },
    })
    if (res.status !== 0) throw new Error(`sub failed (${res.status}): ${res.stderr.slice(-1200)}`)
    return JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

{
  console.log('\npaths.ts — failed homedir refuses estate creation')
  const r = runSub(`
    const { mock } = await import('bun:test')
    const realOs = await import('node:os')
    mock.module('node:os', () => ({ ...realOs, homedir: () => { throw new Error('homedir unavailable') } }))
    const fs = await import('node:fs')
    const path = await import('node:path')
    const paths = await import(path.join(SRC, 'services/projectLocal/paths.ts'))
    const target = path.join(WORK, 'maybe-home')
    fs.mkdirSync(target, { recursive: true })
    let threw = null
    let result = undefined
    try {
      result = paths.initializeProjectLocalEstate(target)
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e)
    }
    out.threw = threw
    out.result = result
    out.created = fs.existsSync(path.join(target, '.mercury'))
  `)
  check(
    'initializeProjectLocalEstate throws and does not create .mercury when homedir fails',
    r.threw === 'homedir unavailable' && r.created === false,
    JSON.stringify(r),
  )
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
