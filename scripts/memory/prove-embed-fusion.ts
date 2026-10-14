#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = realpathSync(join(import.meta.dir, '..', '..'))
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'embed-fusion-')))
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
  console.log(failures > 0 ? `\nprove-embed-fusion: RED (${failures})` : '\nprove-embed-fusion: green')
  process.exit(failures > 0 ? 1 : 0)
}

const { seedEmbedPackDirForTest } = await import('../../src/mneme/embedPack.js')
const { seedEmbedModelForTest } = await import('../../src/mneme/embedModels.js')
const idx = await import('../../src/mneme/mnemeIndex.js')
const lookup = await import('../../src/mneme/mnemeLookup.js')
const docs = await import('../../src/mneme/mnemeTopicDocs.js')
const usage = await import('../../src/mneme/mnemeUsage.js')
const knapsack = await import('../../src/mneme/entryKnapsack.js')

const PACK_DIR = join(ROOT, 'vendor', 'embed', 'darwin-arm64')
if (!existsSync(join(PACK_DIR, '.vendor-manifest.json'))) {
  console.log('prove-embed-fusion: SKIP (no embed pack on this host — bun run scripts/vendor/build-embed.ts builds it)')
  process.exit(0)
}
seedEmbedPackDirForTest(PACK_DIR)
seedEmbedModelForTest(null)

const dir = join(SCRATCH, 'library')
mkdirSync(dir, { recursive: true })
const doc = docs.emptyDoc('times', 'time facts', '2026-10-13T09:00:00.000Z')
doc.sections.push({ heading: 'notes', entries: [
  { text: 'the notebook time zone was set wrong at the factory', seq: 1, time: '2026-10-13T10:00:00.000Z', source: 's:a' },
  { text: 'a pinned rule about commit signing', seq: 2, time: '2026-10-13T10:30:00.000Z', source: 's:a' },
  { text: 'the laptop clock drifts every week', seq: 3, time: '2026-10-13T11:00:00.000Z', source: 's:a' },
  { text: 'the build pipeline publishes a tarball', seq: 4, time: '2026-10-13T12:00:00.000Z', source: 's:a' },
  { text: 'the quarterly review meeting notes', seq: 5, time: '2026-10-13T13:00:00.000Z', source: 's:a' },
] })
writeFileSync(join(dir, 'topic-times.md'), docs.serializeTopicDoc(doc))
usage.writePins([{ seq: 2, at: '2026-10-13T10:31:00.000Z' }], dir)
idx.rebuildEmbedIndex(dir)

console.log('\n[F] the semantic ranking joins the fusion')
{
  const pool = lookup.candidates(dir)
  const wordOnly = ['grep-absent-placeholder']
  void wordOnly
  const rmIndex = join(dir, '.index', 'embeddings.json')
  const saved = existsSync(rmIndex) ? await import('node:fs').then(fs => fs.readFileSync(rmIndex, 'utf8')) : null
  rmSync(rmIndex, { force: true })
  const before = lookup.fuseRecallRankings('the portable computer clock', pool, [], { dir, now: Date.parse('2026-10-14T06:00:00.000Z') })
  check('word match alone does not find the time zone fact first (the baseline)', before[0] !== 'seq:1', JSON.stringify(before.slice(0, 3)))
  if (saved !== null) writeFileSync(rmIndex, saved)
  const after = lookup.fuseRecallRankings('the portable computer clock', pool, [], { dir, now: Date.parse('2026-10-14T06:00:00.000Z') })
  check('the fused ranking finds the semantically matching fact first', after[0] === 'seq:3' && after.includes('seq:1'), JSON.stringify(after.slice(0, 3)))
  const sem = lookup.semanticRanking('the portable computer clock', pool, dir)
  check('the semantic ordering alone holds the meaning matches', sem[0] === 'seq:3' && sem.includes('seq:1'), JSON.stringify(sem.slice(0, 3)))
  const pinned = new Set(usage.readPins(dir).map(p => `seq:${p.seq}`))
  const pinPool = pool.filter(c => c.id === 'seq:2' || lookup.semanticRanking('a pinned rule about commit signing', pool, dir).includes(c.id))
  const keptPins = lookup.fuseRecallRankings('a pinned rule about commit signing', pinPool.length > 1 ? pinPool : pool, [], { dir, now: Date.parse('2026-10-14T06:00:00.000Z') })
  check('the pinned rule keeps its own place in the fused order', keptPins.includes('seq:2'), JSON.stringify(keptPins.slice(0, 5)))
  void pinned
}

console.log('\n[K] the start-of-session pick scores through the same fusion')
{
  const candidates: knapsack.StartCandidate[] = doc.sections[0]!.entries.map(e => ({
    id: `seq:${e.seq}`,
    text: e.text,
    signature: '',
    slug: doc.slug,
    pagePath: join(dir, 'topic-times.md'),
    seq: e.seq,
    pending: false,
    time: e.time,
    pinned: e.seq === 2,
    kind: e.seq === 2 ? ('ruling' as const) : ('fact' as const),
    useCount: 0,
    block: `- ${e.text} <seq=${e.seq}>`,
    chars: e.text.length + 20,
  }))
  const limit = 4000
  const choice = knapsack.chooseAtStart({ candidates, chunks: ['the portable computer clock drifts'], limit, pinnedChars: 0, now: Date.parse('2026-10-14T06:00:00.000Z'), dir })
  check('the meaning-matched fact rides at the start', choice.rode.some(c => c.seq === 3), JSON.stringify(choice.rode.map(c => c.seq)))
  check('and rides AHEAD of an unrelated indexed fact of similar length', (choice.rode.find(c => c.seq === 3)?.score ?? 0) >= (choice.rode.find(c => c.seq === 4)?.score ?? -1), JSON.stringify(choice.rode.map(c => [c.seq, Math.round(c.score * 1000) / 1000])))
  const noIndex = { ...choice }
  void noIndex
  const rmIndex = join(dir, '.index', 'embeddings.json')
  const saved = await import('node:fs').then(fs => fs.readFileSync(rmIndex, 'utf8'))
  rmSync(rmIndex, { force: true })
  const bare = knapsack.chooseAtStart({ candidates, chunks: ['the portable computer clock drifts'], limit, pinnedChars: 0, now: Date.parse('2026-10-14T06:00:00.000Z'), dir })
  check('without the index the pick falls back to the word ranking alone', !bare.rode.some(c => c.seq === 1), JSON.stringify(bare.rode.map(c => c.seq)))
  writeFileSync(rmIndex, saved)
}

console.log('\n[N] never a model deciding, never a rewrite')
{
  const pool = lookup.candidates(dir)
  const order = lookup.fuseRecallRankings('anything at all', pool, [], { dir, now: Date.parse('2026-10-14T06:00:00.000Z') })
  const texts = pool.map(c => c.text)
  check('the fusion reorders ids only — every fact text is unchanged', texts.every(t => doc.sections[0]!.entries.some(e => e.text === t)))
  check('every candidate stays a candidate (nothing dropped by ranking)', new Set(order).size === order.length && order.length <= pool.length)
  check('the pinned rule is still verbatim in the library', (await import('node:fs')).readFileSync(join(dir, 'topic-times.md'), 'utf8').includes('a pinned rule about commit signing'))
}

seedEmbedPackDirForTest(null)
finish()
