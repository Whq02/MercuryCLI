#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

function withScratchConfig<T>(fn: (dir: string) => T): T {
  const saved = process.env.MERCURY_CONFIG_DIR
  const dir = mkdtempSync(join(tmpdir(), 'prove-faults-fn19-'))
  process.env.MERCURY_CONFIG_DIR = dir
  try {
    return fn(dir)
  } finally {
    if (saved === undefined) delete process.env.MERCURY_CONFIG_DIR
    else process.env.MERCURY_CONFIG_DIR = saved
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('1 · qualificationStore: unreadable or corrupt file throws on read and is not clobbered on write')
{
  const q = await import('../../src/services/providers/openai/qualificationStore.js')
  withScratchConfig(() => {
    const file = q.__qualificationFilePathForTest()
    check('absent file reads as empty receipts', q.readQualificationReceipts().length === 0)

    writeFileSync(file, '{broken json', 'utf8')
    let corruptReadErr: unknown
    try {
      q.readQualificationReceipts()
    } catch (error) {
      corruptReadErr = error
    }
    check('corrupt file throws on readQualificationReceipts', corruptReadErr instanceof Error, String(corruptReadErr))

    const writeOnCorrupt = q.recordLiveQualification({ modelId: 'gpt-5', role: 'primary', sourceKind: 'api-key', now: () => 100 })
    check('recordLiveQualification refuses to overwrite corrupt file', writeOnCorrupt === undefined && readFileSync(file, 'utf8') === '{broken json')

    const wireOnCorrupt = q.recordWireEffortRefusal({ modelId: 'gpt-5', sourceKind: 'api-key', refused: 'high', levels: ['low'], now: () => 100 })
    check('recordWireEffortRefusal refuses to overwrite corrupt file', wireOnCorrupt === undefined && readFileSync(file, 'utf8') === '{broken json')

    if (POSIX_MODES) {
      const valid = JSON.stringify({ version: 1, receipts: [] }) + '\n'
      writeFileSync(file, valid, { mode: 0o600 })
      chmodSync(file, 0o200)
      let eaccesErr: unknown
      try {
        q.readQualificationReceipts()
      } catch (error) {
        eaccesErr = error
      }
      const writeOnUnreadable = q.recordLiveQualification({ modelId: 'gpt-5', role: 'primary', sourceKind: 'api-key', now: () => 100 })
      chmodSync(file, 0o600)
      check('unreadable file throws EACCES on readQualificationReceipts', (eaccesErr as NodeJS.ErrnoException | undefined)?.code === 'EACCES', String(eaccesErr))
      check('recordLiveQualification leaves unreadable file untouched', writeOnUnreadable === undefined && readFileSync(file, 'utf8') === valid)
    }
  })
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
