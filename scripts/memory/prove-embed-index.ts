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

const { seedEmbedPackDirForTest } = await import('../../src/mneme/embedPack.js')
const { seedEmbedModelForTest } = await import('../../src/mneme/embedModels.js')
const idx = await import('../../src/mneme/mnemeIndex.js')
const docs = await import('../../src/mneme/mnemeTopicDocs.js')

const PACK_DIR = join(ROOT, 'vendor', 'embed', 'darwin-arm64')
const packBuilt = existsSync(join(PACK_DIR, '.vendor-manifest.json'))
if (!packBuilt) {
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
  const out = idx.rebuildEmbedIndex(dir)
  check('a rebuild embeds every live fact and names its cost', out.built && out.rows === 3 && out.reason.includes('embedded 3'), JSON.stringify(out))
  const file = idx.readEmbedIndex(dir)
  check('the file lives under library/.index/embeddings.json', existsSync(join(dir, '.index', 'embeddings.json')))
  check('the file is stamped with the model and its dimension', file !== null && file.model === 'bge-base-en-v1.5-q8_0' && file.dimension === 768)
  check('every vector is 768 numbers, rounded, one row per live seq', file!.rows.every(r => r.seq > 0 && Array.isArray(r.v) && r.v.length === 768 && r.v.every(x => typeof x === 'number' && Number.isFinite(x))))
  check('no fact TEXT rides the derived file', !JSON.stringify(file).includes('laptop clock') && !JSON.stringify(file).includes('tarball'))
}

console.log('\n[S] meaning, not words')
{
  const file = idx.readEmbedIndex(dir)!
  const status = idx.embedIndexEngineStatus()
  const hits = idx.searchEmbedIndex('the portable computer time', file, status, 3)
  check('a query with no word in common finds the clock facts first', hits.length === 3 && hits[0]!.seq === 1 && hits[1]!.seq === 2 && hits[2]!.seq === 3, JSON.stringify(hits))
  check('a mismatched engine state answers empty, never a crash', idx.searchEmbedIndex('x', file, { state: 'off', note: 'off' }).length === 0)
}

console.log('\n[R] rebuildable from the markdown, versioned by the model')
{
  const fresh = idx.ensureEmbedIndex(dir)
  check('a current index is reused, not re-embedded', fresh.reused && !fresh.built)
  const file = idx.readEmbedIndex(dir)!
  const corrupted = { ...file, model: 'bge-small-en-v1.5-q8_0' }
  writeFileSync(idx.indexPath(dir), JSON.stringify(corrupted))
  const stale = idx.embedIndexFreshness(idx.readEmbedIndex(dir), [])
  check('an index built for another model is named stale with both names', !stale.current && stale.reason.includes('bge-small') && stale.reason.includes('bge-base'), stale.reason)
  const rebuilt = idx.ensureEmbedIndex(dir)
  check('a stale index rebuilds under the serving model', rebuilt.built && idx.readEmbedIndex(dir)!.model === 'bge-base-en-v1.5-q8_0', JSON.stringify(rebuilt))
  const prior = idx.readEmbedIndex(dir)
  const raw = readFileSync(join(dir, 'topic-clock.md'), 'utf8')
  writeFileSync(join(dir, 'topic-clock.md'), raw.replace('- the laptop clock drifts every week', '- the portable computer clock drifts every week'))
  const incremental = idx.ensureEmbedIndex(dir)
  check('one edited fact re-embeds alone, the rest are kept', incremental.built && incremental.reason.includes('embedded 1') && incremental.reason.includes('kept 2'), JSON.stringify(incremental))
  const after = idx.readEmbedIndex(dir)!
  check('the untouched rows keep their bytes (no re-embedding)', prior!.rows.find(r => r.seq === 3) !== undefined && JSON.stringify(prior!.rows.find(r => r.seq === 3)) === JSON.stringify(after.rows.find(r => r.seq === 3)))
  const hits = idx.searchEmbedIndex('portable computer clock', after, idx.embedIndexEngineStatus(), 1)
  check('the reworded fact is found by its new meaning', hits[0]?.seq === 1, JSON.stringify(hits))
}

console.log('\n[T] the record stays the one truth')
{
  writeLibrary()
  check('deleting the derived file loses nothing the markdown holds', existsSync(join(dir, 'topic-clock.md')) && !existsSync(join(dir, '.index')))
  const out = idx.ensureEmbedIndex(dir)
  check('the index rebuilds whole from the markdown alone', out.built && out.rows === 3)
  const bad = JSON.stringify(idx.readEmbedIndex(dir)).replace('"version":1', '"version":9')
  writeFileSync(idx.indexPath(dir), bad)
  check('a corrupt derived file reads as absent, never as data', idx.readEmbedIndex(dir) === null)
  const again = idx.ensureEmbedIndex(dir)
  check('and rebuilds on the next ensure', again.built && again.rows === 3)
}

console.log('\n[D] the degrade is honest')
{
  seedEmbedPackDirForTest(join(SCRATCH, 'no-such-pack'))
  idx.resetEmbedIndexForTest()
  const off = idx.embedIndexEngineStatus()
  check('without the pack the engine answers off with a note', off.state === 'off' && off.note.length > 0)
  const out = idx.rebuildEmbedIndex(dir)
  check('a rebuild refuses rather than writing an empty index', !out.built && out.rows === 0 && out.reason.length > 0)
  seedEmbedPackDirForTest(PACK_DIR)
  seedEmbedModelForTest(null)
  idx.resetEmbedIndexForTest()
}

finish()
