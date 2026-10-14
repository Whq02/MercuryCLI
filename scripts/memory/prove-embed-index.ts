#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = realpathSync(join(import.meta.dir, '..', '..'))
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'embed-index-')))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.chdir(ROOT)

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
  if (!cond) failures++
}
const finish = (): never => {
  rmSync(SCRATCH, { recursive: true, force: true })
  console.log(failures > 0 ? `\nprove-embed-index: RED (${failures})` : '\nprove-embed-index: green')
  process.exit(failures > 0 ? 1 : 0)
}

const { seedEmbedPackDirForTest, embedPackDirFor, EMBED_PACK_MANIFEST_FILE } = await import('../../src/mneme/embedPack.js')
const { seedEmbedModelForTest } = await import('../../src/mneme/embedModels.js')
const { voicePackPlatform } = await import('../../src/services/voice/voicePack.js')
const idx = await import('../../src/mneme/mnemeIndex.js')
const docs = await import('../../src/mneme/mnemeTopicDocs.js')

const PACK_DIR = embedPackDirFor(ROOT, voicePackPlatform())
if (!existsSync(join(PACK_DIR, EMBED_PACK_MANIFEST_FILE))) {
  console.log('prove-embed-index: SKIP (no embed pack on this host — bun run scripts/vendor/build-embed.ts builds it)')
  process.exit(0)
}
seedEmbedPackDirForTest(PACK_DIR)
seedEmbedModelForTest(null)

const dir = join(SCRATCH, 'library')
const writeLibrary = (): void => {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const a = docs.emptyDoc('clock', 'clock facts', '2026-10-13T09:00:00.000Z')
  a.sections.push({ heading: 'notes', entries: [
    { text: 'the laptop clock drifts every week', seq: 1, time: '2026-10-13T10:00:00.000Z', source: 's:a' },
    { text: 'the notebook time zone was set wrong', seq: 2, time: '2026-10-13T11:00:00.000Z', source: 's:a' },
  ] })
  const b = docs.emptyDoc('build', 'build facts', '2026-10-13T09:00:00.000Z')
  b.sections.push({ heading: 'notes', entries: [
    { text: 'the build pipeline publishes a tarball', seq: 3, time: '2026-10-13T12:00:00.000Z', source: 's:a' },
  ] })
  writeFileSync(join(dir, 'topic-clock.md'), docs.serializeTopicDoc(a))
  writeFileSync(join(dir, 'topic-build.md'), docs.serializeTopicDoc(b))
}
writeLibrary()

console.log('\n[I] the derived file beside the library')
{
  const out = await idx.rebuildEmbedIndex(dir)
  check('a rebuild embeds every live fact and names its cost', out.built && out.rows === 3 && out.reason.includes('embedded 3'), JSON.stringify(out))
  const file = idx.readEmbedIndex(dir)
  check('the file lives under library/.index/embeddings.json', existsSync(join(dir, '.index', 'embeddings.json')))
  check('the file is stamped with the model and its dimension', file !== null && file.model === 'bge-base-en-v1.5-q8_0' && file.dimension === 768)
  check('every vector is 768 numbers, rounded, one row per live fact key', file!.rows.every(r => /^seq:\d+$/.test(r.key) && Array.isArray(r.v) && r.v.length === 768 && r.v.every(x => typeof x === 'number' && Number.isFinite(x))))
  check('no fact TEXT rides the derived file', !JSON.stringify(file).includes('laptop clock') && !JSON.stringify(file).includes('tarball'))
}

console.log('\n[S] meaning, not words')
{
  const file = idx.readEmbedIndex(dir)!
  const status = idx.embedIndexEngineStatus()
  const hits = idx.searchEmbedIndex('the portable computer time', file, status, 3)
  check('a query with no word in common finds the clock facts first', hits.length === 3 && hits[0]!.key === 'seq:1' && hits[1]!.key === 'seq:2' && hits[2]!.key === 'seq:3', JSON.stringify(hits))
  check('a mismatched engine state answers empty, never a crash', idx.searchEmbedIndex('x', file, { state: 'off', note: 'off' }).length === 0)
}

