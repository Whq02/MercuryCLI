#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
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

function runScenario(body: string): Record<string, unknown> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'faults-fn04-')))
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
    const SCRATCH = ${JSON.stringify(scratch)}
    const HOME = ${JSON.stringify(home)}
    const PROJECT = ${JSON.stringify(project)}
    const SRC = ${JSON.stringify(SRC)}
    const out = {}
    ${body}
    process.stdout.write('\\n' + JSON.stringify(out))
    process.exit(0)
  `
  const res = spawnSync(BUN, ['-e', src], {
    encoding: 'utf8',
    env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '' },
  })
  if (res.status !== 0) throw new Error(`scenario failed: ${res.stderr.slice(-1500)}`)
  return JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>
}

console.log('\nSessionManagerView — ownSessionRecord catches malformed worker lookup without crashing render')
{
  const r = runScenario(`
    const { mock } = await import('bun:test')
    const workersMod = path.join(SRC, 'daemon/concourseWorkers.ts')
    const real = await import(workersMod)
    mock.module(workersMod, () => ({
      ...real,
      readSessionWorkers: () => { throw new TypeError('worker-bug') },
    }))
    const mod = await import(path.join(SRC, 'components/mercury-ui/screens/SessionManagerView.tsx'))
    try {
      out.value = mod.ownSessionRecord('sess-1') ?? null
      out.threw = null
    } catch (error) {
      out.threw = error instanceof Error ? error.message : String(error)
    }
  `)
  check('SessionManagerView.ownSessionRecord returns undefined without throwing into render', r.threw === null && r.value === null, JSON.stringify(r))
}

console.log('\nFilePermissionDialog — resolveSymlinkTarget resolves dangling symlinks so outside-workspace warning shows')
{
  const r = runScenario(`
    const mod = await import(path.join(SRC, 'components/permissions/FilePermissionDialog/FilePermissionDialog.tsx'))
    const outsideTarget = path.join(SCRATCH, 'outside-new-file.txt')
    const linkPath = path.join(PROJECT, 'dangling-link.txt')
    fs.symlinkSync(outsideTarget, linkPath)
    const plainPath = path.join(PROJECT, 'plain.txt')
    fs.writeFileSync(plainPath, 'ok')
    const liveTarget = path.join(SCRATCH, 'outside-live.txt')
    fs.writeFileSync(liveTarget, 'live')
    const liveLink = path.join(PROJECT, 'live-link.txt')
    fs.symlinkSync(liveTarget, liveLink)
    out.hasExport = typeof mod.resolveSymlinkTarget === 'function'
    out.dangling = mod.resolveSymlinkTarget?.(linkPath) ?? null
    out.live = mod.resolveSymlinkTarget?.(liveLink) ?? null
    out.plain = mod.resolveSymlinkTarget?.(plainPath) ?? null
    out.absent = mod.resolveSymlinkTarget?.(path.join(PROJECT, 'does-not-exist.txt')) ?? null
    out.expectedDangling = outsideTarget
    out.expectedLive = fs.realpathSync(liveTarget)
  `)
  check('FilePermissionDialog.resolveSymlinkTarget resolves dangling symlink target', r.hasExport === true && r.dangling === r.expectedDangling, JSON.stringify(r))
  check('FilePermissionDialog.resolveSymlinkTarget keeps live symlink, plain file, and absent file behaviour', r.live === r.expectedLive && r.plain === null && r.absent === null, JSON.stringify(r))
}

void skip
void POSIX_MODES
console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
