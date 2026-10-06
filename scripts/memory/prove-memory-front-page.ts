#!/usr/bin/env bun
// gate-watch: src/mneme/mnemeFrontPage.ts src/mneme/mnemeUsage.ts src/mneme/mnemeArchive.ts
// gate-watch: src/mneme/mnemeLookup.ts src/mneme/mnemeConsolidate.ts src/mneme/mnemeCorrect.ts
// gate-watch: src/mneme/mnemeLibrary.ts src/mneme/mnemeTopicDocs.ts src/constants/prompts.ts
// gate-watch: src/mneme/memoryVerbs.ts src/mneme/mnemeBuffer.ts src/utils/statusNoticeDefinitions.tsx src/constants/subagentDoctrine.ts
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

let front: typeof import('../../src/mneme/mnemeFrontPage.js') | null = null
try {
  front = await import('../../src/mneme/mnemeFrontPage.js')
} catch {
  front = null
}
check('the front page module exists', front !== null)
if (!front) {
  console.log('\n❌ FRONT PAGE: the module is absent — nothing more can be checked')
  process.exit(1)
}
const { renderFrontPage, publishFrontPage, readFrontPage, readPinnedStatus, frontPageKey } = front
const { retainItems, recallQuery, _resetMemoryVerbSessionStateForTesting } = await import('../../src/mneme/memoryVerbs.js')
const { maybeConsolidate, listTopicDocs, listArchiveDocs } = await import('../../src/mneme/mnemeConsolidate.js')
const { correctFact } = await import('../../src/mneme/mnemeCorrect.js')
const { pinFact, unpinFact, readPins, bumpUsage } = await import('../../src/mneme/mnemeUsage.js')
const { lookupFacts, rankCandidates } = await import('../../src/mneme/mnemeLookup.js')
const { seqCensus, INDEX_LIMIT, ARCHIVE_AFTER_DAYS } = await import('../../src/mneme/mnemeArchive.js')
const { appendObservation } = await import('../../src/mneme/mnemeBuffer.js')
const { MAX_DOC_TOKENS } = await import('../../src/mneme/mnemeTopicDocs.js')

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

section('the pinned shelf: never refuses, measured as text against the limit, every rule loaded')
const RULE_WORDS = ['deploys', 'commits', 'reviews', 'suites', 'worktrees', 'releases', 'docs', 'frames', 'keys', 'lanes', 'folds', 'censuses', 'drives', 'briefs']
const RULES = RULE_WORDS.length
for (let i = 0; i < RULES; i++) {
  retainItems([{ content: `about ${RULE_WORDS[i]}: handle ${RULE_WORDS[i]} the careful way, ${'with care '.repeat(3)}and say so in the ${RULE_WORDS[i]} report`, topic: 'rules' }], { session: `fp-${i}` }, dir)
}
_resetMemoryVerbSessionStateForTesting()
maybeConsolidate({ force: true, dir, now: new Date(T0.getTime() + 4000) })
const ruleSeqs = listTopicDocs(dir).find(d => d.slug === 'rules')!.sections[0]!.entries.map(e => e.seq)
const pinOutcomes = ruleSeqs.map((seq, i) => pinFact(seq, dir, new Date(T0.getTime() + 5000 + i * 1000), { asked: i % 2 === 0 }))
check('a pin is never refused', pinOutcomes.every(o => o.ok) && readPins(dir).length === RULES)
const smallLimit = 600
const overRender = renderFrontPage({ dir, topics: listTopicDocs(dir), archives: listArchiveDocs(dir), pins: readPins(dir), usage: {}, now: T0, limit: smallLimit })
check('the limit is how much text, not how many rules', overRender.status.used > smallLimit && overRender.status.over === true && overRender.status.limit === smallLimit, JSON.stringify({ used: overRender.status.used, limit: overRender.status.limit }))
check('every rule stays loaded when over', overRender.status.loaded.length === RULES && ruleSeqs.every(seq => overRender.text.includes(`<seq=${seq}`)))
check('the rules are distinct enough that the conflict rule leaves them alone', readPins(dir).length === RULES)
check('the page says how full the shelf is and where to trim or raise the limit', overRender.text.includes(`fill ${overRender.status.used} of the ${smallLimit}-character limit`) && overRender.text.includes('raises the limit in /config'))
check('a rule the user asked for is marked as asked for by the user', ruleSeqs.filter((_, i) => i % 2 === 0).every(seq => overRender.text.includes(`<seq=${seq}, asked for by the user>`)) && overRender.status.asked.length === RULES / 2)
check('a rule Mercury pinned on its own carries no asked mark', ruleSeqs.filter((_, i) => i % 2 === 1).every(seq => overRender.text.includes(`<seq=${seq}>`)))
const roomy = renderFrontPage({ dir, topics: listTopicDocs(dir), archives: listArchiveDocs(dir), pins: readPins(dir), usage: {}, now: T0, limit: 100_000 })
check('under the limit the same rules load without the over line', roomy.status.over === false && !roomy.text.includes('-character limit'))
const { pinnedOverLimitLine } = await import('../../src/utils/statusNoticeDefinitions.js')
check('the start-of-session line is one calm sentence with the fill, the limit and both ways out',
  pinnedOverLimitLine({ pinned: 23, used: 9600, limit: 8000 }) === 'Pinned memory: 23 rules, 9.6k of the 8k limit — all still loaded. Trim in /memory or raise the limit in /config.')