console.log('\n[R] rebuildable from the markdown, versioned by the model')
{
  const fresh = await idx.ensureEmbedIndex(dir)
  check('a current index is reused, not re-embedded', fresh.reused && !fresh.built)
  const file = idx.readEmbedIndex(dir)!
  const corrupted = { ...file, model: 'bge-small-en-v1.5-q8_0' }
  writeFileSync(idx.indexPath(dir), JSON.stringify(corrupted))
  const stale = idx.embedIndexFreshness(idx.readEmbedIndex(dir), [])
  check('an index built for another model is named stale with both names', !stale.current && stale.reason.includes('bge-small') && stale.reason.includes('bge-base'), stale.reason)
  const rebuilt = await idx.ensureEmbedIndex(dir)
  check('a stale index rebuilds under the serving model', rebuilt.built && idx.readEmbedIndex(dir)!.model === 'bge-base-en-v1.5-q8_0', JSON.stringify(rebuilt))
  const prior = idx.readEmbedIndex(dir)
  const raw = readFileSync(join(dir, 'topic-clock.md'), 'utf8')
  writeFileSync(join(dir, 'topic-clock.md'), raw.replace('- the laptop clock drifts every week', '- the portable computer clock drifts every week'))
  const incremental = await idx.ensureEmbedIndex(dir)
  check('one edited fact re-embeds alone, the rest are kept', incremental.built && incremental.reason.includes('embedded 1') && incremental.reason.includes('kept 2'), JSON.stringify(incremental))
  const after = idx.readEmbedIndex(dir)!
  check('the untouched rows keep their bytes (no re-embedding)', prior!.rows.find(r => r.key === 'seq:3') !== undefined && JSON.stringify(prior!.rows.find(r => r.key === 'seq:3')) === JSON.stringify(after.rows.find(r => r.key === 'seq:3')))
  const hits = idx.searchEmbedIndex('portable computer clock', after, idx.embedIndexEngineStatus(), 1)
  check('the reworded fact is found by its new meaning', hits[0]?.key === 'seq:1', JSON.stringify(hits))
}

console.log('\n[P] a fact is embedded at Retain and its vector moves with it')
{
  writeLibrary()
  await idx.ensureEmbedIndex(dir)
  const pending = { key: 'pending:2026-10-13T13:00:00.000Z', text: 'the desk lamp flickers when the heater starts' }
  const appended = await idx.appendFactToEmbedIndex(dir, pending)
  const withPending = idx.readEmbedIndex(dir)!
  check('a pending fact is appended under its pending key, the rest untouched', appended && withPending.rows.length === 4 && withPending.rows.some(r => r.key === pending.key), JSON.stringify(withPending.rows.map(r => r.key)))
  const found = idx.searchEmbedIndex('the lamp blinks', withPending, idx.embedIndexEngineStatus(), 1)
  check('the pending fact is found by meaning before any consolidation', found[0]?.key === pending.key, JSON.stringify(found))
  const pendingVector = withPending.rows.find(r => r.key === pending.key)!.v
  const moved = await idx.ensureEmbedIndex(dir, [...idx.libraryFacts(dir), { key: 'seq:4', text: pending.text }])
  const after = idx.readEmbedIndex(dir)!
  check('when the fact consolidates to a seq its vector is kept by text digest, not re-embedded', moved.built && moved.reason.includes('embedded 0') === false && moved.reason.startsWith('kept') && JSON.stringify(after.rows.find(r => r.key === 'seq:4')?.v) === JSON.stringify(pendingVector), JSON.stringify(moved))
}

console.log('\n[T] the record stays the one truth')
{
  writeLibrary()
  check('deleting the derived file loses nothing the markdown holds', existsSync(join(dir, 'topic-clock.md')) && !existsSync(join(dir, '.index')))
  const out = await idx.ensureEmbedIndex(dir)
  check('the index rebuilds whole from the markdown alone', out.built && out.rows === 3)
  const bad = JSON.stringify(idx.readEmbedIndex(dir)).replace(`"version":${idx.INDEX_VERSION}`, '"version":9')
  writeFileSync(idx.indexPath(dir), bad)
  check('a corrupt derived file reads as absent, never as data', idx.readEmbedIndex(dir) === null)
  const again = await idx.ensureEmbedIndex(dir)
  check('and rebuilds on the next ensure', again.built && again.rows === 3)
}

console.log('\n[M] the model leaves memory when idle')
{
  idx.resetEmbedIndexForTest({ idleUnloadMs: 150 })
  rmSync(join(dir, '.index'), { recursive: true, force: true })
  await idx.ensureEmbedIndex(dir)
  check('the engine is loaded right after a build', idx.embedIndexEngineLoaded())
  await new Promise(r => setTimeout(r, 400))
  check('and unloaded after the idle period', !idx.embedIndexEngineLoaded())
  const again = idx.searchEmbedIndex('tarball', idx.readEmbedIndex(dir)!, idx.embedIndexEngineStatus(), 1)
  check('a later query reloads it on demand', again[0]?.key === 'seq:3' && idx.embedIndexEngineLoaded(), JSON.stringify(again))
  idx.resetEmbedIndexForTest()
}

console.log('\n[D] the degrade is honest')
{
  seedEmbedPackDirForTest(join(SCRATCH, 'no-such-pack'))
  idx.resetEmbedIndexForTest()
  const off = idx.embedIndexEngineStatus()
  check('without the pack the engine answers off with a note', off.state === 'off' && off.note.length > 0)
  const out = await idx.rebuildEmbedIndex(dir)
  check('a rebuild refuses rather than writing an empty index', !out.built && out.rows === 0 && out.reason.length > 0)
  seedEmbedPackDirForTest(PACK_DIR)
  seedEmbedModelForTest(null)
  idx.resetEmbedIndexForTest()
}

finish()
