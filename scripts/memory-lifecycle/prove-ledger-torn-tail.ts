import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'ledger-torn-tail-'))
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
try {
  const { openEntry, readLedgerFile } = await import('../../src/mneme/ledger.ts')
  const { lineagePath } = await import('../../src/mneme/paths.ts')
  const key = 'torn-tail'
  openEntry(key, { sessionId: 'first', model: 'fixture' })
  appendFileSync(lineagePath(key), '{"ordinal":2,"sessionId":"unfinished')
  const damaged = readFileSync(lineagePath(key), 'utf8')
  openEntry(key, { sessionId: 'next', model: 'fixture' })
  const read = readLedgerFile(key)
  assert.equal(read.skipped, 1)
  assert.equal(read.entries.find(entry => entry.sessionId === 'next')?.ordinal, 2, 'an unterminated tail cannot swallow the next entry')
  assert.ok(readFileSync(lineagePath(key), 'utf8').startsWith(damaged + '\n'), 'damaged bytes stay in place')
  console.log('LEDGER TORN TAIL GREEN')
} finally {
  rmSync(home, { recursive: true, force: true })
}