const { pinnedTextLimit, PINNED_TEXT_LIMIT_DEFAULT } = await import('../../src/mneme/mnemeUsage.js')
check(`the default limit is ${PINNED_TEXT_LIMIT_DEFAULT} characters of pinned text`, pinnedTextLimit() === PINNED_TEXT_LIMIT_DEFAULT)
maybeConsolidate({ force: true, dir, now: new Date(T0.getTime() + 60_000) })
const status = readPinnedStatus(dir)
check('the published status carries the fill and the limit', status !== null && status.used > 0 && status.limit === PINNED_TEXT_LIMIT_DEFAULT && status.pinned === RULES, JSON.stringify(status))

section("a rule the user asked for is the user's: the model's Correct is refused, consolidation leaves it alone, only the user changes it")
const { correctMemory } = await import('../../src/mneme/memoryVerbs.js')
const { readBuffer } = await import('../../src/mneme/mnemeBuffer.js')
const liveIn = (slug: string, seq: number): boolean => listTopicDocs(dir).find(d => d.slug === slug)?.sections.some(s => s.entries.some(e => e.seq === seq)) === true
const askedSeq = ruleSeqs[0]!
const modelSupersede = correctMemory({ op: 'supersede', id: `seq:${askedSeq}`, content: 'handle deploys however is fastest', reason: 'the model judged the rule outdated', session: 'model-session' }, dir)
check("the model's supersede of an asked rule is refused with one line that says the rule is the user's", !modelSupersede.ok && modelSupersede.code === 'user-asked-rule' && modelSupersede.message.includes('only the user') && modelSupersede.message.includes('/memory'), JSON.stringify(modelSupersede))
const modelRetract = correctMemory({ op: 'retract', id: `seq:${askedSeq}`, reason: 'the model thinks it is wrong', session: 'model-session' }, dir)
check("the model's retract is refused the same way", !modelRetract.ok && modelRetract.code === 'user-asked-rule', JSON.stringify(modelRetract))
check('the asked rule is still live, pinned and marked, word for word', liveIn('rules', askedSeq) && readPins(dir).some(p => p.seq === askedSeq && p.asked) && (readFrontPage(dir) ?? '').includes(`<seq=${askedSeq}, asked for by the user>`))
const plainSeq = ruleSeqs[1]!
const modelFix = correctMemory({ op: 'supersede', id: `seq:${plainSeq}`, content: 'about commits: sign them as Whq02 and say so in the commits report', reason: 'the owner said so', session: 'model-session' }, dir)
check('the model may still correct a rule Mercury pinned on its own', modelFix.ok, JSON.stringify(modelFix))
check('the pin followed the correction and carries no asked mark — the mark never travels onto model words', modelFix.ok && readPins(dir).some(p => p.seq === modelFix.newSeq && !p.asked) && !readPins(dir).some(p => p.seq === plainSeq))
appendObservation({ text: 'a rewrite of the asked rule', source: 'proof', topicHint: 'rules' }, dir)
const refusedDraft = maybeConsolidate({ force: true, dir, now: new Date(T0.getTime() + 70_000), rewriter: ({ rows }) => ({ blocks: [{ topicSlug: 'rules', heading: 'notes', entries: rows.map(r => ({ text: r.text, seq: r.seq, time: r.ts, source: r.source, supersedes: String(askedSeq) })) }] }) })
check('a consolidation draft that would replace an asked rule is refused by the checker and the batch goes back to the buffer', !refusedDraft.consolidated && (refusedDraft.refusedDraft ?? '').includes('asked for') && readBuffer(dir).length === 1 && liveIn('rules', askedSeq), refusedDraft.reason)
maybeConsolidate({ force: true, dir, now: new Date(T0.getTime() + 75_000) })
const userFix = correctFact({ targetSeq: askedSeq, text: 'about deploys: deploy from the mercury-working checkout, say so in the deploys report', source: 'operator', dir, now: new Date(T0.getTime() + 80_000), byUser: true })
check("the user's own correction in /memory replaces the asked rule in place: the old words are history, the pin slot keeps the asked mark", userFix.ok && !liveIn('rules', askedSeq) && listTopicDocs(dir).find(d => d.slug === 'rules')!.history.some(e => e.seq === askedSeq && e.supersededBy === userFix.seq) && readPins(dir).some(p => p.seq === userFix.seq && p.asked) && !readPins(dir).some(p => p.seq === askedSeq), JSON.stringify(userFix))

