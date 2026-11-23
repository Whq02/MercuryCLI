import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'long-fact-pointer-'))
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
try {
  const { searchPointers } = await import('../../src/sessions/mneme/mnemePointers.ts')
  const { recallQuery } = await import('../../src/sessions/mneme/memoryVerbs.ts')
  const text = 'Longneedle ' + 'durable detail '.repeat(40)
  writeFileSync(join(home, 'topic-long.md'), `---\nid: topic-long\nsummary: long facts\n---\n## notes\n- ${text} <seq=41, time=2026-10-11T00:00:00.000Z, source=proof>\n`)
  const result = searchPointers('Longneedle', { dir: home, sessions: [] })
  assert.equal(result.pointers[0]?.id, 'seq:41', 'a fact longer than 240 characters retains its signed seq pointer; fix searchPointers in src/sessions/mneme/mnemePointers.ts so the seq id is parsed before the text is cut')
  assert.equal(result.elidable, false, 'a long fact with a signed seq pointer must not be elidable; fix searchPointers in src/sessions/mneme/mnemePointers.ts')
  const hit = recallQuery('Longneedle', { dir: home }).hits[0]
  assert.equal(hit?.id, 'seq:41', 'recallQuery must return the signed seq id of a long fact; fix recallQuery in src/sessions/mneme/memoryVerbs.ts')
  assert.ok(hit!.preview.length < text.length, 'display stays bounded after identity is parsed; fix the preview cut in recallQuery, src/sessions/mneme/memoryVerbs.ts')
  console.log('LONG FACT POINTER GREEN')
} finally {
  rmSync(home, { recursive: true, force: true })
}
