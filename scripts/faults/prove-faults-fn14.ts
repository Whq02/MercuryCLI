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

{
  const { getTransaction, latestTransaction, listTransactions, openTransactionIdFor } = await import('../../src/services/ide/ideTransaction.ts')
  const { projectHomeStore } = await import('../../src/utils/projectHomeStores.ts')
  const dir = makeTempDir('fn14-idetx-')
  try {
    check('ideTransaction: absent store returns null and empty list', latestTransaction(dir) === null && listTransactions(dir).length === 0)
    const store = projectHomeStore(dir, 'ide-transactions')
    mkdirSync(store, { recursive: true })
    writeFileSync(join(store, 'latest.json'), '{not-json')
    writeFileSync(join(store, 'tx-100-abc.json'), '{not-json')
    const r1 = throwsMatching(() => latestTransaction(dir), /corrupt|JSON|parse/i)
    const r2 = throwsMatching(() => getTransaction('tx-100-abc', dir), /corrupt|JSON|parse/i)
    const r3 = throwsMatching(() => listTransactions(dir), /corrupt|JSON|parse/i)
    const r4 = throwsMatching(() => openTransactionIdFor(dir), /corrupt|JSON|parse/i)
    check('ideTransaction: corrupt latest.json throws on latestTransaction', r1.threw, r1.message)
    check('ideTransaction: corrupt record throws on getTransaction', r2.threw, r2.message)
    check('ideTransaction: corrupt record throws on listTransactions', r3.threw, r3.message)
    check('ideTransaction: corrupt latest.json throws on openTransactionIdFor', r4.threw, r4.message)
    if (POSIX_MODES) {
      const dir2 = makeTempDir('fn14-idetx-perm-')
      const store2 = projectHomeStore(dir2, 'ide-transactions')
      mkdirSync(store2, { recursive: true })
      chmodSync(store2, 0o000)
      try {
        const r5 = throwsMatching(() => listTransactions(dir2), /EACCES|permission/i)
        check('ideTransaction: unreadable store dir throws on listTransactions', r5.threw, r5.message)
      } finally {
        chmodSync(store2, 0o700)
        rmSync(dir2, { recursive: true, force: true })
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

rmSync(scratchHome, { recursive: true, force: true })
console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
