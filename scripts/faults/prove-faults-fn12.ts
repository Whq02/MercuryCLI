#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'prove-faults-fn12-')))
const configHome = join(scratch, 'home')
mkdirSync(configHome, { recursive: true })
process.env.MERCURY_CONFIG_DIR = configHome
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function skip(label: string, why: string): void {
  console.log(`  [SKIP] ${label} — ${why}`)
}

async function run(): Promise<void> {
  {
    const { readConflictRegions } = await import('../../src/services/gitGraph/conflictRegionStore.ts')
    const root = join(scratch, 'conflict-regions')
    mkdirSync(root, { recursive: true })
    const owner = 'session:fn12-conflict' as import('../../src/services/run/ownerKey.ts').OwnerKey
    const absent = readConflictRegions(owner, root, 'missing.txt')
    check('conflictRegionStore-enoent: absent file returns empty regions', absent.length === 0)
    if (!POSIX_MODES) skip('conflictRegionStore-eacces', 'needs non-root POSIX')
    else {
      const locked = join(root, 'locked.txt')
      writeFileSync(locked, '<<<<<<< ours\na\n=======\nb\n>>>>>>> theirs\n')
      chmodSync(locked, 0o000)
      let threw: NodeJS.ErrnoException | null = null
      try { readConflictRegions(owner, root, 'locked.txt') } catch (error) { threw = error as NodeJS.ErrnoException }
      finally { chmodSync(locked, 0o600) }
      check('conflictRegionStore-eacces: unreadable file throws EACCES instead of returning empty regions', threw?.code === 'EACCES', String(threw))
    }
  }

  {
    const { commitIdentityLine } = await import('../../src/services/gitGraph/observe.ts')
    const root = join(scratch, 'observe-config')
    const gitHome = join(scratch, 'observe-git-home')
    mkdirSync(root, { recursive: true })
    mkdirSync(gitHome, { recursive: true })
    const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM }
    Object.assign(process.env, { HOME: gitHome, XDG_CONFIG_HOME: join(gitHome, '.config'), GIT_CONFIG_GLOBAL: join(gitHome, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' })
    try {
      execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: root, env: process.env })
      const unset = commitIdentityLine(root)
      check('observe-config-unset: unset user.name/email returns unset line', Boolean(unset?.includes('user.name and user.email unset')), String(unset))
      writeFileSync(join(root, '.git', 'config'), '[broken\n')
      let threw: unknown = null
      try { commitIdentityLine(root) } catch (error) { threw = error }
      check('observe-config-corrupt: corrupt .git/config throws instead of reporting identity unset', threw !== null, 'returned without throwing')
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }
}

try {
  await run()
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
