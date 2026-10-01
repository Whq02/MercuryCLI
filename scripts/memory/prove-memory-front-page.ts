#!/usr/bin/env bun
// gate-watch: src/memdir/mnemeFrontPage.ts src/memdir/mnemeUsage.ts src/memdir/mnemeArchive.ts
// gate-watch: src/memdir/mnemeLookup.ts src/memdir/mnemeConsolidate.ts src/memdir/mnemeCorrect.ts
// gate-watch: src/memdir/mnemeLibrary.ts src/memdir/mnemeTopicDocs.ts src/constants/prompts.ts
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'mercury-memory-front-page-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

let front: typeof import('../../src/memdir/mnemeFrontPage.js') | null = null
try {
  front = await import('../../src/memdir/mnemeFrontPage.js')
} catch {
  front = null
}
check('the front page module exists', front !== null)
if (!front) {
  console.log('\n❌ FRONT PAGE: the module is absent — nothing more can be checked')
  process.exit(1)
}
const { renderFrontPage, publishFrontPage, readFrontPage, readPinnedStatus, frontPageKey } = front
const { retainItems, recallQuery, _resetMemoryVerbSessionStateForTesting } = await import('../../src/memdir/memoryVerbs.js')
const { maybeConsolidate, listTopicDocs, listArchiveDocs } = await import('../../src/memdir/mnemeConsolidate.js')
const { correctFact } = await import('../../src/memdir/mnemeCorrect.js')
const { pinFact, unpinFact, readPins, bumpUsage, PINNED_LIMIT } = await import('../../src/memdir/mnemeUsage.js')
const { lookupFacts, rankCandidates } = await import('../../src/memdir/mnemeLookup.js')
const { seqCensus, INDEX_LIMIT, ARCHIVE_AFTER_DAYS } = await import('../../src/memdir/mnemeArchive.js')
const { appendObservation } = await import('../../src/memdir/mnemeBuffer.js')
const { MAX_DOC_TOKENS } = await import('../../src/memdir/mnemeTopicDocs.js')

const dir = join(scratch, 'library')
const T0 = new Date('2026-10-01T12:00:00.000Z')

section('an empty library renders a stable front page built by Mercury')
const empty1 = renderFrontPage({ dir, topics: [], archives: [], pins: [], usage: {}, now: T0 }).text
const empty2 = renderFrontPage({ dir, topics: [], archives: [], pins: [], usage: {}, now: new Date('2027-01-01T00:00:00Z') }).text
check('the empty page names the index and the pinned tier', empty1.includes('## Index') && empty1.includes('## Pinned'))
check('the empty page says nothing is saved yet', empty1.includes('nothing saved yet'))
check('the bytes do not depend on the clock', empty1 === empty2)
check('no snapshot exists before the first consolidation', readFrontPage(dir) === null && frontPageKey(dir) === 'none')

section('retaining facts does not move the front page; consolidation does')
retainItems([{ content: 'the runtime is deployed from the mercury-working checkout', topic: 'deploy' }], { session: 'fp' }, dir)
retainItems([{ content: 'the owner signs commits as Whq02', topic: 'owner' }], { session: 'fp' }, dir)
retainItems([{ content: 'the deploy script is scripts/ops/deploy-runtime.sh and runs after the gate', topic: 'deploy' }], { session: 'fp' }, dir)
check('the key is still the empty key after three retains', frontPageKey(dir) === 'none')
const c1 = maybeConsolidate({ force: true, dir, now: T0 })
check('consolidation lands three facts', c1.consolidated && c1.entries === 3, c1.reason)
const page1 = readFrontPage(dir) ?? ''
const key1 = frontPageKey(dir)
check('a snapshot exists and the key moved', page1.length > 0 && key1 !== 'none')
check('the index lists each topic on one line with its fact count', /^- deploy \(2 facts\)$/m.test(page1) && /^- owner \(1 fact\)$/m.test(page1))
check('the index holds where things are, never the facts', !page1.includes('mercury-working checkout') && !page1.includes('Whq02'))
retainItems([{ content: 'a fact retained after the snapshot', topic: 'later' }], { session: 'fp' }, dir)
check('a retain after the snapshot leaves the bytes and the key alone', readFrontPage(dir) === page1 && frontPageKey(dir) === key1)

