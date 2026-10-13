import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const home = mkdtempSync(join(tmpdir(), 'fact-restore-'))
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
const { factMemoryState } = await import('../../src/mneme/memoryRefs.ts')
const { readMemoryRecord, retainItems, _resetMemoryVerbSessionStateForTesting } = await import('../../src/mneme/memoryVerbs.ts')
const { writeDoc, listTopicDocs, listArchiveDocs, writeLibraryMeta } = await import('../../src/mneme/mnemeLibrary.ts')
const { emptyDoc, docFileName } = await import('../../src/mneme/mnemeTopicDocs.ts')
const { maybeConsolidate } = await import('../../src/mneme/mnemeConsolidate.ts')
const { readUsage } = await import('../../src/mneme/mnemeUsage.ts')
const footnotes = await import('../../src/mneme/mnemeFootnotes.ts')
const old = new Date(Date.now() - 120 * 86400000).toISOString()
const text = 'The service stores encrypted backups beside the journal and checks every checksum before restoring the workspace.'
const seed = (dir: string, archive = false) => {
  const doc = emptyDoc('backup', 'backup facts', old)
  if (archive) doc.id = 'archive-backup'
  const entry = { seq: 1, time: old, source: 'proof', text }
  doc.sections = [{ heading: 'notes', entries: [entry] }]
  writeDoc(doc, dir)
  writeLibraryMeta({ version: 1, seqCounter: 1 }, dir)
  return entry
}
try {
  const dir = join(home, 'citation')
  const entry = seed(dir)
  const path = join(dir, docFileName('backup'))
  const bytes = readFileSync(path, 'utf8')
  assert.equal(factMemoryState(entry, { libraryDir: dir }).status, 'stale')
  assert.equal(typeof footnotes.confirmCitedFacts, 'function', 'citations have a real confirmation road')
  const now = new Date()
  assert.deepEqual(footnotes.confirmCitedFacts('The checksum is checked [seq 1]. Again [seq:1]. Unknown [seq 999].', dir, now), [1])
  assert.equal(factMemoryState(entry, { libraryDir: dir, now }).confidence, 1)
  assert.equal(readUsage(dir)['1']?.count, 0)
  assert.equal(readFileSync(path, 'utf8'), bytes)
  assert.deepEqual(footnotes.confirmCitedFacts('A line says seq 1 without a citation.', dir), [])
  const openedDir = join(home, 'opened')
  const opened = seed(openedDir)
  assert(readMemoryRecord('seq:1', openedDir, { sessions: [] }).found)
  assert.equal(readUsage(openedDir)['1']?.count, 1)
  assert.equal(factMemoryState(opened, { libraryDir: openedDir }).status, 'current')
  const pageDir = join(home, 'page')
  const page = seed(pageDir)
  assert(readMemoryRecord('doc:backup', pageDir, { sessions: [] }).found)
  assert.equal(factMemoryState(page, { libraryDir: pageDir }).status, 'current')
  for (const archived of [false, true]) {
    const retainedDir = join(home, archived ? 'archived' : 'retained')
    seed(retainedDir, archived)
    _resetMemoryVerbSessionStateForTesting()
    assert.equal(retainItems([{ content: text, topic: 'backup' }], { session: 'confirmation' }, retainedDir)[0]?.status, 'stored')
    assert(maybeConsolidate({ dir: retainedDir, force: true }).consolidated)
    const docs = [...listTopicDocs(retainedDir), ...listArchiveDocs(retainedDir)]
    const live = docs.flatMap(d => d.sections.flatMap(s => s.entries))
    assert.equal(live.length, 1)
    assert.equal(live[0]!.text, text)
    assert.equal(live[0]!.supersedes, '1')
    assert.equal(factMemoryState(live[0]!, { libraryDir: retainedDir }).status, 'current')
    assert(docs.flatMap(d => d.history).some(e => e.seq === 1 && e.text === text))
    assert.equal(retainItems([{ content: text, topic: 'backup' }], { session: 'confirmation' }, retainedDir)[0]?.status, 'stored')
    assert.equal(retainItems([{ content: text, topic: 'backup' }], { session: 'confirmation' }, retainedDir)[0]?.status, 'already-staged')
    assert(maybeConsolidate({ dir: retainedDir, force: true }).consolidated)
    const repeated = [...listTopicDocs(retainedDir), ...listArchiveDocs(retainedDir)]
    assert.equal(repeated.flatMap(d => d.sections.flatMap(s => s.entries)).length, 1)
    assert.equal(repeated.flatMap(d => d.history).length, 2)
  }
  console.log('PASS citation, fact open, page open and repeat retain restore confidence without changing text or counting citations as opens')
} finally {
  rmSync(home, { recursive: true, force: true })
}