section('two rules conflict only when the newer one names the older: a named replacement takes the slot; rules that merely share words both stay')
const seqOfText = (slug: string, text: string): number => listTopicDocs(dir).find(d => d.slug === slug)?.sections.flatMap(s => s.entries).find(e => e.text === text)?.seq ?? -1
retainItems([{ content: 'never run the pool before a fold', pin: true }], { session: 'fp-pool' }, dir)
_resetMemoryVerbSessionStateForTesting()
maybeConsolidate({ force: true, dir, now: new Date(T0.getTime() + 90_000) })
retainItems([{ content: 'never run the drives before a fold', pin: true }], { session: 'fp-drives' }, dir)
_resetMemoryVerbSessionStateForTesting()
maybeConsolidate({ force: true, dir, now: new Date(T0.getTime() + 91_000) })
const poolSeq = seqOfText('general', 'never run the pool before a fold')
const drivesSeq = seqOfText('general', 'never run the drives before a fold')
check('two rules that share most of their words both stay live and pinned — no word-overlap guess decides a conflict', liveIn('general', poolSeq) && liveIn('general', drivesSeq) && readPins(dir).some(p => p.seq === poolSeq) && readPins(dir).some(p => p.seq === drivesSeq))
appendObservation({ text: 'deploy from the worktree after the gate', source: 'handover:project-deploy', topicHint: 'preferences', pin: true }, dir)
maybeConsolidate({ force: true, dir, now: new Date(T0.getTime() + 92_000) })
const oldDeploy = seqOfText('preferences', 'deploy from the worktree after the gate')
const oldSlot = readPins(dir).find(p => p.seq === oldDeploy)!
check('a rule pinned without the user asking (as the intake pins) carries no asked mark', oldSlot.asked !== true)
const replacing = retainItems([{ content: 'deploy from the mercury-working checkout after the gate, never from a worktree', replaces: `seq:${oldDeploy}` }], { session: 'fp-replace' }, dir)
_resetMemoryVerbSessionStateForTesting()
check('a retain that names the pinned rule it replaces is stored', replacing[0]?.status === 'stored', JSON.stringify(replacing))
const replaced = maybeConsolidate({ force: true, dir, now: new Date(T0.getTime() + 93_000) })
check('the batch landed', replaced.consolidated, replaced.reason)
const newDeploy = seqOfText('preferences', 'deploy from the mercury-working checkout after the gate, never from a worktree')
const prefDoc = listTopicDocs(dir).find(d => d.slug === 'preferences')!
check('the newer rule took the older\'s place: the older is history under it, on the same page', !liveIn('preferences', oldDeploy) && prefDoc.history.some(e => e.seq === oldDeploy && e.supersededBy === newDeploy) && prefDoc.sections.some(s => s.entries.some(e => e.seq === newDeploy && e.supersedes === String(oldDeploy))))
const newSlot = readPins(dir).find(p => p.seq === newDeploy)
check('the pin kept its slot, now holds the newer rule and is marked asked for by the user', newSlot !== undefined && newSlot.at === oldSlot.at && newSlot.asked === true && !readPins(dir).some(p => p.seq === oldDeploy), JSON.stringify(newSlot))
const refusedAsked = retainItems([{ content: 'deploy however you like', replaces: `seq:${newDeploy}` }], { session: 'fp-replace-asked' }, dir)
check("a replacement naming a rule the user asked for is refused, with the way out", refusedAsked[0]?.status === 'refused' && refusedAsked[0].reason.includes('only the user') && refusedAsked[0].reason.includes('/memory'), JSON.stringify(refusedAsked))
const refusedPlain = retainItems([{ content: 'a fact about deploys', replaces: `seq:${listTopicDocs(dir).find(d => d.slug === 'deploy')!.sections[0]!.entries[0]!.seq}` }], { session: 'fp-replace-plain' }, dir)
check('a replacement naming a plain fact is refused — Correct supersedes facts', refusedPlain[0]?.status === 'refused' && refusedPlain[0].reason.includes('not a pinned rule'), JSON.stringify(refusedPlain))
check('the refused retains stored nothing', readBuffer(dir).length === 0)