section('the pinned tier: word for word, pinned and unpinned by the operator')
const ownerSeq = listTopicDocs(dir).find(d => d.slug === 'owner')!.sections[0]!.entries[0]!.seq
pinFact(ownerSeq, dir, T0)
const c2 = maybeConsolidate({ force: true, dir, now: new Date(T0.getTime() + 1000) })
check('a forced run with the pin publishes', c2.consolidated || c2.reason.startsWith('tidy-up'), c2.reason)
const page2 = readFrontPage(dir) ?? ''
check('the pinned rule is loaded word for word', page2.includes(`- the owner signs commits as Whq02 <seq=${ownerSeq}>`))
check('the pinned tier tells the model to follow pinned rules', page2.includes('follow them word for word'))
const fixed = correctFact({ targetSeq: ownerSeq, text: 'the owner signs commits as Whq02 and never as the lead', source: 'proof', dir, now: new Date(T0.getTime() + 2000) })
check('a correction of a pinned fact lands', fixed.ok, JSON.stringify(fixed))
const page3 = readFrontPage(dir) ?? ''
check('the pin follows the correction and the tier shows the new words', fixed.ok && page3.includes(`never as the lead <seq=${fixed.seq}>`) && !page3.includes(`<seq=${ownerSeq}>`))
check('the old fact is kept as history on the page', readFileSync(join(dir, 'topic-owner.md'), 'utf8').includes(`[superseded-by ${fixed.ok ? fixed.seq : 0}]`))
unpinFact(fixed.ok ? fixed.seq : 0, dir)
maybeConsolidate({ force: true, dir, now: new Date(T0.getTime() + 3000) })
check('unpin empties the tier', (readFrontPage(dir) ?? '').includes('no pinned rules'))

section('over the limit: /memory never pins past it; an intake may, and then every rule stays loaded')
for (let i = 0; i < PINNED_LIMIT + 2; i++) {
  retainItems([{ content: `standing rule number ${i}: always do thing ${i}`, topic: 'rules' }], { session: `fp-${i}` }, dir)
}
_resetMemoryVerbSessionStateForTesting()
maybeConsolidate({ force: true, dir, now: new Date(T0.getTime() + 4000) })
const ruleSeqs = listTopicDocs(dir).find(d => d.slug === 'rules')!.sections[0]!.entries.map(e => e.seq)
const pinOutcomes = ruleSeqs.map((seq, i) => pinFact(seq, dir, new Date(T0.getTime() + 5000 + i * 1000)))
check(`the operator can pin up to the limit of ${PINNED_LIMIT}`, pinOutcomes.slice(0, PINNED_LIMIT).every(o => o.ok))
check('the operator cannot pin past the limit', pinOutcomes.slice(PINNED_LIMIT).every(o => !o.ok && o.code === 'limit'), JSON.stringify(pinOutcomes.slice(PINNED_LIMIT)))
const intakePins = ruleSeqs.slice(PINNED_LIMIT).map((seq, i) => pinFact(seq, dir, new Date(T0.getTime() + 20_000 + i * 1000), { pastLimit: true }))
check('an intake may pin past the limit', intakePins.every(o => o.ok))
maybeConsolidate({ force: true, dir, now: new Date(T0.getTime() + 60_000) })
const status = readPinnedStatus(dir)
check('the status counts the pins against the limit and says it is over', status?.pinned === PINNED_LIMIT + 2 && status.limit === PINNED_LIMIT && status.over === true, JSON.stringify(status))
check('every rule stays loaded', status?.loaded.length === PINNED_LIMIT + 2)
const page4 = readFrontPage(dir) ?? ''
check('the front page carries all the rules word for word', ruleSeqs.every(seq => page4.includes(`<seq=${seq}>`)) && page4.includes('always do thing 11'))
check('the front page says it is over the limit and where to trim', page4.includes(`${PINNED_LIMIT + 2} pinned rules, limit ${PINNED_LIMIT} — all loaded; the user trims in /memory`))
const { pinnedOverLimitLine } = await import('../../src/utils/statusNoticeDefinitions.js')
check('the start-of-session line is one calm sentence', pinnedOverLimitLine({ pinned: 12, limit: 10 }) === '12 pinned memory rules, limit 10 — all still loaded. Trim in /memory.')
unpinFact(ruleSeqs[0]!, dir)
unpinFact(ruleSeqs[1]!, dir)
unpinFact(ruleSeqs[2]!, dir)
maybeConsolidate({ force: true, dir, now: new Date(T0.getTime() + 70_000) })
check('after trimming under the limit the notice is off', readPinnedStatus(dir)?.over === false)
check('and the limit applies as normal again', pinFact(ruleSeqs[0]!, dir, new Date(T0.getTime() + 80_000)).ok === true && pinFact(ruleSeqs[1]!, dir, new Date(T0.getTime() + 81_000)).ok === false)
maybeConsolidate({ force: true, dir, now: new Date(T0.getTime() + 90_000) })

