import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'long-fact-pointer-'))
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
try {
  const { searchPointers } = await import('../../src/mneme/mnemePointers.ts')
  const { recallQuery } = await import('../../src/mneme/memoryVerbs.ts')
  const text = 'Longneedle ' + 'durable detail '.repeat(40)
  writeFileSync(join(home, 'topic-long.md'), `---\nid: topic-long\nsummary: long facts\n---\n## notes\n- ${text} <seq=41, time=2026-10-11T00:00:00.000Z, source=proof>\n`)
  const result = searchPointers('Longneedle', { dir: home, sessions: [] })
  assert.equal(result.pointers[0]?.id, 'seq:41', 'a fact longer than 240 characters retains its signed seq pointer')
  assert.equal(result.elidable, false)
  const hit = recallQuery('Longneedle', { dir: home }).hits[0]
  assert.equal(hit?.id, 'seq:41')
  assert.ok(hit!.preview.length < text.length, 'display stays bounded after identity is parsed')
  console.log('LONG FACT POINTER GREEN')
} finally {
  rmSync(home, { recursive: true, force: true })
}