section('consolidation merges duplicates: the same fact retained again becomes one live copy with its history kept, nothing lost')
const { normaliseFact } = await import('../../src/mneme/mnemeArchive.js')
const dupDir = join(scratch, 'library-dupes')
const COPIES = ['The gate runs before every deploy.', 'the gate runs before every deploy', 'The gate runs before every deploy!']
check('the three copies share one shape (case, spacing and punctuation aside)', typeof normaliseFact === 'function' && new Set(COPIES.map(normaliseFact)).size === 1)
COPIES.forEach((text, i) => {
  retainItems([{ content: text, topic: 'project' }], { session: `dup-${i}` }, dupDir)
  _resetMemoryVerbSessionStateForTesting()
  maybeConsolidate({ force: true, dir: dupDir, now: new Date(T0.getTime() + i * 1000) })
})
retainItems([{ content: 'the gate runs after every deploy', topic: 'project' }], { session: 'dup-other' }, dupDir)
_resetMemoryVerbSessionStateForTesting()
const dupRun = maybeConsolidate({ force: true, dir: dupDir, now: new Date(T0.getTime() + 5000) })
const projectDoc = listTopicDocs(dupDir).find(d => d.slug === 'project')!
const liveTexts = projectDoc.sections.flatMap(s => s.entries.map(e => e.text))
check('one live copy remains — the newest — beside the different fact', liveTexts.length === 2 && liveTexts.includes(COPIES[2]!) && liveTexts.includes('the gate runs after every deploy'), JSON.stringify(liveTexts))
check('the earlier copies are history, each under the copy that followed it', projectDoc.history.some(e => e.seq === 1 && e.supersededBy === 2) && projectDoc.history.some(e => e.seq === 2 && e.supersededBy === 3) && projectDoc.history.length === 2, JSON.stringify(projectDoc.history.map(e => [e.seq, e.supersededBy])))
check('the checker conserved every seq', seqCensus([...listTopicDocs(dupDir), ...listArchiveDocs(dupDir)]) === '1,2,3,4' && (dupRun.tidy?.conserved ?? false))
check('the index line counts two facts, not four', /^- project \(2 facts\)$/m.test(readFrontPage(dupDir) ?? ''), (readFrontPage(dupDir) ?? '').split('\n').find(l => l.startsWith('- project')))
retainItems([{ content: 'Never push to main.', pin: true }], { session: 'dup-asked' }, dupDir)
_resetMemoryVerbSessionStateForTesting()
maybeConsolidate({ force: true, dir: dupDir, now: new Date(T0.getTime() + 6000) })
retainItems([{ content: 'never push to main', topic: 'project' }], { session: 'dup-echo' }, dupDir)
_resetMemoryVerbSessionStateForTesting()
maybeConsolidate({ force: true, dir: dupDir, now: new Date(T0.getTime() + 7000) })
const allLive = listTopicDocs(dupDir).flatMap(d => d.sections.flatMap(s => s.entries))
check("a copy of a rule the user asked for merges into the asked rule — the user's words stay as said", allLive.some(e => e.text === 'Never push to main.') && !allLive.some(e => e.text === 'never push to main') && listTopicDocs(dupDir).some(d => d.history.some(e => e.text === 'never push to main')))
retainItems([{ content: 'Never push to main.', pin: true }], { session: 'dup-asked-again' }, dupDir)
_resetMemoryVerbSessionStateForTesting()
maybeConsolidate({ force: true, dir: dupDir, now: new Date(T0.getTime() + 8000) })
check('two copies the user asked for both stay — Mercury never merges an asked rule away', listTopicDocs(dupDir).flatMap(d => d.sections.flatMap(s => s.entries)).filter(e => e.text === 'Never push to main.').length === 2 && readPins(dupDir).filter(p => p.asked).length === 2)

