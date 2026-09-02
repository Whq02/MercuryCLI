#!/usr/bin/env bun
// prove-topic-memory-discoverability — a recorded observation is
// findable IMMEDIATELY through the normal front door, in an EMPTY library,
// honestly labeled; pending (consuming-*) rows are visible; the
// current→consolidated transition never double-reports.
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_MNEME = '1'

import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { appendObservation, pendingRows, recentObservations } = await import('../../src/memdir/mnemeBuffer.ts')
const { maybeConsolidate } = await import('../../src/memdir/mnemeConsolidate.ts')
const { catalogDocs, grepAll, grepLibrary, grepPending, pendingSummary, PENDING_SLUG, readDocLines } = await import(
  '../../src/memdir/mnemeRetrieval.ts'
)

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

section('§1 empty library: observe → immediately findable, honestly labeled')
{
  const dir = mkdtempSync(join(tmpdir(), 'mneme-disc1-'))
  appendObservation({ text: 'the API rate limit is 600 requests per minute', source: 'ops decision', topicHint: 'rate-limits' }, dir)
  check('catalog has zero DOCS (nothing consolidated)', catalogDocs(dir).length === 0)
  const summary = pendingSummary(dir)
  check('pendingSummary reports the recorded row', summary?.count === 1 && summary.topics.includes('rate-limits'), JSON.stringify(summary))
  const hits = grepAll('rate.?limit', { dir })
  check('grepAll finds it pre-consolidation', hits.length === 1, JSON.stringify(hits))
  check("hit carries the '(recent)' slug + unconsolidated label", hits[0]?.slug === PENDING_SLUG && / \[unconsolidated, .+, ops decision\]$/.test(hits[0]?.text ?? ''), hits[0]?.text)
  check('grepLibrary alone still doc-only (composition is deliberate)', grepLibrary('rate.?limit', { dir }).length === 0)
}

section('§2 current→consolidated transition: no double report')
{
  const dir = mkdtempSync(join(tmpdir(), 'mneme-disc2-'))
  appendObservation({ text: 'primary region is fra', source: 'operator', topicHint: 'deploy' }, dir)
  const r = maybeConsolidate({ force: true, dir })
  check('consolidated', r.consolidated, r.reason)
  const afterDoc = grepAll('primary region', { dir })
  check('exactly one hit after consolidation (doc)', afterDoc.length === 1 && afterDoc[0]!.slug === 'deploy', JSON.stringify(afterDoc))
  // Same text re-observed while the doc holds it: doc hit wins, pending copy suppressed.
  appendObservation({ text: 'primary region is fra', source: 'operator', topicHint: 'deploy' }, dir)
  const both = grepAll('primary region', { dir })
  check('re-observed identical text is NOT double-reported', both.length === 1 && both[0]!.slug === 'deploy', JSON.stringify(both))
  // A DIFFERENT new observation appears alongside doc hits.
  appendObservation({ text: 'primary region failover is ams', source: 'operator', topicHint: 'deploy' }, dir)
  const mixed = grepAll('primary region', { dir })
  check('new fact appears beside doc hits, labeled', mixed.length === 2 && mixed.some(h => h.slug === PENDING_SLUG), JSON.stringify(mixed))
}

section('§3 crash-stranded consuming-* rows stay visible')
{
  const dir = mkdtempSync(join(tmpdir(), 'mneme-disc3-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'consuming-4242-dead.jsonl'),
    JSON.stringify({ ts: '2026-07-18T00:00:00Z', source: 'crashed-run', text: 'stranded fact about quotas', topicHint: 'quotas' }) + '\n',
  )
  appendObservation({ text: 'fresh fact about quotas', source: 'session', topicHint: 'quotas' }, dir)
  check('pendingRows sees consuming + current (older first)', pendingRows(dir).length === 2 && pendingRows(dir)[0]!.source === 'crashed-run')
  check('recentObservations folds stranded rows', recentObservations(5, dir).some(r => r.text.includes('stranded')))
  check('grepPending finds the stranded row', grepPending('stranded', { dir }).length === 1)
  const s = pendingSummary(dir)
  check('pendingSummary counts both', s?.count === 2, JSON.stringify(s))
}

section('§4 read fold + OFF contract')
{
  const dir = mkdtempSync(join(tmpdir(), 'mneme-disc4-'))
  appendObservation({ text: 'alpha', source: 's', topicHint: 'topic-a' }, dir)
  maybeConsolidate({ force: true, dir })
  appendObservation({ text: 'beta just recorded', source: 's', topicHint: 'topic-a' }, dir)
  const r = readDocLines('topic-a', { dir })
  check('read folds the just-recorded pending row', r !== null && r.recent.some(x => x.text === 'beta just recorded'))
  delete process.env.MERCURY_MNEME
  check('OFF: appendObservation refuses', appendObservation({ text: 'x', source: 'y' }, dir) === false)
  process.env.MERCURY_MNEME = '1'
}

if (failures) {
  console.log(`\n❌ ${failures} discoverability check(s) failed`)
  process.exit(1)
}
console.log('\n✅ ALL MNEME DISCOVERABILITY PROOFS PASS')
