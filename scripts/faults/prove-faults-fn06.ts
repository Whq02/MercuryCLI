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

function runCase(body: string): Record<string, unknown> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'faults-fn06-')))
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
    const home = ${JSON.stringify(home)}
    const project = ${JSON.stringify(project)}
    const SRC = ${JSON.stringify(SRC)}
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
    if (res.status !== 0) throw new Error(`case failed: ${res.stderr.slice(-1500)}`)
    return JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

console.log('\nsrc/keybindings/loadUserBindings.ts')
if (!POSIX_MODES) {
  skip('keybindings-sync-unreadable', 'needs non-root POSIX chmod')
  skip('keybindings-async-project-unreadable', 'needs non-root POSIX chmod')
} else {
  const r = runCase(`
    const { enableConfigs } = await import(path.join(SRC, 'utils/config/globalConfig.ts'))
    const { setPathTrusted } = await import(path.join(SRC, 'utils/config/trust.ts'))
    const kb = await import(path.join(SRC, 'keybindings/loadUserBindings.ts'))
    enableConfigs()
    setPathTrusted(project)
    out.absentSync = kb.loadKeybindingsSyncWithWarnings().warnings
    const userFile = kb.getKeybindingsPath()
    fs.writeFileSync(userFile, '{"bindings":[]}', { mode: 0o600 })
    fs.chmodSync(userFile, 0o200)
    kb.invalidateKeybindingsCache()
    out.unreadableSync = kb.loadKeybindingsSyncWithWarnings().warnings
    fs.chmodSync(userFile, 0o600)
    fs.unlinkSync(userFile)

    const projDir = path.join(project, '.mercury')
    const projFile = path.join(projDir, 'keybindings.json')
    fs.mkdirSync(projDir, { recursive: true })
    fs.writeFileSync(projFile, '{"bindings":[]}', { mode: 0o600 })
    fs.chmodSync(projFile, 0o200)
    out.unreadableAsyncProject = (await kb.loadKeybindings()).warnings
    kb.invalidateKeybindingsCache()
    out.unreadableSyncProject = kb.loadKeybindingsSyncWithWarnings().warnings
    fs.chmodSync(projFile, 0o600)
  `)
  const absentSync = r.absentSync as Array<{ message: string }>
  const unreadableSync = r.unreadableSync as Array<{ type: string; severity: string; message: string }>
  const unreadableAsyncProject = r.unreadableAsyncProject as Array<{ type: string; severity: string; message: string }>
  const unreadableSyncProject = r.unreadableSyncProject as Array<{ type: string; severity: string; message: string }>
  check(
    'keybindings-sync-unreadable',
    absentSync.length === 0 &&
      unreadableSync.some(w => w.type === 'parse_error' && w.severity === 'error' && w.message.startsWith('Could not read the user keybindings file:')) &&
      unreadableSyncProject.some(w => w.type === 'parse_error' && w.severity === 'error' && w.message.startsWith('Could not read the project keybindings file:')),
    JSON.stringify({ absentSync, unreadableSync, unreadableSyncProject }),
  )
  check(
    'keybindings-async-project-unreadable',
    unreadableAsyncProject.some(w => w.type === 'parse_error' && w.severity === 'error' && w.message.startsWith('Could not read the project keybindings file:')),
    JSON.stringify(unreadableAsyncProject),
  )
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