section('the automatic lookup: up to five facts, pointing at the pages, never a loaded pin')
const hits = lookupFacts('how is the runtime deployed from the checkout', { dir })
check('the deploy facts come back first', hits.length >= 1 && hits[0]!.slug === 'deploy', JSON.stringify(hits.map(h => [h.slug, h.score])))
check('a hit points at its topic page', hits.every(h => h.pagePath.endsWith('.md') || h.pending))
check('no pinned rule is attached (they are all in the prompt)', hits.every(h => !readPins(dir).some(p => p.seq === h.seq)))
const excluded = lookupFacts('how is the runtime deployed from the checkout', { dir, exclude: new Set(hits.map(h => h.id)) })
check('an already-surfaced fact is not attached twice', excluded.every(h => !hits.some(x => x.id === h.id)))
const many = rankCandidates('thing', Array.from({ length: 12 }, (_, i) => ({ id: `seq:${i}`, text: `always do thing ${i}`, signature: '', slug: 'rules', pagePath: 'p', seq: i, pending: false })))
check('a word every fact shares never ranks (nothing discriminating)', many.length === 0)
check('the cap is five', lookupFacts('standing rule always do thing', { dir, exclude: new Set() }).length <= 5)
check('a pending fact is findable before consolidation', lookupFacts('fact retained after the snapshot', { dir }).some(h => h.pending || h.slug === 'later'))

section('archive: facts nobody has used in a long time leave the index, nothing is lost')
const before = seqCensus([...listTopicDocs(dir), ...listArchiveDocs(dir)])
const later = new Date(T0.getTime() + (ARCHIVE_AFTER_DAYS + 10) * 24 * 60 * 60 * 1000)
mkdirSync(dir, { recursive: true })
appendFileSync(join(dir, 'current.jsonl'), JSON.stringify({ ts: later.toISOString(), source: 'proof', text: 'a brand-new fact keeps its topic warm', topicHint: 'fresh' }) + '\n')
const c3 = maybeConsolidate({ force: true, dir, now: later })
check('the tidy-up archived cold facts', (c3.tidy?.archived ?? 0) > 0, JSON.stringify(c3.tidy))
check('the checker confirms conservation', c3.tidy?.conserved === true)
const after = seqCensus([...listTopicDocs(dir), ...listArchiveDocs(dir)])
const freshSeq = listTopicDocs(dir).find(d => d.slug === 'fresh')!.sections[0]!.entries[0]!.seq
check('every seq is still in the library (archive included), plus the new one', after === [...before.split(',').map(Number), freshSeq].sort((a, b) => a - b).join(','))
check('the pinned rules were not archived', listArchiveDocs(dir).every(d => !d.sections.some(s => s.entries.some(e => readPins(dir).some(p => p.seq === e.seq)))))
check('an archive page exists off the index', existsSync(join(dir, 'archive-deploy.md')) && !/^- deploy\b/m.test(readFrontPage(dir) ?? ''))
check('the front page counts the archived facts', /\d+ facts? not used in a long time sit in archive pages/.test(readFrontPage(dir) ?? ''))
const archivedRecall = recallQuery('deploy-runtime', { dir })
check('Recall still finds an archived fact and labels it', archivedRecall.hits.some(h => h.label === 'archived'), JSON.stringify(archivedRecall.hits.map(h => h.label)))
const archivedSeq = archivedRecall.hits.find(h => h.label === 'archived')?.id.replace('seq:', '')
bumpUsage([Number(archivedSeq)], dir, later)
const c4 = maybeConsolidate({ force: true, dir, now: new Date(later.getTime() + 1000) })
check('a used archived fact is restored to its topic at the next tidy-up', (c4.tidy?.restored ?? 0) >= 1 && listTopicDocs(dir).some(d => d.slug === 'deploy'), JSON.stringify(c4.tidy))