section('a crash between the pages and the pins loses no pin: the batch manifest carries the pin intent')
const { unpinFact: unpinCrash } = await import('../../src/mneme/mnemeUsage.js')
const { writeFileSync: writeCrash } = await import('node:fs')
const crashDir = join(scratch, 'library-crash')
appendObservation({ text: 'always say what happened first', source: 'tool:Retain s:crash', topicHint: 'rules', pin: true, asked: true }, crashDir)
const crashRow = readBuffer(crashDir)[0]!
maybeConsolidate({ force: true, dir: crashDir, now: T0 })
const crashSeq = listTopicDocs(crashDir)[0]!.sections[0]!.entries[0]!.seq
check('the rule is pinned after a clean run', readPins(crashDir).some(p => p.seq === crashSeq && p.asked))
unpinCrash(crashSeq, crashDir)
const fnv = (s: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}
writeCrash(join(crashDir, `batch-${crashSeq}-${crashSeq}.json`), JSON.stringify({ version: 1, rows: [{ seq: crashSeq, h: fnv(`${crashRow.ts}\u0000${crashRow.source}\u0000${crashRow.text}`), pin: true, asked: true }] }))
writeCrash(join(crashDir, 'consuming-1-crash.jsonl'), JSON.stringify(crashRow) + '\n')
const recovered = maybeConsolidate({ force: true, dir: crashDir, now: new Date(T0.getTime() + 1000) })
check('the re-absorption finds the rows landed and finishes the cleanup', recovered.reason === 'crashed batch had fully landed; cleanup completed', recovered.reason)
check('the pin is replayed from the manifest with its asked mark', readPins(crashDir).some(p => p.seq === crashSeq && p.asked), JSON.stringify(readPins(crashDir)))
check('the front page shows the rule pinned again', (readFrontPage(crashDir) ?? '').includes(`<seq=${crashSeq}, asked for by the user>`))
check('no duplicate landed', listTopicDocs(crashDir).reduce((n, d) => n + d.sections.reduce((m, s) => m + s.entries.length, 0), 0) === 1)

