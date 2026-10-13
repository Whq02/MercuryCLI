import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const scratch = mkdtempSync(join(tmpdir(), 'signal-rerank-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
delete process.env.MERCURY_HOME
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const { scoreCandidates, rankAllCandidates, fuseRecallRankings, fuseRankings } = await import('../../src/mneme/mnemeLookup.js')
const { signalRanking, readOrFitSignalWeights, signalWeightsPath, SIGNAL_FEATURE_NAMES, SIGNAL_FIT_STEPS } = await import('../../src/mneme/mnemeRerank.js')
const { fuseSignalRanking } = await import('../../src/mneme/mnemeSignalRanking.js')
const { memorySignalScope, noteMemoryScores, noteMemoryOffered, noteMemoryOpened, finishMemorySignal, readSignalLog, signalLogPath } = await import('../../src/mneme/mnemeSignal.js')

try {
  const now = Date.parse('2026-10-13T00:00:00.000Z')
  const pool = ['quartz alpha', 'quartz bravo', 'amber delta', 'quartz pinned'].map((text, index) => ({ id: `seq:${index + 1}`, seq: index + 1, text, signature: '', slug: 'sample', pagePath: 'sample.md', pending: false, time: '2026-10-12T00:00:00.000Z', pinned: index === 3, useCount: 0 }))
  const scored = scoreCandidates('quartz', pool, now)
  const eligible = scored.filter(hit => hit.features.discriminating)
  const lexical = [...eligible].sort((a, b) => b.score - a.score || (b.seq ?? 0) - (a.seq ?? 0)).map(hit => hit.id)
  const byUse = [...lexical]
  const dir = join(scratch, 'project')
  const baseline = fuseRankings([lexical, byUse])
  assert.equal(signalRanking(scored, dir), null)
  assert.deepEqual(fuseSignalRanking([lexical, byUse], scored, dir, fuseRankings), baseline, 'no log preserves lexical fusion exactly')
  assert(!existsSync(signalWeightsPath(dir)), 'no history needs no weights file')
  async function turn(body: () => Promise<void>): Promise<void> {
    for await (const _ of memorySignalScope((async function* () { await body() })())) {}
  }
  for (let i = 0; i < 32; i++) {
    await turn(async () => {
      noteMemoryScores('quartz', scored, dir)
      noteMemoryOffered('quartz', eligible.map(hit => ({ id: hit.id })), dir)
      noteMemoryOpened(['seq:1', 'seq:2', 'seq:4'], dir)
      await finishMemorySignal('The answer cites seq:1 and seq:4.')
    })
  }
  const log = readSignalLog(dir)
  assert.equal(log.length, 32)
  assert(log.every(row => row.queries[0]!.features['seq:1']!.bm25 > 0))
  assert(log.every(row => !('seq:3' in row.queries[0]!.features)), 'unoffered scores never enter the persisted log')
  const before = readFileSync(signalLogPath(dir), 'utf8')
  const featureless = join(scratch, 'featureless')
  await turn(async () => {
    noteMemoryOffered('quartz', [{ id: 'seq:1' }], featureless)
    noteMemoryOpened(['seq:1'], featureless)
    await finishMemorySignal('seq:1')
  })
  assert.equal(signalRanking(scored, featureless), null, 'a log without features cannot invent a fitted order')
  const started = performance.now()
  const learned = signalRanking(scored, dir)!
  const fitMs = performance.now() - started
  assert.deepEqual(learned, ['seq:1', 'seq:2'], 'cited fact rises; unopened and pinned facts are not learned candidates')
  const fused = fuseSignalRanking([lexical, byUse], scored, dir, fuseRankings)
  assert(fused.includes('seq:1') && fused.includes('seq:2'))
  assert(fused.indexOf('seq:1') < fused.indexOf('seq:2'), 'the signal wins an exact lexical and open-count tie')
  assert.equal(fused.indexOf('seq:4'), baseline.indexOf('seq:4'), 'a pin never changes position')
  assert.deepEqual(new Set(fused), new Set(baseline), 'nothing is hidden or injected')
  const singleFusion = fuseRecallRankings('quartz', pool, lexical, { dir, now })
  assert.deepEqual(singleFusion, fused, 'grep and lexical agreement is fused with the learned list only once')
  assert.deepEqual(fuseRecallRankings('quartz', pool, lexical, { dir: join(scratch, 'cold'), now }), baseline, 'cold Recall keeps grep and lexical fusion')
  const implementation = readFileSync(new URL('../../src/mneme/mnemeLookup.ts', import.meta.url), 'utf8')
  const recallFusionBody = implementation.split('export function fuseRecallRankings(')[1]!.split('export function rankAllCandidates(')[0]!
  assert(!recallFusionBody.includes('rankAllCandidates(') && !recallFusionBody.includes('fuseRankings(['), 'Recall cannot feed an already fused or learned ranking back into fusion')
  assert.equal((recallFusionBody.match(/fuseSignalRanking\(/g) ?? []).length, 1)
  const fit = readOrFitSignalWeights(dir)
  assert.equal(fit.samples, 64, 'pinned examples never train the model')
  assert.deepEqual(fit.features, [...SIGNAL_FEATURE_NAMES])
  assert.equal(SIGNAL_FIT_STEPS, 240)
  assert(fit.weights.every(Number.isFinite))
  assert.equal(fit.weights[3], 0, 'the exempt pinned feature receives no gradient')
  const different = scored.map(hit => hit.id === 'seq:2' ? { ...hit, score: hit.score + 2, features: { ...hit.features, bm25: hit.features.bm25 + 2, useCount: 9 } } : hit)
  const rawThree = fuseRankings([lexical, byUse, signalRanking(different, dir)!])
  let passedLists: string[][] = []
  const unequal = fuseSignalRanking([lexical, byUse], different, dir, rankings => {
    passedLists = rankings.map(ranking => [...ranking])
    return fuseRankings(rankings)
  })
  assert.deepEqual(passedLists.slice(0, 2), [lexical, byUse], 'unequal-score pairs keep their baseline list order')
  assert.deepEqual(passedLists[2], signalRanking(different, dir), 'the learned ranking is the third fusion list')
  assert.deepEqual(unequal.filter(id => id !== 'seq:4'), rawThree.filter(id => id !== 'seq:4'), 'unequal baseline scores fuse without a learned tie override')
  unlinkSync(signalWeightsPath(dir))
  assert.deepEqual(signalRanking(scored, dir), learned)
  assert.deepEqual(readOrFitSignalWeights(dir), fit, 'deleting weights rebuilds the same deterministic model')
  writeFileSync(signalWeightsPath(dir), '{broken')
  assert.deepEqual(readOrFitSignalWeights(dir), fit, 'corrupt cache also rebuilds')
  const exact = scoreCandidates('bravo', pool, now).filter(hit => hit.features.discriminating)
  assert.deepEqual(fuseSignalRanking([exact.map(hit => hit.id), exact.map(hit => hit.id)], exact, dir, fuseRankings), ['seq:2'], 'an exact query still finds the never-cited fact')
  assert.equal(readFileSync(signalLogPath(dir), 'utf8'), before, 'ranking never rewrites the log or a fact')
  const noHistory = join(scratch, 'unrelated-project')
  assert.equal(signalRanking(scored, noHistory), null, 'no signals cross project boundaries')
  assert.deepEqual(rankAllCandidates('quartz', pool, { now, dir }).map(hit => hit.id), fused, 'the production ranking path uses the learned fusion before any result limit')
  const { retainItems, recallQuery, readMemoryRecord } = await import('../../src/mneme/memoryVerbs.js')
  const { maybeConsolidate } = await import('../../src/mneme/mnemeConsolidate.js')
  const { searchPointers } = await import('../../src/mneme/mnemePointers.js')
  const live = join(scratch, 'live-recall')
  retainItems([{ content: 'quartzalpha shared amber', topic: 'signals' }, { content: 'quartzalpha shared cobalt', topic: 'signals' }], { session: 'fixture' }, live)
  maybeConsolidate({ dir: live, force: true })
  const coldRecall = recallQuery('quartzalpha', { dir: live }).hits.map(hit => hit.id)
  assert.deepEqual(coldRecall, ['seq:1', 'seq:2'])
  for (let i = 0; i < 24; i++) {
    await turn(async () => {
      searchPointers('quartzalpha', { dir: live, sessions: [] })
      readMemoryRecord('seq:1', live, { sessions: [] })
      readMemoryRecord('seq:2', live, { sessions: [] })
      await finishMemorySignal('Answer from seq:2.')
    })
  }
  assert.equal(recallQuery('quartzalpha', { dir: live, limit: 1 }).hits[0]!.id, 'seq:2', 'real grep hits learn before the final limit, not just fallback hits')
  assert.equal(recallQuery('amber', { dir: live }).hits[0]!.id, 'seq:1', 'the uncited fact is still found by its exact term')
  assert(readSignalLog(live).every(row => row.queries[0]!.features['seq:2']!.bm25 > 0), 'actual pointers, opens and citations train with actual scores')
  const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.js')
  writeFileSync(join(process.env.MERCURY_CONFIG_DIR!, 'settings.json'), JSON.stringify({ memory: { enabled: false } }))
  resetSettingsCache()
  unlinkSync(signalWeightsPath(dir))
  assert.equal(signalRanking(scored, dir), null, 'memory off never fits')
  assert(!existsSync(signalWeightsPath(dir)), 'memory off writes no derived weights')
  console.log(`PASS signal rerank: exact lexical tie, cold identity, exact findability, pinned exemption, deterministic rebuild, project isolation; fit=${fitMs.toFixed(2)}ms`)
  console.log(`fixture weights=${JSON.stringify(fit.weights)}`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
process.exit(0)
