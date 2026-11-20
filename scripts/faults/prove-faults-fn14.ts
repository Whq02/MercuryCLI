#!/usr/bin/env bun
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratchHome = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-faults-fn14-home-')))
process.env.MERCURY_CONFIG_DIR = scratchHome
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

function makeTempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}

function throwsMatching(fn: () => unknown, pattern: RegExp): { threw: boolean; message: string } {
  try {
    fn()
    return { threw: false, message: '(did not throw)' }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { threw: pattern.test(message), message }
  }
}

const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

{
  const { parseGodotProjectFile, _resetGodotSessionForTesting } = await import('../../src/services/ide/godotSession.ts')
  const dir = makeTempDir('fn14-godot-')
  try {
    _resetGodotSessionForTesting()
    const absent = parseGodotProjectFile(dir)
    check('godotSession: absent project.godot returns empty', Object.keys(absent).length === 0, JSON.stringify(absent))
    if (POSIX_MODES) {
      const proj = join(dir, 'project.godot')
      writeFileSync(proj, '[application]\nconfig/name="Demo"\n')
      chmodSync(proj, 0o200)
      try {
        _resetGodotSessionForTesting()
        const r = throwsMatching(() => parseGodotProjectFile(dir), /EACCES|permission/i)
        check('godotSession: unreadable project.godot throws instead of empty', r.threw, r.message)
      } finally {
        chmodSync(proj, 0o600)
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

rmSync(scratchHome, { recursive: true, force: true })
console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
