#!/usr/bin/env bun
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

function makeScratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `faults-fn07-${prefix}-`))
}

function threwOf(fn: () => unknown): Error | null {
  try {
    fn()
    return null
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e))
  }
}

{
  console.log('\nmnemeLibrary-readLibraryMeta-unreadable')
  const { readLibraryMeta, libraryMetaPath } = await import('../../src/mneme/mnemeLibrary.ts')
  const dir = makeScratch('libmeta')
  try {
    const fresh = readLibraryMeta(dir)
    check('absent library.json returns fresh meta', fresh.seqCounter === 0 && fresh.lastConsolidatedAt === null)

    const p = libraryMetaPath(dir)
    const rawValid = JSON.stringify({ version: 1, seqCounter: 42, lastConsolidatedAt: '2026-01-01T00:00:00.000Z' })
    writeFileSync(p, rawValid)
    check('valid library.json reads seqCounter', readLibraryMeta(dir).seqCounter === 42)

    writeFileSync(p, '{corrupt')
    const parseErr = threwOf(() => readLibraryMeta(dir))
    check('corrupt JSON library.json throws instead of resetting seqCounter', parseErr !== null, 'returned fresh meta')

    writeFileSync(p, JSON.stringify({ version: 1 }))
    const schemaErr = threwOf(() => readLibraryMeta(dir))
    check('invalid schema library.json throws instead of resetting seqCounter', schemaErr !== null, 'returned fresh meta')

    if (POSIX_MODES) {
      writeFileSync(p, rawValid, { mode: 0o600 })
      chmodSync(p, 0o200)
      const permErr = threwOf(() => readLibraryMeta(dir))
      chmodSync(p, 0o600)
      check('unreadable library.json throws EACCES', permErr !== null && (permErr as NodeJS.ErrnoException).code === 'EACCES', String(permErr))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

{
  console.log('\nmnemeMaintenance-readMaintenanceReceipts-unreadable')
  const { readMaintenanceReceipts, runDueMaintenance } = await import('../../src/mneme/mnemeMaintenance.ts')
  const dir = makeScratch('maint-receipts')
  try {
    check('absent maintenance.jsonl returns empty list', readMaintenanceReceipts(dir).length === 0)
    const p = join(dir, 'maintenance.jsonl')
    const prior = JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', trigger: 'operator', ran: true, reason: 'prior' }) + '\n'
    writeFileSync(p, prior, { mode: 0o600 })
    check('readable maintenance.jsonl returns prior receipt', readMaintenanceReceipts(dir).length === 1)
    if (POSIX_MODES) {
      chmodSync(p, 0o200)
      const permErr = threwOf(() => readMaintenanceReceipts(dir))
      await runDueMaintenance('operator', { dir, force: true })
      chmodSync(p, 0o600)
      check('unreadable maintenance.jsonl throws EACCES', permErr !== null && (permErr as NodeJS.ErrnoException).code === 'EACCES', String(permErr))
      check('appendReceipt does not wipe unreadable maintenance.jsonl', readFileSync(p, 'utf8') === prior, readFileSync(p, 'utf8'))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
