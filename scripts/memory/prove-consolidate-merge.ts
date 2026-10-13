import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const home = mkdtempSync(join(tmpdir(), 'memory-merge-'))
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
const { currentBufferPath } = await import('../../src/mneme/mnemeBuffer.ts')
const { maybeConsolidate, listTopicDocs, listArchiveDocs, validateDraft } = await import('../../src/mneme/mnemeConsolidate.ts')
const { pinFact, unpinFact } = await import('../../src/mneme/mnemeUsage.ts')
const old = 'The service stores encrypted backup records beside the journal and checks every checksum before restoring the saved workspace.'
const newer = `${old} Always.`
const now = new Date('2026-10-13T12:00:00.000Z')
let checks = 0
const check = (name: string, run: () => void) => { run(); checks++; console.log(`PASS ${name}`) }
const seed = (dir: string, text: string, stamp: number, extra = {}) => {
  mkdirSync(dir, { recursive: true })
  appendFileSync(currentBufferPath(dir), JSON.stringify({ text, source: 'proof', ts: new Date(now.getTime() + stamp).toISOString(), ...extra }) + '\n')
}
const rows = (dir: string) => [...listTopicDocs(dir), ...listArchiveDocs(dir)].flatMap(d => d.sections.flatMap(s => s.entries))
const history = (dir: string) => [...listTopicDocs(dir), ...listArchiveDocs(dir)].flatMap(d => d.history)
try {
  check('two pending restatements keep the newer text and the older history verbatim', () => {
    const dir = join(home, 'pending')
    seed(dir, newer, 1, { topicHint: 'backup' })
    seed(dir, old, 0, { topicHint: 'journal' })
    assert(maybeConsolidate({ dir, now, force: true }).consolidated)
    assert.equal(rows(dir).length, 1)
    assert.equal(rows(dir)[0]!.text, newer)
    assert.equal(history(dir)[0]!.text, old)
    assert.equal(history(dir)[0]!.supersededBy, rows(dir)[0]!.seq)
    assert.equal(rows(dir)[0]!.supersedes, String(history(dir)[0]!.seq))
  })
  check('a restatement replaces a library fact across topics without composing text', () => {
    const dir = join(home, 'library')
    seed(dir, old, 0, { topicHint: 'backup' })
    assert(maybeConsolidate({ dir, now, force: true }).consolidated)
    seed(dir, newer, 1, { topicHint: 'journal' })
    assert(maybeConsolidate({ dir, now, force: true }).consolidated)
    assert.equal(rows(dir).length, 1)
    assert.equal(rows(dir)[0]!.text, newer)
    assert.equal(history(dir)[0]!.text, old)
  })
  check('pinned and user-asked pending rows cannot be merged away', () => {
    for (const extra of [{ pin: true }, { asked: true }]) {
      const dir = join(home, extra.pin ? 'pin-pending' : 'asked-pending')
      seed(dir, old, 0, extra)
      seed(dir, newer, 1)
      assert(maybeConsolidate({ dir, now, force: true }).consolidated)
      assert.equal(rows(dir).length, 2)
      assert.equal(history(dir).length, 0)
    }
    const verdict = validateDraft({ blocks: [{ topicSlug: 'general', entries: [{ seq: 2, text: newer, time: now.toISOString(), source: 'proof', supersedes: '1' }] }] }, { rows: [{ seq: 1, text: old, ts: now.toISOString(), source: 'proof', pin: true }, { seq: 2, text: newer, ts: now.toISOString(), source: 'proof' }], libraryLiveSeqs: new Set() })
    assert.equal(verdict.ok, false)
  })
  check('a pinned library rule stays current; unpin and restate then keeps one current', () => {
    const dir = join(home, 'pin-library')
    seed(dir, old, 0)
    assert(maybeConsolidate({ dir, now, force: true }).consolidated)
    pinFact(1, dir, now, { asked: true })
    seed(dir, newer, 1)
    assert(maybeConsolidate({ dir, now, force: true }).consolidated)
    assert(rows(dir).some(e => e.seq === 1 && e.text === old))
    unpinFact(1, dir)
    seed(dir, newer, 2)
    assert(maybeConsolidate({ dir, now, force: true }).consolidated)
    assert.equal(rows(dir).length, 1)
    assert.equal(history(dir).length, 2)
  })
  check('negation and numeric changes stay separate despite shared words', () => {
    for (const changed of [old.replace('stores', 'never stores'), old.replace('every checksum', 'every checksum 2')]) {
      const dir = mkdtempSync(join(home, 'different-'))
      seed(dir, old, 0)
      seed(dir, changed, 1)
      assert(maybeConsolidate({ dir, now, force: true }).consolidated)
      assert.equal(rows(dir).length, 2)
      assert.equal(history(dir).length, 0)
    }
  })
  const { shingleSimilarity, CONSOLIDATE_SIMILARITY_THRESHOLD } = await import('../../src/mneme/mnemeSimilarity.ts')
  check('the edge is inclusive at four shared shingles out of five', () => {
    const a = 'amber birch cedar dogwood elm fir'
    const b = `${a} ginkgo`
    assert.equal(shingleSimilarity(a, b), 0.8)
    assert.equal(CONSOLIDATE_SIMILARITY_THRESHOLD, 0.8)
    assert(shingleSimilarity(a, `${b} hazel`) < CONSOLIDATE_SIMILARITY_THRESHOLD)
    const dir = join(home, 'edge')
    seed(dir, a, 0)
    seed(dir, b, 1)
    assert(maybeConsolidate({ dir, now, force: true }).consolidated)
    assert.equal(rows(dir).length, 1)
  })
  console.log(`consolidate merge: ${checks} checks passed`)
} finally {
  rmSync(home, { recursive: true, force: true })
}
