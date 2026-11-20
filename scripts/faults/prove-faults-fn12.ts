#!/usr/bin/env bun
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
}

try {
  await run()
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
