#!/usr/bin/env bun
// prove-topic-memory-lifecycle — the write → consolidate → revise → retrieve loop.
//
//   §1 a multi-topic observation stream consolidates (deterministic rewriter)
//      into ≥2 topic docs; every entry carries a parsable <seq,time,source>
//      signature whose cues EQUAL the originating observation; update_log
//      records the batch; seq is monotonic across consolidations.
//   §2 serialize → parse round-trips losslessly (the signature invariant).
//   §3 fact revision supersedes: the old fact RETAINED under ## history with
//      its original signature + superseded-by stamp; evidence intact.
//   §4 retrieval: catalog routes → grep finds → read expands to the heading
//      block; a just-observed (unconsolidated) fact is visible via recent.
//   §5 OFF ⇒ zero writes (runtime probe): appendObservation false, no dir.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_MNEME = '1'

const { appendObservation, readBuffer } = await import('../../src/memdir/mnemeBuffer.ts')
const { listTopicDocs, maybeConsolidate, readLibraryMeta } = await import('../../src/memdir/mnemeConsolidate.ts')
const { catalogDocs, grepDoc, grepLibrary, readDocLines } = await import('../../src/memdir/mnemeRetrieval.ts')
const { parseTopicDoc, serializeTopicDoc } = await import('../../src/memdir/mnemeTopicDocs.ts')
import type { MnemeRewriter } from '../../src/memdir/mnemeConsolidate.ts'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const dir = mkdtempSync(join(tmpdir(), 'mneme-life-'))

section('§1 multi-topic stream → consolidation (deterministic rewriter)')
{
  appendObservation({ text: 'the build uses bun, not npm', source: 'BUILD-NOTES.md', topicHint: 'build system' }, dir)
  appendObservation({ text: 'dist bundles to a single mjs file', source: 'build output', topicHint: 'build system' }, dir)
  appendObservation({ text: 'the operator prefers warn posture interactively', source: 'operator', topicHint: 'themis posture' }, dir)
  check('3 rows staged', readBuffer(dir).length === 3)
  const r = maybeConsolidate({ force: true, dir })
  check('consolidated', r.consolidated, r.reason)
  check('two topic docs created', r.docsTouched.length === 2, r.docsTouched.join(','))
  const docs = listTopicDocs(dir)
  check('library lists both', docs.length === 2)
  const build = docs.find(d => d.slug === 'build-system')!
  check('build doc has 2 signed entries', build.sections[0]!.entries.length === 2)
  const e1 = build.sections[0]!.entries[0]!
  check('signature seq assigned from the library counter', e1.seq === 1, `seq=${e1.seq}`)
  check('signature source = the captured provenance', e1.source === 'BUILD-NOTES.md')
  check('update_log records the batch', build.updateLog.length === 1 && build.updateLog[0]!.includes('seq'))
  check('CURRENT cleared after consolidation', readBuffer(dir).length === 0)
  check('seq counter persisted', readLibraryMeta(dir).seqCounter === 3)

  appendObservation({ text: 'render-verify at 80 and 120 cols', source: 'MERCURY.md', topicHint: 'build system' }, dir)
  const r2 = maybeConsolidate({ force: true, dir })
  check('second batch consolidates into the SAME doc', r2.consolidated && r2.docsTouched.includes('build-system'))
  const build2 = listTopicDocs(dir).find(d => d.slug === 'build-system')!
  check('seq monotonic ACROSS consolidations', build2.sections[0]!.entries.some(e => e.seq === 4))
}

section('§2 serialize → parse round-trip (the signature invariant)')
{
  const doc = listTopicDocs(dir).find(d => d.slug === 'build-system')!
  const reparsed = parseTopicDoc(serializeTopicDoc(doc))!
  check('round-trip preserves id/summary', reparsed.id === doc.id && reparsed.summary === doc.summary)
  check('round-trip preserves every entry signature', JSON.stringify(reparsed.sections) === JSON.stringify(doc.sections))
  check('round-trip preserves update_log', JSON.stringify(reparsed.updateLog) === JSON.stringify(doc.updateLog))
}

section('§3 fact revision: supersede retains evidence under history')
{
  appendObservation({ text: 'the build uses bun 1.2 specifically', source: 'BUILD-NOTES.md', topicHint: 'build system' }, dir)
  const revising: MnemeRewriter = ({ rows }) => ({
    blocks: [{
      topicSlug: 'build-system',
      heading: 'notes',
      entries: rows.map(r => ({ text: r.text, seq: r.seq, time: r.ts, source: r.source, supersedes: '1' })),
    }],
  })
  const r = maybeConsolidate({ force: true, dir, rewriter: revising })
  check('revision consolidated', r.consolidated, r.reason)
  const doc = listTopicDocs(dir).find(d => d.slug === 'build-system')!
  const live = doc.sections.flatMap(s => s.entries)
  check('old fact no longer live', !live.some(e => e.seq === 1))
  const hist = doc.history.find(e => e.seq === 1)
  check('old fact RETAINED under history', hist !== undefined)
  check('history keeps the ORIGINAL signature', hist?.text === 'the build uses bun, not npm' && hist?.source === 'BUILD-NOTES.md')
  check('history stamped superseded-by', hist?.supersededBy === 5)
  const revised = live.find(e => e.seq === 5)
  check('revision live with supersedes marker', revised?.supersedes === '1')
}

