#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { appendObservation, pendingRows, recentObservations } = await import('../../src/sessions/mneme/mnemeBuffer.ts')
const { maybeConsolidate } = await import('../../src/sessions/mneme/mnemeConsolidate.ts')
const { catalogDocs, grepAll, grepLibrary, grepPending, pendingSummary, PENDING_SLUG, readDocLines } = await import(
  '../../src/sessions/mneme/mnemeRetrieval.ts'
)

let failures = 0
const check = (label: string, cond: boolean, detail = '', hint = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && (detail || hint) ? ' — ' + (hint ? hint + (detail ? ' | ' : '') : '') + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

section('§1 empty library: observe → immediately findable, honestly labeled')
{
  const dir = mkdtempSync(join(tmpdir(), 'mneme-disc1-'))
  appendObservation({ text: 'the API rate limit is 600 requests per minute', source: 'ops decision', topicHint: 'rate-limits' }, dir)
  check('catalog has zero DOCS (nothing consolidated)', catalogDocs(dir).length === 0, '', 'an observation must not create a doc until consolidated; check catalogDocs in src/sessions/mneme/mnemeRetrieval.ts and appendObservation in src/sessions/mneme/mnemeBuffer.ts')
  const summary = pendingSummary(dir)
  check('pendingSummary reports the recorded row', summary?.count === 1 && summary.topics.includes('rate-limits'), JSON.stringify(summary), 'pendingSummary in src/sessions/mneme/mnemeRetrieval.ts must count the recorded row and list its topicHint')
  const hits = grepAll('rate.?limit', { dir })
  check('grepAll finds it pre-consolidation', hits.length === 1, JSON.stringify(hits), 'grepAll in src/sessions/mneme/mnemeRetrieval.ts must search pending rows as well as docs')
  check("hit carries the '(recent)' slug + unconsolidated label", hits[0]?.slug === PENDING_SLUG && / \[unconsolidated, .+, ops decision\]$/.test(hits[0]?.text ?? ''), hits[0]?.text, 'the pending hit must use the PENDING_SLUG and the unconsolidated label; check grepPending in src/sessions/mneme/mnemeRetrieval.ts')
  check('grepLibrary alone still doc-only (composition is deliberate)', grepLibrary('rate.?limit', { dir }).length === 0, '', 'grepLibrary in src/sessions/mneme/mnemeRetrieval.ts must search docs only; the pending merge belongs in grepAll')
}

section('§2 current→consolidated transition: no double report')
{
  const dir = mkdtempSync(join(tmpdir(), 'mneme-disc2-'))
  appendObservation({ text: 'primary region is fra', source: 'operator', topicHint: 'deploy' }, dir)
  const r = maybeConsolidate({ force: true, dir })
  check('consolidated', r.consolidated, r.reason, 'maybeConsolidate with force in src/sessions/mneme/mnemeConsolidate.ts did not consolidate the pending row; the reason follows')
  const afterDoc = grepAll('primary region', { dir })
  check('exactly one hit after consolidation (doc)', afterDoc.length === 1 && afterDoc[0]!.slug === 'deploy', JSON.stringify(afterDoc), 'after consolidation the fact must be reported once, from its doc; check the pending fold in grepAll in src/sessions/mneme/mnemeRetrieval.ts')
  appendObservation({ text: 'primary region is fra', source: 'operator', topicHint: 'deploy' }, dir)
  const both = grepAll('primary region', { dir })
  check('re-observed identical text is NOT double-reported', both.length === 1 && both[0]!.slug === 'deploy', JSON.stringify(both), 'a pending row whose text already sits in a doc must be dropped from grepAll in src/sessions/mneme/mnemeRetrieval.ts')
  appendObservation({ text: 'primary region failover is ams', source: 'operator', topicHint: 'deploy' }, dir)
  const mixed = grepAll('primary region', { dir })
  check('new fact appears beside doc hits, labeled', mixed.length === 2 && mixed.some(h => h.slug === PENDING_SLUG), JSON.stringify(mixed), 'a new unconsolidated fact must be listed beside the doc hits under PENDING_SLUG; check grepAll in src/sessions/mneme/mnemeRetrieval.ts')
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
  check('pendingRows sees consuming + current (older first)', pendingRows(dir).length === 2 && pendingRows(dir)[0]!.source === 'crashed-run', '', 'pendingRows in src/sessions/mneme/mnemeBuffer.ts must read consuming-*.jsonl files first, then the current file')
  check('recentObservations folds stranded rows', recentObservations(5, dir).some(r => r.text.includes('stranded')), '', 'recentObservations in src/sessions/mneme/mnemeBuffer.ts must include rows stranded in consuming-* files')
  check('grepPending finds the stranded row', grepPending('stranded', { dir }).length === 1, '', 'grepPending in src/sessions/mneme/mnemeRetrieval.ts must search stranded consuming-* rows')
  const s = pendingSummary(dir)
  check('pendingSummary counts both', s?.count === 2, JSON.stringify(s), 'pendingSummary in src/sessions/mneme/mnemeRetrieval.ts must count consuming-* rows plus the current file')
}

section('§4 read fold + OFF contract')
{
  const dir = mkdtempSync(join(tmpdir(), 'mneme-disc4-'))
  appendObservation({ text: 'alpha', source: 's', topicHint: 'topic-a' }, dir)
  maybeConsolidate({ force: true, dir })
  appendObservation({ text: 'beta just recorded', source: 's', topicHint: 'topic-a' }, dir)
  const r = readDocLines('topic-a', { dir })
  check('read folds the just-recorded pending row', r !== null && r.recent.some(x => x.text === 'beta just recorded'), '', 'readDocLines in src/sessions/mneme/mnemeRetrieval.ts must return pending rows for the topic in its recent list')
  process.env.MERCURY_BARE = '1'
  check('OFF: appendObservation refuses', appendObservation({ text: 'x', source: 'y' }, dir) === false, '', 'with MERCURY_BARE=1 appendObservation in src/sessions/mneme/mnemeBuffer.ts must return false and write nothing')
  delete process.env.MERCURY_BARE
  }

if (failures) {
  console.log(`\n❌ ${failures} discoverability check(s) failed`)
  process.exit(1)
}
console.log('\n✅ ALL MEMORY DISCOVERABILITY PROOFS PASS')