section('the index has a fixed size: splitting and archiving keep it under, nobody is asked')
const dir2 = join(scratch, 'library-wide')
for (let i = 0; i < INDEX_LIMIT + 5; i++) {
  appendObservation({ text: `fact for topic ${i}`, source: 'proof', topicHint: `topic-${String(i).padStart(2, '0')}` }, dir2)
}
const wide = maybeConsolidate({ force: true, dir: dir2, now: T0 })
check('the batch landed', wide.consolidated, wide.reason)
const wideIndexLines = (readFrontPage(dir2) ?? '').split('\n').filter(l => /^- /.test(l))
check(`the index holds at most ${INDEX_LIMIT} topic lines`, wideIndexLines.length <= INDEX_LIMIT, String(wideIndexLines.length))
check('whole cold topics went to the archive', (wide.tidy?.topicsArchived.length ?? 0) >= 5 && wide.tidy?.conserved === true, JSON.stringify(wide.tidy))
check('no fact was lost to the index limit', seqCensus([...listTopicDocs(dir2), ...listArchiveDocs(dir2)]).split(',').length === INDEX_LIMIT + 5)

const dir3 = join(scratch, 'library-long')
const long = 'x'.repeat(400)
for (let i = 0; i < Math.ceil((MAX_DOC_TOKENS * 4) / 440) + 4; i++) {
  appendObservation({ text: `${long} ${i}`, source: 'proof', topicHint: i % 2 === 0 ? 'big' : 'big' }, dir3)
}
const split = maybeConsolidate({
  force: true,
  dir: dir3,
  now: T0,
  rewriter: ({ rows }) => ({
    blocks: [
      { topicSlug: 'big', heading: 'first half', entries: rows.slice(0, Math.floor(rows.length / 2)).map(r => ({ text: r.text, seq: r.seq, time: r.ts, source: r.source })) },
      { topicSlug: 'big', heading: 'second half', entries: rows.slice(Math.floor(rows.length / 2)).map(r => ({ text: r.text, seq: r.seq, time: r.ts, source: r.source })) },
    ],
  }),
})
check('a page over the size limit split into two', split.consolidated && existsSync(join(dir3, 'topic-big-2.md')), JSON.stringify(split.docsTouched))
const bigLines = (readFrontPage(dir3) ?? '').split('\n').filter(l => /^- big\b/.test(l))
check('the index shows the split pages under ONE topic line', bigLines.length === 1 && bigLines[0]!.includes('2 pages: big, big-2'), bigLines.join(' | '))

section('the system prompt wiring')
const prompts = readFileSync(join(ROOT, 'src/constants/prompts.ts'), 'utf8')
check("the memory section is keyed on the front page so it moves only at consolidation", /keyedSystemPromptSection\(\s*'memory',\s*\(\) => memoryPromptKey\(\),\s*\(\) => loadMemoryPrompt\(\),?\s*\)/.test(prompts))
check('the memory prompt comes from the front page module', prompts.includes("from '../memdir/mnemeFrontPage.js'"))

console.log('\n' + '═'.repeat(76))
console.log(failures === 0 ? '✅ FRONT PAGE, PINNED TIER, LOOKUP AND ARCHIVE PROVEN' : `❌ ${failures} FRONT-PAGE CHECK(S) FAILED`)
console.log('═'.repeat(76))
void publishFrontPage
process.exit(failures === 0 ? 0 : 1)
