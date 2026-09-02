#!/usr/bin/env bun
// prove-topic-memory-correction — first-class corrections. The target
// must be current; the replacement carries its own cues + an explicit link;
// the original survives as history; concurrent corrections resolve
// deterministically; unknown/superseded targets return typed results;
// operator/model/maintenance share this one owner.
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_MNEME = '1'

import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { appendObservation } = await import('../../src/memdir/mnemeBuffer.ts')
const { maybeConsolidate, listTopicDocs, readLibraryMeta } = await import('../../src/memdir/mnemeConsolidate.ts')
const { correctFact, retireFact } = await import('../../src/memdir/mnemeCorrect.ts')
const { grepAll } = await import('../../src/memdir/mnemeRetrieval.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

function seed(dir: string): number {
  appendObservation({ text: 'deploy target is Fly.io fra', source: 'operator', topicHint: 'deploy' }, dir)
  appendObservation({ text: 'release cadence is monthly', source: 'operator', topicHint: 'releases' }, dir)
  const r = maybeConsolidate({ force: true, dir })
  if (!r.consolidated) throw new Error(`seed failed: ${r.reason}`)
  const doc = listTopicDocs(dir).find(d => d.slug === 'deploy')!
  return doc.sections[0]!.entries.find(e => e.text.includes('Fly.io'))!.seq
}

section('§1 happy correction: supersede, retain history, lineage, recall truth')
{
  const dir = mkdtempSync(join(tmpdir(), 'mneme-corr1-'))
  const target = seed(dir)
  const r = correctFact({ targetSeq: target, text: 'deploy target is Railway eu-west', source: 'operator', dir })
  check('correction succeeds', r.ok === true && r.action === 'corrected', JSON.stringify(r))
  const doc = listTopicDocs(dir).find(d => d.slug === 'deploy')!
  const live = doc.sections.flatMap(s => s.entries)
  check('corrected fact is CURRENT', live.some(e => e.text.includes('Railway') && e.supersedes === String(target)))
  check('old fact NOT current', !live.some(e => e.text.includes('Fly.io')))
  const hist = doc.history.find(e => e.seq === target)
  check('old fact retained as history with lineage', !!hist && hist.text.includes('Fly.io') && hist.supersededBy === (r.ok ? r.seq : -1))
  check('counter advanced (counter-first law)', readLibraryMeta(dir).seqCounter === (r.ok ? r.seq : -1))
  const hits = grepAll('deploy target', { dir })
  check('recall returns ONLY the corrected value as live text', hits.some(h => h.text.includes('Railway')) && !hits.some(h => h.text.includes('Fly.io') && !/superseded-by/.test(h.text)), JSON.stringify(hits))
  check('updateLog names the correction', doc.updateLog.some(l => l.includes(`corrected seq ${target}`)))
}

section('§2 typed refusals: already-superseded, unknown, invalid, off')
{
  const dir = mkdtempSync(join(tmpdir(), 'mneme-corr2-'))
  const target = seed(dir)
  const first = correctFact({ targetSeq: target, text: 'deploy target is Railway eu-west', source: 'operator', dir })
  check('first correction ok', first.ok === true)
  const second = correctFact({ targetSeq: target, text: 'deploy target is Render', source: 'operator', dir })
  check('second correction of the SAME target → already-superseded (deterministic loser)', second.ok === false && second.code === 'already-superseded' && second.supersededBy === (first.ok ? first.seq : -1), JSON.stringify(second))
  const unknown = correctFact({ targetSeq: 99_999, text: 'x', source: 's', dir })
  check('unknown target → typed unknown-target', unknown.ok === false && unknown.code === 'unknown-target')
  const bad = correctFact({ targetSeq: 0, text: 'x', source: 's', dir })
  check('non-positive seq → invalid', bad.ok === false && bad.code === 'invalid')
  const empty = correctFact({ targetSeq: 1, text: '  ', source: 's', dir })
  check('empty text → invalid', empty.ok === false && empty.code === 'invalid')
  delete process.env.MERCURY_MNEME
  const off = correctFact({ targetSeq: 1, text: 'x', source: 's', dir })
  check('OFF → typed off', off.ok === false && off.code === 'off')
  process.env.MERCURY_MNEME = '1'
}

section('§3 lock honesty: busy while held; correcting the CORRECTION works')
{
  const dir = mkdtempSync(join(tmpdir(), 'mneme-corr3-'))
  const target = seed(dir)
  mkdirSync(join(dir, '.consolidate.lock'))
  const busy = correctFact({ targetSeq: target, text: 'x', source: 's', dir })
  check('held lock → typed busy (fresh foreign lock is respected)', busy.ok === false && busy.code === 'busy', JSON.stringify(busy))
  const { rmSync } = await import('node:fs')
  rmSync(join(dir, '.consolidate.lock'), { recursive: true, force: true })
  const first = correctFact({ targetSeq: target, text: 'deploy target is Railway', source: 'operator', dir })
  check('correction after release ok', first.ok === true)
  const chain = correctFact({ targetSeq: first.ok ? first.seq : -1, text: 'deploy target is Railway eu-west-2', source: 'operator', dir })
  check('correcting the correction chains cleanly', chain.ok === true)
  const doc = listTopicDocs(dir).find(d => d.slug === 'deploy')!
  check('chain: exactly one live deploy-target fact', doc.sections.flatMap(s => s.entries).filter(e => e.text.includes('deploy target')).length === 1)
  check('chain: two history generations', doc.history.filter(e => e.text.includes('deploy target') || e.text.includes('Fly.io')).length === 2)
}

section('§4 retire: nothing stays live; the act is inspectable')
{
  const dir = mkdtempSync(join(tmpdir(), 'mneme-corr4-'))
  const target = seed(dir)
  const r = retireFact({ targetSeq: target, reason: 'platform decommissioned', source: 'operator', dir })
  check('retire succeeds', r.ok === true && r.action === 'retired', JSON.stringify(r))
  const doc = listTopicDocs(dir).find(d => d.slug === 'deploy')!
  check('target no longer live', !doc.sections.flatMap(s => s.entries).some(e => e.seq === target))
  check('target in history with lineage', doc.history.some(e => e.seq === target && e.supersededBy === (r.ok ? r.seq : -1)))
  check('tombstone in history names the reason', doc.history.some(e => e.seq === (r.ok ? r.seq : -1) && e.text.includes('platform decommissioned')))
  check('tombstone NOT live', !doc.sections.flatMap(s => s.entries).some(e => e.seq === (r.ok ? r.seq : -1)))
  const again = retireFact({ targetSeq: target, reason: 'again', source: 'operator', dir })
  check('re-retiring → already-superseded', again.ok === false && again.code === 'already-superseded')
  // The raw file round-trips (single-line signature grammar held)
  const raw = readFileSync(join(dir, 'topic-deploy.md'), 'utf8')
  check('history section serialized with supersedes link', /## history/.test(raw) && raw.includes(`supersedes=${target}`))
}

if (failures) {
  console.log(`\n❌ ${failures} correction check(s) failed`)
  process.exit(1)
}
console.log('\n✅ ALL MNEME CORRECTION PROOFS PASS')
