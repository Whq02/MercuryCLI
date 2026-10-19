import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'recall-surface-'))
process.env.MERCURY_CONFIG_DIR = home
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
try {
  const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.js')
  const { usagePath } = await import('../../src/mneme/mnemeUsage.js')
  const { automaticMemoryCandidates, lookupFacts } = await import('../../src/mneme/mnemeLookup.js')
  const { memoryGrade } = await import('../../src/mneme/memoryEvidence.js')
  const dir = mnemeLibraryDir()
  mkdirSync(dir, { recursive: true })
  const text = [
    '---', 'id: topic-surfacing', 'summary: Release fixtures', 'token_count: 20', 'created: 2026-10-13T00:00:00.000Z', 'updated: 2026-10-13T00:00:00.000Z', 'update_log:', '---', '## notes',
    '- The service deployed after a smoke check. <seq=1, time=2026-10-12T00:00:00.000Z, source=proof>',
    '- The browser bundles assets separately. <seq=2, time=2026-10-12T00:00:00.000Z, source=proof>',
  ].join('\n') + '\n'
  const page = join(dir, 'topic-surfacing.md')
  writeFileSync(page, text)
  const usage = JSON.stringify({ version: 1, rows: { '1': { last: '2026-10-01T00:00:00.000Z', count: 4 } } })
  writeFileSync(usagePath(dir), usage)
  const candidates = automaticMemoryCandidates('deploying service', { dir })
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0]?.id, 'seq:1')
  assert.match(memoryGrade({ id: 'seq:1', dir }), /^\[fact · cited (?:\d+|unknown) · unverified\]$/)
  assert.equal(lookupFacts('deploying service', { dir })[0]?.id, 'seq:1')
  assert.equal(readFileSync(usagePath(dir), 'utf8'), usage)
  assert.equal(readFileSync(page, 'utf8'), text)
  console.log('PASS: lookup carries the graded fact and never counts a listing as an open')
} finally {
  rmSync(home, { recursive: true, force: true })
}