section('a rule the user asks to remember is on the shelf at once — the next fresh chat carries it without waiting for a maintenance pass')
const { RetainTool } = await import('../../src/tools/MemoryTools/MemoryTools.js')
const { dueForMaintenance, readMaintenanceReceipts } = await import('../../src/mneme/mnemeMaintenance.js')
const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.js')
const { loadMemoryPrompt } = front
const onceDir = mnemeLibraryDir()
const ASKED_RULE = 'end every reply with the word Fairwinds'
appendObservation({ text: 'a plain fact waits for the usual thresholds', source: 'proof', topicHint: 'project' }, onceDir)
check('a small, young buffer with no pinned row is not due', dueForMaintenance(onceDir).due === false)
check('and a run without force leaves it below the thresholds', maybeConsolidate({ dir: onceDir, now: T0 }).reason === 'below thresholds')
_resetMemoryVerbSessionStateForTesting()
const askedCall = (await RetainTool.call({ items: [{ content: ASKED_RULE, pin: true }] }, {} as never)) as { data: { stored: number; shelf?: { landed: boolean; reason: string } } }
check('the Retain tool stores the asked rule and says the shelf has it', askedCall.data.stored === 1 && askedCall.data.shelf?.landed === true, JSON.stringify(askedCall.data))
check('the rule left the buffer: it is on a page, pinned and marked asked for by the user', readBuffer(onceDir).length === 0 && readPins(onceDir).some(p => p.asked) && listTopicDocs(onceDir).some(d => d.sections.some(s => s.entries.some(e => e.text === ASKED_RULE))))
const onceSeq = listTopicDocs(onceDir).flatMap(d => d.sections.flatMap(s => s.entries)).find(e => e.text === ASKED_RULE)?.seq ?? -1
check('a fresh front page (what the next chat loads) carries the rule word for word with the asked mark, with no forced run', (loadMemoryPrompt() ?? '').includes(`- ${ASKED_RULE} <seq=${onceSeq}, asked for by the user>`), (loadMemoryPrompt() ?? '').split('\n').find(l => l.includes(ASKED_RULE)) ?? '(the rule is not on the page)')
check('the plain fact that waited landed with it', listTopicDocs(onceDir).some(d => d.slug === 'project'))
check('the receipt names the trigger and the reason', readMaintenanceReceipts(onceDir, 1).some(r => r.trigger === 'retain' && r.reason.startsWith('a pinned rule waits')), JSON.stringify(readMaintenanceReceipts(onceDir, 1)))
appendObservation({ text: 'a rule pinned by a row written straight into the buffer', source: 'proof', topicHint: 'rules', pin: true }, onceDir)
const waiting = dueForMaintenance(onceDir)
check('a pinned row sitting in the buffer makes maintenance due at once, for the turn-end and boot passes too', waiting.due && waiting.reason === 'a pinned rule waits', JSON.stringify(waiting))
check('and a run without force lands it', maybeConsolidate({ dir: onceDir, now: new Date(T0.getTime() + 1000) }).consolidated === true)
_resetMemoryVerbSessionStateForTesting()
const plainCall = (await RetainTool.call({ items: [{ content: 'a plain fact through the tool stays pending', topic: 'project' }] }, {} as never)) as { data: { stored: number; shelf?: unknown } }
check('a plain Retain still stages and waits for the usual thresholds (no shelf line, the row pending)', plainCall.data.stored === 1 && plainCall.data.shelf === undefined && readBuffer(onceDir).length === 1, JSON.stringify(plainCall.data))