section('§4 retrieval: catalog → grep → heading-expanded read (+ recent fold)')
{
  const cat = catalogDocs(dir)
  check('catalog lists both docs with summaries', cat.length === 2 && cat.every(c => c.summary.length > 0))
  const hits = grepLibrary('render-verify', { dir })
  check('library grep routes to build-system', hits.length >= 1 && hits[0]!.slug === 'build-system')
  const dhits = grepDoc('build-system', 'bun 1.2', { dir })
  check('doc grep finds the revised fact', dhits.length === 1)
  const read = readDocLines('build-system', { from: dhits[0]!.line, to: dhits[0]!.line, dir })!
  check('read expands to the enclosing heading block', read.content.startsWith('## notes'), read.content.split('\n')[0])
  appendObservation({ text: 'fresh unconsolidated fact', source: 'proof', topicHint: 'build system' }, dir)
  const read2 = readDocLines('build-system', { dir })!
  check('just-observed fact visible via recent (no retrievability gap)', read2.recent.some(x => x.text === 'fresh unconsolidated fact'))
}

section('§5 OFF ⇒ zero writes (runtime probe)')
{
  delete process.env.MERCURY_MNEME
  const offDir = join(mkdtempSync(join(tmpdir(), 'mneme-off-')), 'library')
  const wrote = appendObservation({ text: 'should not land', source: 'proof' }, offDir)
  check('appendObservation returns false', wrote === false)
  check('no library dir created', !existsSync(offDir))
  const r = maybeConsolidate({ force: true, dir: offDir })
  check('consolidate refuses while off', !r.consolidated && r.reason === 'mneme off')
  process.env.MERCURY_MNEME = '1'
  check('ON dir still intact (flag flip is live)', readFileSync(join(dir, 'library.json'), 'utf8').includes('seqCounter'))
}

section('§6 hostile content cannot make entries unparsable (signature hygiene)')
{
  const d6 = mkdtempSync(join(tmpdir(), 'mneme-hygiene-'))
  // Newlines in text + `,`/`<`/`>` in source would round-trip into entries
  // the parser can never see — written but unreachable.
  appendObservation({ text: 'line one\nline two, with commas', source: 'agent<x>, weird', topicHint: 'hygiene' }, d6)
  const r = maybeConsolidate({ force: true, dir: d6 })
  check('poisoned batch consolidates', r.consolidated, r.reason)
  const docs = listTopicDocs(d6)
  const live = docs.flatMap(dd => dd.sections.flatMap(s => s.entries))
  check('the observation survives as a LIVE, parsable entry', live.length === 1 && live[0]!.text.includes('line one line two'), JSON.stringify(live))
  check('source signature-safe after sanitize', live.length === 1 && live[0]!.source.length > 0 && !/[,<>]/.test(live[0]!.source), live[0]?.source ?? '')
  const rd = readDocLines(docs[0]!.slug, { from: 1e9, dir: d6 })
  check('readDocLines clamps a hostile from (no hang, sane range)', rd !== null && rd.from >= 1 && rd.to >= rd.from, JSON.stringify(rd ? { from: rd.from, to: rd.to } : null))
}

section('§7 reserved heading renamed · cross-doc supersede completed')
{
  const d7 = mkdtempSync(join(tmpdir(), 'mneme-xdoc-'))
  appendObservation({ text: 'fact alpha v1', source: 'src-a', topicHint: 'alpha' }, d7)
  check('seed consolidates', maybeConsolidate({ force: true, dir: d7 }).consolidated)
  const seedSeq = listTopicDocs(d7)[0]!.sections[0]!.entries[0]!.seq
  appendObservation({ text: 'fact alpha v2, now owned by beta', source: 'src-b', topicHint: 'beta' }, d7)
  // A rewriter that (a) picks the parser's reserved heading and (b) supersedes
  // a seq that lives in ANOTHER doc.
  const xdoc: MnemeRewriter = ({ rows }) => ({
    blocks: [{ topicSlug: 'beta', summary: 'beta facts', heading: 'History', entries: rows.map(row => ({ text: row.text, seq: row.seq, time: row.ts, source: row.source, supersedes: String(seedSeq) })) }],
  })
  const r = maybeConsolidate({ force: true, dir: d7, rewriter: xdoc })
  check('revision consolidates', r.consolidated, r.reason)
  const docs = listTopicDocs(d7)
  const alpha = docs.find(dd => dd.slug === 'alpha')
  const beta = docs.find(dd => dd.slug === 'beta')
  check('reserved heading renamed — the revision stays LIVE', !!beta && beta.sections.some(s => s.heading === 'notes' && s.entries.length === 1), JSON.stringify(beta?.sections.map(s => s.heading) ?? []))
  check(
    'cross-doc target retired into ITS OWN doc history with supersededBy',
    !!alpha && alpha.sections.every(s => s.entries.every(e => e.seq !== seedSeq)) && alpha.history.some(e => e.seq === seedSeq && e.supersededBy !== undefined),
    JSON.stringify(alpha?.history ?? []),
  )
}

console.log('\n' + '═'.repeat(76))
if (failures) {
  console.log(`❌ ${failures} MNEME LIFECYCLE PROOF FAILURE(S)`)
  process.exit(1)
}
console.log('✅ ALL MNEME LIFECYCLE PROOFS PASS')
