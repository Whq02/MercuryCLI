#!/usr/bin/env bun
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { appendObservation } = await import('../../src/memdir/mnemeBuffer.ts')
const { listTopicDocs, maybeConsolidate } = await import('../../src/memdir/mnemeConsolidate.ts')
const { MAX_DOC_TOKENS, MIN_DOC_TOKENS, computeDocTokens, docFileName, emptyDoc, mergeDocs, pickMergePartner, splitDoc } =
  await import('../../src/memdir/mnemeTopicDocs.ts')
import type { MnemeRewriter } from '../../src/memdir/mnemeConsolidate.ts'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

section('§1 split: an oversized doc divides at section boundaries')
{
  const dir = mkdtempSync(join(tmpdir(), 'mneme-split-'))
  const long = 'x'.repeat(1900)
  for (let i = 0; i < 6; i++) appendObservation({ text: `${long} a${i}`, source: 'proof', topicHint: 'big topic' }, dir)
  const headingA: MnemeRewriter = ({ rows }) => ({
    blocks: [{ topicSlug: 'big-topic', heading: 'part one', entries: rows.map(r => ({ text: r.text, seq: r.seq, time: r.ts, source: r.source })) }],
  })
  check('batch one lands', maybeConsolidate({ force: true, dir, rewriter: headingA }).consolidated)
  for (let i = 0; i < 6; i++) appendObservation({ text: `${long} b${i}`, source: 'proof', topicHint: 'big topic' }, dir)
  const headingB: MnemeRewriter = ({ rows }) => ({
    blocks: [{ topicSlug: 'big-topic', heading: 'part two', entries: rows.map(r => ({ text: r.text, seq: r.seq, time: r.ts, source: r.source })) }],
  })
  const r = maybeConsolidate({ force: true, dir, rewriter: headingB })
  check('batch two triggers the split', r.consolidated && r.docsTouched.includes('big-topic-2'), r.docsTouched.join(','))
  const docs = listTopicDocs(dir)
  const a = docs.find(d => d.slug === 'big-topic')!
  const b = docs.find(d => d.slug === 'big-topic-2')!
  check('both halves exist on disk', existsSync(join(dir, docFileName('big-topic'))) && existsSync(join(dir, docFileName('big-topic-2'))))
  check('both halves under the cap', computeDocTokens(a) <= MAX_DOC_TOKENS && computeDocTokens(b) <= MAX_DOC_TOKENS,
    `${computeDocTokens(a)}/${computeDocTokens(b)}`)
  check('split recorded in update_log', a.updateLog.some(l => l.includes('split')) && b.updateLog.some(l => l.includes('split from')))
  const total = a.sections.reduce((n, s) => n + s.entries.length, 0) + b.sections.reduce((n, s) => n + s.entries.length, 0)
  check('no entry lost across the split', total === 12, `${total}`)
}

section('§1a split: a one-section page (the product\'s own grouping) divides between its entries')
{
  const dir = mkdtempSync(join(tmpdir(), 'mneme-split-one-'))
  const long = 'y'.repeat(1900)
  for (let i = 0; i < 12; i++) appendObservation({ text: `${long} n${i}`, source: 'proof', topicHint: 'project' }, dir)
  const r = maybeConsolidate({ force: true, dir })
  check('the batch lands and the page splits with nothing but the default grouping', r.consolidated && r.docsTouched.includes('project-2'), r.docsTouched.join(','))
  const docs = listTopicDocs(dir)
  const a = docs.find(d => d.slug === 'project')
  const b = docs.find(d => d.slug === 'project-2')
  check('both pages exist and both carry the one heading', !!a && !!b && a.sections.length === 1 && b.sections.length === 1 && a.sections[0]!.heading === b.sections[0]!.heading, `${a?.sections.length}/${b?.sections.length}`)
  check('both pages under the cap', !!a && !!b && computeDocTokens(a) <= MAX_DOC_TOKENS && computeDocTokens(b) <= MAX_DOC_TOKENS, `${a && computeDocTokens(a)}/${b && computeDocTokens(b)}`)
  const seqs = [...(a?.sections[0]!.entries ?? []), ...(b?.sections[0]!.entries ?? [])].map(e => e.seq).sort((x, y) => x - y)
  check('no entry lost or doubled across the split', seqs.join(',') === Array.from({ length: 12 }, (_, i) => i + 1).join(','), seqs.join(','))
  check('the split is in the update log of both pages', !!a && !!b && a.updateLog.some(l => /split: \d+ entries → topic-project-2/.test(l)) && b.updateLog.some(l => l.includes('split from topic-project')))
  const one = emptyDoc('one', 'one entry', '2026-07-06T00:00:00Z')
  one.sections.push({ heading: 'notes', entries: [{ text: 'z'.repeat(MAX_DOC_TOKENS * 4 + 400), seq: 99, time: 't', source: 'proof' }] })
  check('a page with one entry is indivisible', splitDoc(one, '2026-07-06T00:00:00Z') === null)
}