section("the asked mark comes from the user's own chat alone: a crewmate's pin is a plain pin")
const crewDir = join(scratch, 'library-crew')
const rowOf = (dir: string, text: string) => readBuffer(dir).find(r => r.text === text)
retainItems([{ content: 'crew rule: always deploy on Fridays', pin: true }], { session: 'sess-lead-0001', agent: 'agent_crewmate_77' }, crewDir)
const crewRow = rowOf(crewDir, 'crew rule: always deploy on Fridays')
check("a crewmate's Retain with pin: true pins the rule and mints no asked mark", crewRow !== undefined && crewRow.pin === true && crewRow.asked === undefined && /a:agent_crewma/.test(crewRow.source), JSON.stringify(crewRow))
retainItems([{ content: 'user rule: always deploy on Tuesdays', pin: true }], { session: 'sess-user-0001' }, crewDir)
const userRow = rowOf(crewDir, 'user rule: always deploy on Tuesdays')
check("the user's own chat mints the asked mark", userRow !== undefined && userRow.pin === true && userRow.asked === true, JSON.stringify(userRow))
appendObservation({ text: 'handover rule: deploy on Wednesdays', source: 'handover:feedback-deploys', pin: true }, crewDir)
maybeConsolidate({ force: true, dir: crewDir, now: T0 })
const crewPins = readPins(crewDir)
const seqIn = (text: string): number => listTopicDocs(crewDir).flatMap(d => d.sections.flatMap(s => s.entries)).find(e => e.text === text)?.seq ?? -1
check('on the shelf, only the user-asked rule carries the mark; the crew rule is a plain pin', crewPins.length === 3 && crewPins.find(p => p.seq === seqIn('user rule: always deploy on Tuesdays'))?.asked === true && crewPins.find(p => p.seq === seqIn('crew rule: always deploy on Fridays'))?.asked === undefined, JSON.stringify(crewPins))
const crewPage = readFrontPage(crewDir) ?? ''
check('the front page shows the plain pins without the asked words and the asked rule with them', crewPage.includes(`- crew rule: always deploy on Fridays <seq=${seqIn('crew rule: always deploy on Fridays')}>`) && crewPage.includes(`- user rule: always deploy on Tuesdays <seq=${seqIn('user rule: always deploy on Tuesdays')}, asked for by the user>`))
const crewCorrect = correctMemory({ op: 'supersede', id: `seq:${seqIn('crew rule: always deploy on Fridays')}`, content: 'crew rule: deploy on Thursdays', reason: 'the lead revised the crew rule', session: 'lead-session' }, crewDir)
check("a rule a crewmate pinned stays correctable by the model — it was never the user's", crewCorrect.ok, JSON.stringify(crewCorrect))
_resetMemoryVerbSessionStateForTesting()