section('§1b second split of the same topic cannot clobber the first split doc')
{
  const mkBig = () => {
    const d = emptyDoc('x', 'sum', '2026-07-06T00:00:00Z')
    d.sections.push(
      { heading: 'a', entries: [{ text: 'y'.repeat(12000), seq: 1, time: 't', source: 's' }] },
      { heading: 'b', entries: [{ text: 'y'.repeat(12000), seq: 2, time: 't', source: 's' }] },
    )
    return d
  }
  const s1 = splitDoc(mkBig(), 'now')
  check('untaken ⇒ split lands on x-2', s1 !== null && s1[1].slug === 'x-2', s1 ? s1[1].slug : 'null')
  const s2 = splitDoc(mkBig(), 'now', new Set(['x-2', 'x-3']))
  check('x-2/x-3 taken ⇒ split lands on x-4 (no clobber)', s2 !== null && s2[1].slug === 'x-4', s2 ? s2[1].slug : 'null')
}

section('§2 merge: an undersized doc joins its summary-Jaccard neighbor')
{
  const dir = mkdtempSync(join(tmpdir(), 'mneme-merge-'))
  appendObservation({ text: 'substantive fact one about the deploy pipeline and its stages', source: 'proof', topicHint: 'deploy pipeline stages' }, dir)
  check('seed doc lands', maybeConsolidate({ force: true, dir }).consolidated)
  appendObservation({ text: 'tiny related fact', source: 'proof', topicHint: 'deploy pipeline extras' }, dir)
  const r = maybeConsolidate({ force: true, dir })
  check('tiny doc merged instead of persisting', r.consolidated && !r.docsTouched.includes('deploy-pipeline-extras'), r.docsTouched.join(','))
  const docs = listTopicDocs(dir)
  check('one doc remains', docs.length === 1, docs.map(d => d.slug).join(','))
  check('merged doc carries both facts', docs[0]!.sections.flatMap(s => s.entries).length === 2)
  check('merge recorded in update_log', docs[0]!.updateLog.some(l => l.includes('merged')))
  check('stale small file removed', !existsSync(join(dir, docFileName('deploy-pipeline-extras'))))
}

section('§3 asymmetry: unrelated small docs and mid-size docs are left alone')
{
  const small = emptyDoc('quantum-chromodynamics', 'colour charge notes', '2026-07-06T00:00:00Z')
  small.sections.push({ heading: 'notes', entries: [{ text: 'gluons', seq: 1, time: '2026-07-06T00:00:00Z', source: 'proof' }] })
  const other = emptyDoc('sourdough-baking', 'hydration ratios', '2026-07-06T00:00:00Z')
  check('no partner across unrelated summaries', pickMergePartner(small, [other]) === null)
  const mid = emptyDoc('mid', 'mid sized doc', '2026-07-06T00:00:00Z')
  mid.sections.push({ heading: 'notes', entries: [{ text: 'y'.repeat(MIN_DOC_TOKENS * 4 + 400), seq: 2, time: 't', source: 'proof' }] })
  check('mid-size doc: no split', splitDoc(mid, '2026-07-06T00:00:00Z') === null)
  check('merge is explicit, never implicit', (() => {
    const before = other.sections.length
    mergeDocs(other, small, '2026-07-06T01:00:00Z')
    return other.sections.length === before + 1 && other.updateLog.some(l => l.includes('merged'))
  })())
}

console.log('\n' + '═'.repeat(76))
if (failures) {
  console.log(`❌ ${failures} MNEME MAINTENANCE PROOF FAILURE(S)`)
  process.exit(1)
}
console.log('✅ ALL MNEME MAINTENANCE PROOFS PASS')