section('the automatic lookup: up to five facts, pointing at the pages, never a loaded pin')
const hits = lookupFacts('how is the runtime deployed from the checkout', { dir })
check('the deploy facts come back first', hits.length >= 1 && hits[0]!.slug === 'deploy', JSON.stringify(hits.map(h => [h.slug, h.score])))
check('a hit points at its topic page', hits.every(h => h.pagePath.endsWith('.md') || h.pending))
check('no pinned rule is attached (they are all in the prompt)', hits.every(h => !readPins(dir).some(p => p.seq === h.seq)))
const excluded = lookupFacts('how is the runtime deployed from the checkout', { dir, exclude: new Set(hits.map(h => h.id)) })
check('an already-surfaced fact is not attached twice', excluded.every(h => !hits.some(x => x.id === h.id)))
const many = rankCandidates('thing', Array.from({ length: 12 }, (_, i) => ({ id: `seq:${i}`, text: `always do thing ${i}`, signature: '', slug: 'rules', pagePath: 'p', seq: i, pending: false })))
check('a word every fact shares never ranks (nothing discriminating)', many.length === 0)
const dense = rankCandidates('where does the smoke build write its log', [
  { id: 'seq:1', text: 'the smoke build writes its log to build/smoke/lantern.log', signature: '', slug: 'project', pagePath: 'p', seq: 1, pending: false },
  { id: 'seq:2', text: `the packager tars bin/ and share/ into dist/, writes dist/SHA256SUMS, refuses to pack when the tree is dirty, and its smoke scenario runs the build end to end; ${'the summary names the slowest step first and the owner row in MAINTAINERS.md; '.repeat(8)}its log lines carry the prefix pack:`, signature: '', slug: 'project', pagePath: 'p', seq: 2, pending: false },
  { id: 'seq:3', text: 'the formatter rewrites src in place', signature: '', slug: 'project', pagePath: 'p', seq: 3, pending: false },
])
check('a short fact made of the question\'s words outranks a long fact that mentions them in passing', dense.length === 2 && dense[0]!.id === 'seq:1', JSON.stringify(dense.map(h => [h.id, h.score.toFixed(2)])))
check('the cap is five', lookupFacts('handle the careful way and say so in the report', { dir, exclude: new Set() }).length <= 5)
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
check('an archive page exists off the index', existsSync(join(dir, 'archive-deploy.md')) && !/^- deploy\b/m.test((readFrontPage(dir) ?? '').split('## Pinned')[0]!))
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
const { splitDoc, emptyDoc } = await import('../../src/mneme/mnemeTopicDocs.js')
const { indexTopics } = await import('../../src/mneme/mnemeArchive.js')
const grown = emptyDoc('big-2', 'big (split)', T0.toISOString())
grown.sections.push({ heading: 'notes', entries: Array.from({ length: 60 }, (_, i) => ({ text: `${long} more ${i}`, seq: 1000 + i, time: T0.toISOString(), source: 'proof' })) })
const second = splitDoc(grown, T0.toISOString(), new Set(['big', 'big-2']))
check('a split page that splits again is named from the base topic, not big-2-2', second !== null && second[1].slug === 'big-3', JSON.stringify(second?.map(d => d.slug)))
const grouped = second ? indexTopics([listTopicDocs(dir3).find(d => d.slug === 'big')!, second[0], second[1]]) : new Map()
check('the index keeps the three pages under the one topic line', grouped.size === 1 && grouped.get('big')?.map(d => d.slug).join(',') === 'big,big-2,big-3', JSON.stringify([...grouped.entries()].map(([k, v]) => [k, v.map(d => d.slug)])))

section('the system prompt wiring')
const prompts = readFileSync(join(ROOT, 'src/constants/prompts.ts'), 'utf8')
check("the memory section is keyed on the front page so it moves only at consolidation", /keyedSystemPromptSection\(\s*'memory',\s*\(\) => memoryPromptKey\(\),\s*\(\) => loadMemoryPrompt\(\),?\s*\)/.test(prompts))
check('the memory prompt comes from the front page module', prompts.includes("from '../mneme/mnemeFrontPage.js'"))
const doctrine = readFileSync(join(ROOT, 'src/constants/subagentDoctrine.ts'), 'utf8')
check('crewmates and sub-agents get the front page with the pinned rules', doctrine.includes("from '../mneme/mnemeFrontPage.js'") && /\.\.\.\(memory \? \[memory\] : \[\]\)/.test(doctrine))

console.log('\n' + '═'.repeat(76))
console.log(failures === 0 ? '✅ FRONT PAGE, PINNED TIER, LOOKUP AND ARCHIVE PROVEN' : `❌ ${failures} FRONT-PAGE CHECK(S) FAILED`)
console.log('═'.repeat(76))
void publishFrontPage
process.exit(failures === 0 ? 0 : 1)
