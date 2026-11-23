#!/usr/bin/env bun
// gate-watch: src/sessions/mneme/mnemeFrontPage.ts src/sessions/mneme/mnemeUsage.ts src/sessions/mneme/mnemeArchive.ts
// gate-watch: src/sessions/mneme/mnemeLookup.ts src/sessions/mneme/mnemeConsolidate.ts src/sessions/mneme/mnemeCorrect.ts
// gate-watch: src/sessions/mneme/mnemeLibrary.ts src/sessions/mneme/mnemeTopicDocs.ts src/engine/system-prompt/defaultSystemPrompt.ts
// gate-watch: src/sessions/mneme/memoryVerbs.ts src/sessions/mneme/mnemeBuffer.ts src/screen/status-notices/statusNoticeDefinitions.tsx src/tools/crewmate/subagentDoctrine.ts
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'mercury-memory-front-page-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` — to fix: ${hint}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

let front: typeof import('../../src/sessions/mneme/mnemeFrontPage.js') | null = null
try {
  front = await import('../../src/sessions/mneme/mnemeFrontPage.js')
} catch {
  front = null
}
check('the front page module exists', front !== null)
if (!front) {
  console.log('\n❌ FRONT PAGE: the module is absent — nothing more can be checked')
  process.exit(1)
}
const { renderFrontPage, publishFrontPage, readFrontPage, readPinnedStatus, frontPageKey } = front
const { retainItems, recallQuery, _resetMemoryVerbSessionStateForTesting } = await import('../../src/sessions/mneme/memoryVerbs.js')
const { maybeConsolidate, listTopicDocs, listArchiveDocs } = await import('../../src/sessions/mneme/mnemeConsolidate.js')
const { correctFact } = await import('../../src/sessions/mneme/mnemeCorrect.js')
const { pinFact, unpinFact, readPins, bumpUsage } = await import('../../src/sessions/mneme/mnemeUsage.js')
const { lookupFacts, rankCandidates } = await import('../../src/sessions/mneme/mnemeLookup.js')
const { seqCensus, INDEX_LIMIT, ARCHIVE_AFTER_DAYS } = await import('../../src/sessions/mneme/mnemeArchive.js')
const { appendObservation } = await import('../../src/sessions/mneme/mnemeBuffer.js')
const { MAX_DOC_TOKENS } = await import('../../src/sessions/mneme/mnemeTopicDocs.js')
const { memoryGrade } = await import('../../src/sessions/mneme/memoryEvidence.js')
const PLAIN_PIN = memoryGrade({ pin: {} })
const ASKED_PIN = memoryGrade({ pin: { asked: true } })
let directives = 0
const ownerSaid = (text: string) => ({ messageId: `owner-directive-${++directives}`, text })

const dir = join(scratch, 'library')
const T0 = new Date('2026-10-01T12:00:00.000Z')

section('an empty library renders a stable front page built by Mercury')
const empty1 = renderFrontPage({ dir, topics: [], archives: [], pins: [], usage: {}, now: T0 }).text
const empty2 = renderFrontPage({ dir, topics: [], archives: [], pins: [], usage: {}, now: new Date('2027-01-01T00:00:00Z') }).text
check('the empty page is the heading and one sentence that names the folder and says nothing is saved yet — no index or pinned tier is painted for an empty library', empty1.startsWith('# Memory\n') && empty1.split('\n').length === 2 && empty1.includes(dir) && empty1.includes('nothing saved yet') && !empty1.includes('## Index') && !empty1.includes('## Pinned'), empty1, 'change renderFrontPage in src/sessions/mneme/mnemeFrontPage.ts so an empty library renders only the heading and one sentence naming the folder')
check('the bytes do not depend on the clock', empty1 === empty2, '', 'renderFrontPage in src/sessions/mneme/mnemeFrontPage.ts must not print the now date or time into the page')
check('no snapshot exists before the first consolidation', readFrontPage(dir) === null && frontPageKey(dir) === 'none', '', 'readFrontPage and frontPageKey in src/sessions/mneme/mnemeFrontPage.ts must report no snapshot (null and the key none) until maybeConsolidate publishes one')

section('retaining facts does not move the front page; consolidation does')
retainItems([{ content: 'the runtime is deployed from the mercury-working checkout', topic: 'deploy' }], { session: 'fp' }, dir)
retainItems([{ content: 'the owner signs commits as Whq02', topic: 'owner' }], { session: 'fp' }, dir)
retainItems([{ content: 'the deploy script is scripts/ops/deploy-runtime.sh and runs after the gate', topic: 'deploy' }], { session: 'fp' }, dir)
check('the key is still the empty key after three retains', frontPageKey(dir) === 'none', '', 'retainItems in src/sessions/mneme/memoryVerbs.ts must only stage rows in the buffer and never publish the front page')
const c1 = maybeConsolidate({ force: true, dir, now: T0 })
check('consolidation lands three facts', c1.consolidated && c1.entries === 3, c1.reason, 'a forced maybeConsolidate in src/sessions/mneme/mnemeConsolidate.ts must land the three retained facts; the reason above says why it did not')
const page1 = readFrontPage(dir) ?? ''
const key1 = frontPageKey(dir)
check('a snapshot exists and the key moved', page1.length > 0 && key1 !== 'none', '', 'maybeConsolidate in src/sessions/mneme/mnemeConsolidate.ts must publish the front page through publishFrontPage in src/sessions/mneme/mnemeFrontPage.ts')
check('the index lists each topic on one line with its fact count', /^- deploy \(2 facts\)$/m.test(page1) && /^- owner \(1 fact\)$/m.test(page1), '', 'renderFrontPage in src/sessions/mneme/mnemeFrontPage.ts must print one index line per topic in the form - topic (N facts)')
check('the index holds where things are, never the facts', !page1.includes('mercury-working checkout') && !page1.includes('Whq02'), '', 'renderFrontPage in src/sessions/mneme/mnemeFrontPage.ts must list topics only; fact text belongs on the topic pages, not in the index')
retainItems([{ content: 'a fact retained after the snapshot', topic: 'later' }], { session: 'fp' }, dir)
check('a retain after the snapshot leaves the bytes and the key alone', readFrontPage(dir) === page1 && frontPageKey(dir) === key1, '', 'retainItems in src/sessions/mneme/memoryVerbs.ts must not rewrite the published front page; only maybeConsolidate may')

section('the pinned tier: word for word, pinned and unpinned by the operator')
const ownerSeq = listTopicDocs(dir).find(d => d.slug === 'owner')!.sections[0]!.entries[0]!.seq
pinFact(ownerSeq, dir, T0)
const c2 = maybeConsolidate({ force: true, dir, now: new Date(T0.getTime() + 1000) })
check('a forced run with the pin publishes', c2.consolidated || c2.reason.startsWith('tidy-up'), c2.reason, 'a forced maybeConsolidate in src/sessions/mneme/mnemeConsolidate.ts must still publish when the only change is a new pin')
const page2 = readFrontPage(dir) ?? ''
check('the pinned rule is loaded word for word behind the plain-pin grade (Mercury pinned it; the owner did not ask)', page2.includes(`- ${PLAIN_PIN} the owner signs commits as Whq02 <seq=${ownerSeq}>`) && PLAIN_PIN === '[pinned · owner intent unverified]', page2.split('\n').find(l => l.includes('Whq02')) ?? '(no pinned line)', 'the pinned tier of renderFrontPage in src/sessions/mneme/mnemeFrontPage.ts must print each pinned rule as - grade text <seq=N> word for word; the grade comes from memoryGrade in src/sessions/mneme/memoryEvidence.ts')
check('the pinned tier tells the model to follow pinned rules', page2.includes('follow them word for word'), '', 'the pinned tier text in renderFrontPage in src/sessions/mneme/mnemeFrontPage.ts must tell the model to follow the rules word for word')
const fixed = correctFact({ targetSeq: ownerSeq, text: 'the owner signs commits as Whq02 and never as the lead', source: 'proof', dir, now: new Date(T0.getTime() + 2000) })
check('a correction of a pinned fact lands', fixed.ok, JSON.stringify(fixed), 'correctFact in src/sessions/mneme/mnemeCorrect.ts must accept a correction of a pinned fact')
const page3 = readFrontPage(dir) ?? ''
check('the pin follows the correction and the tier shows the new words', fixed.ok && page3.includes(`never as the lead <seq=${fixed.seq}>`) && !page3.includes(`<seq=${ownerSeq}>`), '', 'correctFact in src/sessions/mneme/mnemeCorrect.ts must move the pin to the new seq and republish the front page')
check('the old fact is kept as history on the page', readFileSync(join(dir, 'topic-owner.md'), 'utf8').includes(`[superseded-by ${fixed.ok ? fixed.seq : 0}]`))
unpinFact(fixed.ok ? fixed.seq : 0, dir)
maybeConsolidate({ force: true, dir, now: new Date(T0.getTime() + 3000) })
check('unpin empties the tier', (readFrontPage(dir) ?? '').includes('no pinned rules'), '', 'unpinFact in src/sessions/mneme/mnemeUsage.ts must remove the pin so the next published page says no pinned rules')

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
check('a pin is never refused', pinOutcomes.every(o => o.ok) && readPins(dir).length === RULES, '', 'pinFact in src/sessions/mneme/mnemeUsage.ts must accept every pin however much pinned text there already is')
const smallLimit = 600
const overRender = renderFrontPage({ dir, topics: listTopicDocs(dir), archives: listArchiveDocs(dir), pins: readPins(dir), usage: {}, now: T0, limit: smallLimit })
check('the limit is how much text, not how many rules', overRender.status.used > smallLimit && overRender.status.over === true && overRender.status.limit === smallLimit, JSON.stringify({ used: overRender.status.used, limit: overRender.status.limit }), 'renderFrontPage in src/sessions/mneme/mnemeFrontPage.ts must measure the pinned text in characters against the limit it is given and set status.over when it is exceeded')
check('every rule stays loaded when over', overRender.status.loaded.length === RULES && ruleSeqs.every(seq => overRender.text.includes(`<seq=${seq}`)), '', 'renderFrontPage in src/sessions/mneme/mnemeFrontPage.ts must keep loading every pinned rule when the limit is exceeded')
check('the rules are distinct enough that the conflict rule leaves them alone', readPins(dir).length === RULES)
check('the page says how full the shelf is and where to trim or raise the limit', overRender.text.includes(`fill ${overRender.status.used} of the ${smallLimit}-character limit`) && overRender.text.includes('raises the limit in /config'), '', 'the over-limit line in renderFrontPage in src/sessions/mneme/mnemeFrontPage.ts must give the fill, the limit and both ways out')
check('a rule the user asked for is marked as asked for by the user', ruleSeqs.filter((_, i) => i % 2 === 0).every(seq => overRender.text.includes(`<seq=${seq}, asked for by the user>`)) && overRender.status.asked.length === RULES / 2, '', 'renderFrontPage in src/sessions/mneme/mnemeFrontPage.ts must mark each pin the user asked for with asked for by the user and list it in status.asked')
check('a rule Mercury pinned on its own carries no asked mark', ruleSeqs.filter((_, i) => i % 2 === 1).every(seq => overRender.text.includes(`<seq=${seq}>`)))
const roomy = renderFrontPage({ dir, topics: listTopicDocs(dir), archives: listArchiveDocs(dir), pins: readPins(dir), usage: {}, now: T0, limit: 100_000 })
check('under the limit the same rules load without the over line', roomy.status.over === false && !roomy.text.includes('-character limit'), '', 'renderFrontPage in src/sessions/mneme/mnemeFrontPage.ts must print the over-limit line only when the pinned text exceeds the limit')
const { pinnedOverLimitLine } = await import('../../src/screen/status-notices/statusNoticeDefinitions.js')
check('the start-of-session line is one calm sentence with the fill, the limit and both ways out',
  pinnedOverLimitLine({ pinned: 23, used: 9600, limit: 8000 }) === 'Pinned memory: 23 rules, 9.6k of the 8k limit — all still loaded. Trim in /memory or raise the limit in /config.', '', 'change pinnedOverLimitLine in src/screen/status-notices/statusNoticeDefinitions.tsx to print the line shown in this check')
const { pinnedTextLimit, PINNED_TEXT_LIMIT_DEFAULT } = await import('../../src/sessions/mneme/mnemeUsage.js')
check(`the default limit is ${PINNED_TEXT_LIMIT_DEFAULT} characters of pinned text`, pinnedTextLimit() === PINNED_TEXT_LIMIT_DEFAULT, '', 'pinnedTextLimit in src/sessions/mneme/mnemeUsage.ts must return PINNED_TEXT_LIMIT_DEFAULT when no setting overrides it')
maybeConsolidate({ force: true, dir, now: new Date(T0.getTime() + 60_000) })
const status = readPinnedStatus(dir)
check('the published status carries the fill and the limit', status !== null && status.used > 0 && status.limit === PINNED_TEXT_LIMIT_DEFAULT && status.pinned === RULES, JSON.stringify(status), 'maybeConsolidate in src/sessions/mneme/mnemeConsolidate.ts must publish the pinned status that readPinnedStatus in src/sessions/mneme/mnemeFrontPage.ts reads back')

section("a rule the user asked for is the user's: the model's Correct is refused, consolidation leaves it alone, only the user changes it")
const { correctMemory } = await import('../../src/sessions/mneme/memoryVerbs.js')
const { readBuffer } = await import('../../src/sessions/mneme/mnemeBuffer.js')
const liveIn = (slug: string, seq: number): boolean => listTopicDocs(dir).find(d => d.slug === slug)?.sections.some(s => s.entries.some(e => e.seq === seq)) === true
const askedSeq = ruleSeqs[0]!
const modelSupersede = correctMemory({ op: 'supersede', id: `seq:${askedSeq}`, content: 'handle deploys however is fastest', reason: 'the model judged the rule outdated', session: 'model-session' }, dir)
check("the model's supersede of an asked rule is refused with one line that says the rule is the user's", !modelSupersede.ok && modelSupersede.code === 'user-asked-rule' && modelSupersede.message.includes('only the user') && modelSupersede.message.includes('/memory'), JSON.stringify(modelSupersede), 'correctMemory in src/sessions/mneme/memoryVerbs.ts must refuse a model supersede of an asked rule with code user-asked-rule and a message naming /memory')
const modelRetract = correctMemory({ op: 'retract', id: `seq:${askedSeq}`, reason: 'the model thinks it is wrong', session: 'model-session' }, dir)
check("the model's retract is refused the same way", !modelRetract.ok && modelRetract.code === 'user-asked-rule', JSON.stringify(modelRetract), 'correctMemory in src/sessions/mneme/memoryVerbs.ts must refuse a model retract of an asked rule with code user-asked-rule')
check('the asked rule is still live, pinned and marked, word for word', liveIn('rules', askedSeq) && readPins(dir).some(p => p.seq === askedSeq && p.asked) && (readFrontPage(dir) ?? '').includes(`<seq=${askedSeq}, asked for by the user>`))
const plainSeq = ruleSeqs[1]!
const modelFix = correctMemory({ op: 'supersede', id: `seq:${plainSeq}`, content: 'about commits: sign them as Whq02 and say so in the commits report', reason: 'the owner said so', session: 'model-session' }, dir)
check('the model may still correct a rule Mercury pinned on its own', modelFix.ok, JSON.stringify(modelFix), 'correctMemory in src/sessions/mneme/memoryVerbs.ts must refuse only rules the user asked for')
check('the pin followed the correction and carries no asked mark — the mark never travels onto model words', modelFix.ok && readPins(dir).some(p => p.seq === modelFix.newSeq && !p.asked) && !readPins(dir).some(p => p.seq === plainSeq))
appendObservation({ text: 'a rewrite of the asked rule', source: 'proof', topicHint: 'rules' }, dir)
const refusedDraft = maybeConsolidate({ force: true, dir, now: new Date(T0.getTime() + 70_000), rewriter: ({ rows }) => ({ blocks: [{ topicSlug: 'rules', heading: 'notes', entries: rows.map(r => ({ text: r.text, seq: r.seq, time: r.ts, source: r.source, supersedes: String(askedSeq) })) }] }) })
check('a consolidation draft that would replace an asked rule is refused by the checker and the batch goes back to the buffer', !refusedDraft.consolidated && (refusedDraft.refusedDraft ?? '').includes('asked for') && readBuffer(dir).length === 1 && liveIn('rules', askedSeq), refusedDraft.reason, 'maybeConsolidate in src/sessions/mneme/mnemeConsolidate.ts must refuse a draft that supersedes an asked rule and return the batch to the buffer')
maybeConsolidate({ force: true, dir, now: new Date(T0.getTime() + 75_000) })
const userFix = correctFact({ targetSeq: askedSeq, text: 'about deploys: deploy from the mercury-working checkout, say so in the deploys report', source: 'operator', dir, now: new Date(T0.getTime() + 80_000), byUser: true })
check("the user's own correction in /memory replaces the asked rule in place: the old words are history, the pin slot keeps the asked mark", userFix.ok && !liveIn('rules', askedSeq) && listTopicDocs(dir).find(d => d.slug === 'rules')!.history.some(e => e.seq === askedSeq && e.supersededBy === userFix.seq) && readPins(dir).some(p => p.seq === userFix.seq && p.asked) && !readPins(dir).some(p => p.seq === askedSeq), JSON.stringify(userFix), 'correctFact in src/sessions/mneme/mnemeCorrect.ts with byUser must replace the asked rule in place and keep the asked mark on the pin slot')

section('two rules conflict only when the newer one names the older: a named replacement takes the slot; rules that merely share words both stay')
const seqOfText = (slug: string, text: string): number => listTopicDocs(dir).find(d => d.slug === slug)?.sections.flatMap(s => s.entries).find(e => e.text === text)?.seq ?? -1
retainItems([{ content: 'never run the pool before a fold', pin: true }], { session: 'fp-pool', pinIntent: ownerSaid('never run the pool before a fold') }, dir)
_resetMemoryVerbSessionStateForTesting()
maybeConsolidate({ force: true, dir, now: new Date(T0.getTime() + 90_000) })
retainItems([{ content: 'never run the drives before a fold', pin: true }], { session: 'fp-drives', pinIntent: ownerSaid('never run the drives before a fold') }, dir)
_resetMemoryVerbSessionStateForTesting()
maybeConsolidate({ force: true, dir, now: new Date(T0.getTime() + 91_000) })
const poolSeq = seqOfText('general', 'never run the pool before a fold')
const drivesSeq = seqOfText('general', 'never run the drives before a fold')
check('two rules that share most of their words both stay live and pinned — no word-overlap guess decides a conflict', liveIn('general', poolSeq) && liveIn('general', drivesSeq) && readPins(dir).some(p => p.seq === poolSeq) && readPins(dir).some(p => p.seq === drivesSeq), '', 'maybeConsolidate in src/sessions/mneme/mnemeConsolidate.ts must treat two rules as conflicting only when the newer names the older, never by shared words')
appendObservation({ text: 'deploy from the worktree after the gate', source: 'handover:project-deploy', topicHint: 'preferences', pin: true }, dir)
maybeConsolidate({ force: true, dir, now: new Date(T0.getTime() + 92_000) })
const oldDeploy = seqOfText('preferences', 'deploy from the worktree after the gate')
const oldSlot = readPins(dir).find(p => p.seq === oldDeploy)!
check('a rule pinned without the user asking (as the intake pins) carries no asked mark', oldSlot.asked !== true, '', 'the pin step of maybeConsolidate in src/sessions/mneme/mnemeConsolidate.ts must set asked only for rows the owner asked to pin')
const replacing = retainItems([{ content: 'deploy from the mercury-working checkout after the gate, never from a worktree', replaces: `seq:${oldDeploy}` }], { session: 'fp-replace', pinIntent: ownerSaid('From now on, deploy from the mercury-working checkout after the gate, never from a worktree.') }, dir)
_resetMemoryVerbSessionStateForTesting()
check('a retain that names the pinned rule it replaces is stored', replacing[0]?.status === 'stored', JSON.stringify(replacing), 'retainItems in src/sessions/mneme/memoryVerbs.ts must store an item whose replaces names a live pinned rule')
const replaced = maybeConsolidate({ force: true, dir, now: new Date(T0.getTime() + 93_000) })
check('the batch landed', replaced.consolidated, replaced.reason, 'a forced maybeConsolidate in src/sessions/mneme/mnemeConsolidate.ts must land the replacing row')
const newDeploy = seqOfText('preferences', 'deploy from the mercury-working checkout after the gate, never from a worktree')
const prefDoc = listTopicDocs(dir).find(d => d.slug === 'preferences')!
check('the newer rule took the older\'s place: the older is history under it, on the same page', !liveIn('preferences', oldDeploy) && prefDoc.history.some(e => e.seq === oldDeploy && e.supersededBy === newDeploy) && prefDoc.sections.some(s => s.entries.some(e => e.seq === newDeploy && e.supersedes === String(oldDeploy))))
const newSlot = readPins(dir).find(p => p.seq === newDeploy)
check('the pin kept its slot, now holds the newer rule and is marked asked for by the user (the owner said the new words)', newSlot !== undefined && newSlot.at === oldSlot.at && newSlot.asked === true && !readPins(dir).some(p => p.seq === oldDeploy), JSON.stringify(newSlot), 'the replacement step in src/sessions/mneme/mnemeConsolidate.ts must keep the pin slot, move it to the new seq and mark it asked when the owner said the new words')
const refusedAsked = retainItems([{ content: 'deploy however you like', replaces: `seq:${newDeploy}` }], { session: 'fp-replace-asked' }, dir)
check("a replacement naming a rule the user asked for is refused, with the way out", refusedAsked[0]?.status === 'refused' && refusedAsked[0].reason.includes('only the user') && refusedAsked[0].reason.includes('/memory'), JSON.stringify(refusedAsked), 'retainItems in src/sessions/mneme/memoryVerbs.ts must refuse a replaces that names an asked rule and say only the user can change it in /memory')
const refusedGone = retainItems([{ content: 'a fact about deploys', replaces: 'seq:424242' }], { session: 'fp-replace-gone' }, dir)
check('a replacement naming a seq that is not live is refused', refusedGone[0]?.status === 'refused' && refusedGone[0].reason.includes('not live'), JSON.stringify(refusedGone), 'retainItems in src/sessions/mneme/memoryVerbs.ts must refuse a replaces that names a seq that is not live, with a reason saying not live')
check('the refused retains stored nothing', readBuffer(dir).length === 0, '', 'retainItems in src/sessions/mneme/memoryVerbs.ts must not append a buffer row for a refused item')
const restateDir = join(scratch, 'library-restate')
retainItems([{ content: 'I like short answers', pin: true, topic: 'style' }], { session: 'fp-restate-old', pinIntent: ownerSaid('I like short answers') }, restateDir)
_resetMemoryVerbSessionStateForTesting()
maybeConsolidate({ force: true, dir: restateDir, now: new Date(T0.getTime() + 94_000) })
const styleDoc = (): ReturnType<typeof listTopicDocs>[number] => listTopicDocs(restateDir).find(d => d.slug === 'style')!
const shortSeq = styleDoc().sections[0]!.entries[0]!.seq
unpinFact(shortSeq, restateDir)
check('the user unpinned the old rule in /memory: it is a plain live fact, no pin', !readPins(restateDir).some(p => p.seq === shortSeq) && styleDoc().sections.some(s => s.entries.some(e => e.seq === shortSeq)))
const restated = retainItems([{ content: 'give me long, detailed answers', pin: true, replaces: `seq:${shortSeq}` }], { session: 'fp-restate-new', pinIntent: ownerSaid('From now on, give me long, detailed answers.') }, restateDir)
_resetMemoryVerbSessionStateForTesting()
check('the restated rule may name the unpinned rule it replaces (a plain live fact is a lawful target)', restated[0]?.status === 'stored', JSON.stringify(restated), 'retainItems in src/sessions/mneme/memoryVerbs.ts must accept a replaces that names a live fact that is not pinned')
const restatedRun = maybeConsolidate({ force: true, dir: restateDir, now: new Date(T0.getTime() + 95_000) })
const restatedSeq = styleDoc().sections.flatMap(s => s.entries).find(e => e.text.startsWith('give me long'))?.seq ?? -1
check('after consolidation ONE rule is current: the old wording is history under the new rule, which is pinned and marked asked for', restatedRun.consolidated && !styleDoc().sections.some(s => s.entries.some(e => e.seq === shortSeq)) && styleDoc().history.some(e => e.seq === shortSeq && e.supersededBy === restatedSeq) && styleDoc().sections.flatMap(s => s.entries).length === 1 && readPins(restateDir).some(p => p.seq === restatedSeq && p.asked === true), JSON.stringify({ restatedSeq, live: styleDoc().sections.flatMap(s => s.entries.map(e => e.text)), pins: readPins(restateDir) }), 'maybeConsolidate in src/sessions/mneme/mnemeConsolidate.ts must leave one current rule, move the old words to history and carry the pin and asked mark to the new rule')

section('consolidation merges duplicates: the same fact retained again becomes one live copy with its history kept, nothing lost')
const { normaliseFact } = await import('../../src/sessions/mneme/mnemeArchive.js')
const dupDir = join(scratch, 'library-dupes')
const COPIES = ['The gate runs before every deploy.', 'the gate runs before every deploy', 'The gate runs before every deploy!']
check('the three copies share one shape (case, spacing and punctuation aside)', typeof normaliseFact === 'function' && new Set(COPIES.map(normaliseFact)).size === 1, '', 'normaliseFact in src/sessions/mneme/mnemeArchive.ts must ignore case, spacing and trailing punctuation')
COPIES.forEach((text, i) => {
  retainItems([{ content: text, topic: 'project' }], { session: `dup-${i}` }, dupDir)
  _resetMemoryVerbSessionStateForTesting()
  maybeConsolidate({ force: true, dir: dupDir, now: new Date(T0.getTime() + i * 1000) })
})
retainItems([{ content: 'the deploy script checks the manifest', topic: 'project' }], { session: 'dup-other' }, dupDir)
_resetMemoryVerbSessionStateForTesting()
const dupRun = maybeConsolidate({ force: true, dir: dupDir, now: new Date(T0.getTime() + 5000) })
const projectDoc = listTopicDocs(dupDir).find(d => d.slug === 'project')!
const liveTexts = projectDoc.sections.flatMap(s => s.entries.map(e => e.text))
check('one live copy remains — the newest — beside the different fact', liveTexts.length === 2 && liveTexts.includes(COPIES[2]!) && liveTexts.includes('the deploy script checks the manifest'), JSON.stringify(liveTexts), 'the tidy-up behind maybeConsolidate in src/sessions/mneme/mnemeConsolidate.ts (tidyLibrary in src/sessions/mneme/mnemeArchive.ts) must merge duplicate facts and keep the newest copy live')
check('the earlier copies are history, each under the copy that followed it', projectDoc.history.some(e => e.seq === 1 && e.supersededBy === 2) && projectDoc.history.some(e => e.seq === 2 && e.supersededBy === 3) && projectDoc.history.length === 2, JSON.stringify(projectDoc.history.map(e => [e.seq, e.supersededBy])), 'the merge in tidyLibrary in src/sessions/mneme/mnemeArchive.ts must record each earlier copy in history under the copy that followed it')
check('the checker conserved every seq', seqCensus([...listTopicDocs(dupDir), ...listArchiveDocs(dupDir)]) === '1,2,3,4' && (dupRun.tidy?.conserved ?? false), '', 'tidyLibrary in src/sessions/mneme/mnemeArchive.ts must keep every seq when it merges; compare with seqCensus in the same file')
check('the index line counts two facts, not four', /^- project \(2 facts\)$/m.test(readFrontPage(dupDir) ?? ''), (readFrontPage(dupDir) ?? '').split('\n').find(l => l.startsWith('- project')), 'renderFrontPage in src/sessions/mneme/mnemeFrontPage.ts must count live facts only in the index line')
retainItems([{ content: 'Never push to main.', pin: true }], { session: 'dup-asked', pinIntent: ownerSaid('Never push to main.') }, dupDir)
_resetMemoryVerbSessionStateForTesting()
maybeConsolidate({ force: true, dir: dupDir, now: new Date(T0.getTime() + 6000) })
retainItems([{ content: 'never push to main', topic: 'project' }], { session: 'dup-echo' }, dupDir)
_resetMemoryVerbSessionStateForTesting()
maybeConsolidate({ force: true, dir: dupDir, now: new Date(T0.getTime() + 7000) })
const allLive = listTopicDocs(dupDir).flatMap(d => d.sections.flatMap(s => s.entries))
check("a copy of a rule the user asked for merges into the asked rule — the user's words stay as said", allLive.some(e => e.text === 'Never push to main.') && !allLive.some(e => e.text === 'never push to main') && listTopicDocs(dupDir).some(d => d.history.some(e => e.text === 'never push to main')), '', 'the merge in tidyLibrary in src/sessions/mneme/mnemeArchive.ts must fold a copy into the asked rule and keep the asked rule words as said')
retainItems([{ content: 'Never push to main.', pin: true }], { session: 'dup-asked-again', pinIntent: ownerSaid('Never push to main.') }, dupDir)
_resetMemoryVerbSessionStateForTesting()
maybeConsolidate({ force: true, dir: dupDir, now: new Date(T0.getTime() + 8000) })
check('two copies the user asked for both stay — Mercury never merges an asked rule away', listTopicDocs(dupDir).flatMap(d => d.sections.flatMap(s => s.entries)).filter(e => e.text === 'Never push to main.').length === 2 && readPins(dupDir).filter(p => p.asked).length === 2, '', 'the merge in tidyLibrary in src/sessions/mneme/mnemeArchive.ts must never merge away a rule the user asked for')

section('a crash between the pages and the pins loses no pin: the batch manifest carries the pin intent')
const { unpinFact: unpinCrash } = await import('../../src/sessions/mneme/mnemeUsage.js')
const { writeFileSync: writeCrash } = await import('node:fs')
const crashDir = join(scratch, 'library-crash')
appendObservation({ text: 'always say what happened first', source: 'tool:Retain s:crash', topicHint: 'rules', pin: true, asked: true }, crashDir)
const crashRow = readBuffer(crashDir)[0]!
maybeConsolidate({ force: true, dir: crashDir, now: T0 })
const crashSeq = listTopicDocs(crashDir)[0]!.sections[0]!.entries[0]!.seq
check('the rule is pinned after a clean run', readPins(crashDir).some(p => p.seq === crashSeq && p.asked), '', 'maybeConsolidate in src/sessions/mneme/mnemeConsolidate.ts must pin a buffer row written with pin and asked')
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
check('the re-absorption finds the rows landed and finishes the cleanup', recovered.reason === 'crashed batch had fully landed; cleanup completed', recovered.reason, 'the crash re-absorption in src/sessions/mneme/mnemeConsolidate.ts must recognise rows that already landed from the batch manifest and finish the cleanup')
check('the pin is replayed from the manifest with its asked mark', readPins(crashDir).some(p => p.seq === crashSeq && p.asked), JSON.stringify(readPins(crashDir)), 'replayLandedPins in src/sessions/mneme/mnemeConsolidate.ts must replay the pin and its asked mark from the batch manifest')
check('the front page shows the rule pinned again', (readFrontPage(crashDir) ?? '').includes(`<seq=${crashSeq}, asked for by the user>`))
check('no duplicate landed', listTopicDocs(crashDir).reduce((n, d) => n + d.sections.reduce((m, s) => m + s.entries.length, 0), 0) === 1)

section('a rule the user asks to remember is on the shelf at once — the next fresh chat carries it without waiting for a maintenance pass')
const { RetainTool } = await import('../../src/tools/memory/MemoryTools.js')
const { dueForMaintenance, readMaintenanceReceipts } = await import('../../src/sessions/mneme/mnemeMaintenance.js')
const { mnemeLibraryDir } = await import('../../src/sessions/mneme/mnemeGates.js')
const { loadMemoryPrompt } = front
const onceDir = mnemeLibraryDir()
const ASKED_RULE = 'end every reply with the word Fairwinds'
appendObservation({ text: 'a plain fact waits for the usual thresholds', source: 'proof', topicHint: 'project' }, onceDir)
check('a small, young buffer with no pinned row is not due', dueForMaintenance(onceDir).due === false)
check('and a run without force leaves it below the thresholds', maybeConsolidate({ dir: onceDir, now: T0 }).reason === 'below thresholds')
_resetMemoryVerbSessionStateForTesting()
const ownerTurn = (text: string) => ({ messages: [{ type: 'user', uuid: `owner-turn-${++directives}`, message: { role: 'user', content: text }, origin: { kind: 'human' } }] }) as never
const askedCall = (await RetainTool.call({ items: [{ content: ASKED_RULE, pin: true }] }, ownerTurn(`Remember this as a standing rule: ${ASKED_RULE}.`))) as { data: { stored: number; shelf?: { landed: boolean; reason: string } } }
check('the Retain tool stores the asked rule and says the shelf has it', askedCall.data.stored === 1 && askedCall.data.shelf?.landed === true, JSON.stringify(askedCall.data), 'RetainTool in src/tools/memory/MemoryTools.ts must run a consolidation when an item is pinned by the owner and report it in data.shelf')
check('the rule left the buffer: it is on a page, pinned and marked asked for by the user', readBuffer(onceDir).length === 0 && readPins(onceDir).some(p => p.asked) && listTopicDocs(onceDir).some(d => d.sections.some(s => s.entries.some(e => e.text === ASKED_RULE))))
const onceSeq = listTopicDocs(onceDir).flatMap(d => d.sections.flatMap(s => s.entries)).find(e => e.text === ASKED_RULE)?.seq ?? -1
check('a fresh front page (what the next chat loads) carries the rule word for word behind the asked-pin grade with the asked mark, with no forced run', (loadMemoryPrompt() ?? '').includes(`- ${ASKED_PIN} ${ASKED_RULE} <seq=${onceSeq}, asked for by the user>`) && ASKED_PIN === '[pinned · asked by the owner]', (loadMemoryPrompt() ?? '').split('\n').find(l => l.includes(ASKED_RULE)) ?? '(the rule is not on the page)')
check('the plain fact that waited landed with it', listTopicDocs(onceDir).some(d => d.slug === 'project'))
check('the receipt names the trigger and the reason', readMaintenanceReceipts(onceDir, 1).some(r => r.trigger === 'retain' && r.reason.startsWith('a pinned rule waits')), JSON.stringify(readMaintenanceReceipts(onceDir, 1)), 'RetainTool in src/tools/memory/MemoryTools.ts must run its consolidation with trigger retain and the reason a pinned rule waits (PINNED_ROW_WAITS in src/sessions/mneme/mnemeConsolidate.ts)')
appendObservation({ text: 'a rule pinned by a row written straight into the buffer', source: 'proof', topicHint: 'rules', pin: true }, onceDir)
const waiting = dueForMaintenance(onceDir)
check('a pinned row sitting in the buffer makes maintenance due at once, for the turn-end and boot passes too', waiting.due && waiting.reason === 'a pinned rule waits', JSON.stringify(waiting), 'dueForMaintenance in src/sessions/mneme/mnemeMaintenance.ts must report due with the reason a pinned rule waits when a pinned row is in the buffer')
check('and a run without force lands it', maybeConsolidate({ dir: onceDir, now: new Date(T0.getTime() + 1000) }).consolidated === true)
_resetMemoryVerbSessionStateForTesting()
const plainCall = (await RetainTool.call({ items: [{ content: 'a plain fact through the tool stays pending', topic: 'project' }] }, ownerTurn('note that a plain fact through the tool stays pending'))) as { data: { stored: number; shelf?: unknown } }
check('a plain Retain still stages and waits for the usual thresholds (no shelf line, the row pending)', plainCall.data.stored === 1 && plainCall.data.shelf === undefined && readBuffer(onceDir).length === 1, JSON.stringify(plainCall.data), 'RetainTool in src/tools/memory/MemoryTools.ts must run the immediate shelf pass only when an item is pinned')

section("a standing rule needs the owner's own words: a crewmate's pin is refused outright, the owner's directive mints the asked mark, an intake pin stays a plain pin")
const crewDir = join(scratch, 'library-crew')
const rowOf = (dir: string, text: string) => readBuffer(dir).find(r => r.text === text)
const crewPin = retainItems([{ content: 'crew rule: always deploy on Fridays', pin: true }], { session: 'sess-lead-0001', agent: 'agent_crewmate_77' }, crewDir)
check("a crewmate's Retain with pin: true is refused and stores nothing — no owner words, no standing rule", crewPin[0]?.status === 'refused' && /crewmate cannot pin/.test(crewPin[0].reason) && rowOf(crewDir, 'crew rule: always deploy on Fridays') === undefined, JSON.stringify(crewPin), 'retainItems in src/sessions/mneme/memoryVerbs.ts must refuse pin from a crewmate with a reason saying a crewmate cannot pin, and store nothing')
const crewFact = retainItems([{ content: 'crew note: the Friday deploy window is quiet' }], { session: 'sess-lead-0001', agent: 'agent_crewmate_77' }, crewDir)
check("a crewmate's plain fact is still stored, with the crew source", crewFact[0]?.status === 'stored' && /a:agent_crewma/.test(rowOf(crewDir, 'crew note: the Friday deploy window is quiet')?.source ?? ''), JSON.stringify(crewFact))
const unasked = retainItems([{ content: 'user rule: always deploy on Tuesdays', pin: true }], { session: 'sess-user-0000' }, crewDir)
check("the main chat without the owner's directive is refused too, with the way out named", unasked[0]?.status === 'refused' && /\/memory/.test(unasked[0].reason) && rowOf(crewDir, 'user rule: always deploy on Tuesdays') === undefined, JSON.stringify(unasked), 'retainItems in src/sessions/mneme/memoryVerbs.ts must refuse pin in the main chat without the owner directive and name /memory in the reason')
_resetMemoryVerbSessionStateForTesting()
retainItems([{ content: 'user rule: always deploy on Tuesdays', pin: true }], { session: 'sess-user-0001', pinIntent: ownerSaid('Remember this as a rule: user rule: always deploy on Tuesdays') }, crewDir)
const userRow = rowOf(crewDir, 'user rule: always deploy on Tuesdays')
check("the owner's own directive mints the asked mark", userRow !== undefined && userRow.pin === true && userRow.asked === true, JSON.stringify(userRow), 'retainItems in src/sessions/mneme/memoryVerbs.ts must set asked on a pinned row when the owner directive is passed as pinIntent')
appendObservation({ text: 'handover rule: deploy on Wednesdays', source: 'handover:feedback-deploys', pin: true }, crewDir)
maybeConsolidate({ force: true, dir: crewDir, now: T0 })
const crewPins = readPins(crewDir)
const seqIn = (text: string): number => listTopicDocs(crewDir).flatMap(d => d.sections.flatMap(s => s.entries)).find(e => e.text === text)?.seq ?? -1
check('on the shelf, only the owner-asked rule carries the mark; the intake rule is a plain pin', crewPins.length === 2 && crewPins.find(p => p.seq === seqIn('user rule: always deploy on Tuesdays'))?.asked === true && crewPins.find(p => p.seq === seqIn('handover rule: deploy on Wednesdays'))?.asked === undefined, JSON.stringify(crewPins), 'maybeConsolidate in src/sessions/mneme/mnemeConsolidate.ts must keep the asked mark only on the owner-asked pin; an intake pin stays plain')
const crewPage = readFrontPage(crewDir) ?? ''
check('the front page shows the plain pin behind the unverified-intent grade without the asked words and the asked rule behind the asked grade with them', crewPage.includes(`- ${PLAIN_PIN} handover rule: deploy on Wednesdays <seq=${seqIn('handover rule: deploy on Wednesdays')}>`) && crewPage.includes(`- ${ASKED_PIN} user rule: always deploy on Tuesdays <seq=${seqIn('user rule: always deploy on Tuesdays')}, asked for by the user>`), crewPage, 'renderFrontPage in src/sessions/mneme/mnemeFrontPage.ts must print the grade from memoryGrade in src/sessions/mneme/memoryEvidence.ts on each pinned line and the asked words only on asked pins')
const modelReplace = retainItems([{ content: 'handover rule: deploy on Thursdays', replaces: `seq:${seqIn('handover rule: deploy on Wednesdays')}` }], { session: 'lead-session' }, crewDir)
_resetMemoryVerbSessionStateForTesting()
maybeConsolidate({ force: true, dir: crewDir, now: new Date(T0.getTime() + 1000) })
check("the model's own replacement of a plain pin is stored and the pin follows it without an asked mark — the model's words are not the owner's", modelReplace[0]?.status === 'stored' && readPins(crewDir).some(p => p.seq === seqIn('handover rule: deploy on Thursdays') && p.asked === undefined) && !readPins(crewDir).some(p => p.seq === seqIn('handover rule: deploy on Wednesdays')), JSON.stringify({ modelReplace, pins: readPins(crewDir) }), 'the replacement step in src/sessions/mneme/mnemeConsolidate.ts must move a plain pin to the model replacement without an asked mark')
const crewCorrect = correctMemory({ op: 'supersede', id: `seq:${seqIn('handover rule: deploy on Thursdays')}`, content: 'handover rule: deploy on Fridays', reason: 'the lead revised the intake rule', session: 'lead-session' }, crewDir)
check("a rule pinned without the owner asking stays correctable by the model — it was never the owner's", crewCorrect.ok, JSON.stringify(crewCorrect), 'correctMemory in src/sessions/mneme/memoryVerbs.ts must refuse only rules whose pin is marked asked')
_resetMemoryVerbSessionStateForTesting()

section('the automatic lookup: up to five facts, pointing at the pages, never a loaded pin')
const hits = lookupFacts('how is the runtime deployed from the checkout', { dir })
check('the deploy facts come back first', hits.length >= 1 && hits[0]!.slug === 'deploy', JSON.stringify(hits.map(h => [h.slug, h.score])), 'lookupFacts in src/sessions/mneme/mnemeLookup.ts must rank the deploy topic facts first for this question')
check('a hit points at its topic page', hits.every(h => h.pagePath.endsWith('.md') || h.pending), '', 'lookupFacts in src/sessions/mneme/mnemeLookup.ts must set pagePath to the topic page file of each hit')
check('no pinned rule is attached (they are all in the prompt)', hits.every(h => !readPins(dir).some(p => p.seq === h.seq)), '', 'lookupFacts in src/sessions/mneme/mnemeLookup.ts must skip facts that are pinned')
const excluded = lookupFacts('how is the runtime deployed from the checkout', { dir, exclude: new Set(hits.map(h => h.id)) })
check('an already-surfaced fact is not attached twice', excluded.every(h => !hits.some(x => x.id === h.id)), '', 'lookupFacts in src/sessions/mneme/mnemeLookup.ts must drop every id in the exclude set')
const many = rankCandidates('thing', Array.from({ length: 12 }, (_, i) => ({ id: `seq:${i}`, text: `always do thing ${i}`, signature: '', slug: 'rules', pagePath: 'p', seq: i, pending: false })))
check('a word every fact shares never ranks (nothing discriminating)', many.length === 0, '', 'rankCandidates in src/sessions/mneme/mnemeLookup.ts must return no hit for a word every candidate shares')
const dense = rankCandidates('where does the smoke build write its log', [
  { id: 'seq:1', text: 'the smoke build writes its log to build/smoke/lantern.log', signature: '', slug: 'project', pagePath: 'p', seq: 1, pending: false },
  { id: 'seq:2', text: `the packager tars bin/ and share/ into dist/, writes dist/SHA256SUMS, refuses to pack when the tree is dirty, and its smoke scenario runs the build end to end; ${'the summary names the slowest step first and the owner row in MAINTAINERS.md; '.repeat(8)}its log lines carry the prefix pack:`, signature: '', slug: 'project', pagePath: 'p', seq: 2, pending: false },
  { id: 'seq:3', text: 'the formatter rewrites src in place', signature: '', slug: 'project', pagePath: 'p', seq: 3, pending: false },
])
check('a short fact made of the question\'s words outranks a long fact that mentions them in passing', dense.length === 2 && dense[0]!.id === 'seq:1', JSON.stringify(dense.map(h => [h.id, h.score.toFixed(2)])), 'rankCandidates in src/sessions/mneme/mnemeLookup.ts must score a short fact made of the question words above a long fact that mentions them in passing')
check('the cap is five', lookupFacts('handle the careful way and say so in the report', { dir, exclude: new Set() }).length <= 5, '', 'lookupFacts in src/sessions/mneme/mnemeLookup.ts must return at most five hits')
check('a pending fact is findable before consolidation', lookupFacts('fact retained after the snapshot', { dir }).some(h => h.pending || h.slug === 'later'))

section('archive: facts nobody has used in a long time leave the index, nothing is lost')
const before = seqCensus([...listTopicDocs(dir), ...listArchiveDocs(dir)])
const later = new Date(Math.max(T0.getTime(), Date.now()) + (ARCHIVE_AFTER_DAYS + 10) * 24 * 60 * 60 * 1000)
mkdirSync(dir, { recursive: true })
appendFileSync(join(dir, 'current.jsonl'), JSON.stringify({ ts: later.toISOString(), source: 'proof', text: 'a brand-new fact keeps its topic warm', topicHint: 'fresh' }) + '\n')
const c3 = maybeConsolidate({ force: true, dir, now: later })
check('the tidy-up archived cold facts', (c3.tidy?.archived ?? 0) > 0, JSON.stringify(c3.tidy), 'tidyLibrary in src/sessions/mneme/mnemeArchive.ts must archive facts unused for ARCHIVE_AFTER_DAYS in the same file')
check('the checker confirms conservation', c3.tidy?.conserved === true, '', 'tidyLibrary in src/sessions/mneme/mnemeArchive.ts must keep every seq across topic and archive pages')
const after = seqCensus([...listTopicDocs(dir), ...listArchiveDocs(dir)])
const freshSeq = listTopicDocs(dir).find(d => d.slug === 'fresh')!.sections[0]!.entries[0]!.seq
check('every seq is still in the library (archive included), plus the new one', after === [...before.split(',').map(Number), freshSeq].sort((a, b) => a - b).join(','))
check('the pinned rules were not archived', listArchiveDocs(dir).every(d => !d.sections.some(s => s.entries.some(e => readPins(dir).some(p => p.seq === e.seq)))))
check('an archive page exists off the index', existsSync(join(dir, 'archive-deploy.md')) && !/^- deploy\b/m.test((readFrontPage(dir) ?? '').split('## Pinned')[0]!))
check('the front page counts the archived facts', /\d+ facts? not used in a long time sit in archive pages/.test(readFrontPage(dir) ?? ''))
const archivedRecall = recallQuery('deploy-runtime', { dir })
check('Recall still finds an archived fact and labels it', archivedRecall.hits.some(h => h.label === 'archived'), JSON.stringify(archivedRecall.hits.map(h => h.label)), 'recallQuery in src/sessions/mneme/memoryVerbs.ts must search archive pages and label those hits archived')
const archivedSeq = archivedRecall.hits.find(h => h.label === 'archived')?.id.replace('seq:', '')
bumpUsage([Number(archivedSeq)], dir, later)
const c4 = maybeConsolidate({ force: true, dir, now: new Date(later.getTime() + 1000) })
check('a used archived fact is restored to its topic at the next tidy-up', (c4.tidy?.restored ?? 0) >= 1 && listTopicDocs(dir).some(d => d.slug === 'deploy'), JSON.stringify(c4.tidy), 'tidyLibrary in src/sessions/mneme/mnemeArchive.ts must restore an archived fact to its topic once bumpUsage in src/sessions/mneme/mnemeUsage.ts has marked it used')

section('the index has a fixed size: splitting and archiving keep it under, nobody is asked')
const dir2 = join(scratch, 'library-wide')
for (let i = 0; i < INDEX_LIMIT + 5; i++) {
  appendObservation({ text: `fact for topic ${i}`, source: 'proof', topicHint: `topic-${String(i).padStart(2, '0')}` }, dir2)
}
const wide = maybeConsolidate({ force: true, dir: dir2, now: T0 })
check('the batch landed', wide.consolidated, wide.reason, 'a forced maybeConsolidate in src/sessions/mneme/mnemeConsolidate.ts must land the wide batch')
const wideIndexLines = (readFrontPage(dir2) ?? '').split('\n').filter(l => /^- /.test(l))
check(`the index holds at most ${INDEX_LIMIT} topic lines`, wideIndexLines.length <= INDEX_LIMIT, String(wideIndexLines.length), 'tidyLibrary in src/sessions/mneme/mnemeArchive.ts must archive whole cold topics until the index holds at most INDEX_LIMIT lines')
check('whole cold topics went to the archive', (wide.tidy?.topicsArchived.length ?? 0) >= 5 && wide.tidy?.conserved === true, JSON.stringify(wide.tidy), 'tidyLibrary in src/sessions/mneme/mnemeArchive.ts must report the topics it archived and conserve every seq')
check('no fact was lost to the index limit', seqCensus([...listTopicDocs(dir2), ...listArchiveDocs(dir2)]).split(',').length === INDEX_LIMIT + 5, '', 'tidyLibrary in src/sessions/mneme/mnemeArchive.ts must move facts to archive pages, never delete them')

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
check('a page over the size limit split into two', split.consolidated && existsSync(join(dir3, 'topic-big-2.md')), JSON.stringify(split.docsTouched), 'maybeConsolidate in src/sessions/mneme/mnemeConsolidate.ts must split a page over MAX_DOC_TOKENS (src/sessions/mneme/mnemeTopicDocs.ts) through splitDoc')
const bigLines = (readFrontPage(dir3) ?? '').split('\n').filter(l => /^- big\b/.test(l))
check('the index shows the split pages under ONE topic line', bigLines.length === 1 && bigLines[0]!.includes('2 pages: big, big-2'), bigLines.join(' | '), 'renderFrontPage in src/sessions/mneme/mnemeFrontPage.ts must print split pages under one topic line, grouped by indexTopics in src/sessions/mneme/mnemeArchive.ts')
const { splitDoc, emptyDoc } = await import('../../src/sessions/mneme/mnemeTopicDocs.js')
const { indexTopics } = await import('../../src/sessions/mneme/mnemeArchive.js')
const grown = emptyDoc('big-2', 'big (split)', T0.toISOString())
grown.sections.push({ heading: 'notes', entries: Array.from({ length: 60 }, (_, i) => ({ text: `${long} more ${i}`, seq: 1000 + i, time: T0.toISOString(), source: 'proof' })) })
const second = splitDoc(grown, T0.toISOString(), new Set(['big', 'big-2']))
check('a split page that splits again is named from the base topic, not big-2-2', second !== null && second[1].slug === 'big-3', JSON.stringify(second?.map(d => d.slug)), 'splitDoc in src/sessions/mneme/mnemeTopicDocs.ts must name the new page from the base topic, not from the split page')
const grouped = second ? indexTopics([listTopicDocs(dir3).find(d => d.slug === 'big')!, second[0], second[1]]) : new Map()
check('the index keeps the three pages under the one topic line', grouped.size === 1 && grouped.get('big')?.map(d => d.slug).join(',') === 'big,big-2,big-3', JSON.stringify([...grouped.entries()].map(([k, v]) => [k, v.map(d => d.slug)])), 'indexTopics in src/sessions/mneme/mnemeArchive.ts must group the base page and its split pages under one topic')


console.log('\n' + '═'.repeat(76))
console.log(failures === 0 ? '✅ FRONT PAGE, PINNED TIER, LOOKUP AND ARCHIVE PROVEN' : `❌ ${failures} FRONT-PAGE CHECK(S) FAILED`)
console.log('═'.repeat(76))
void publishFrontPage
process.exit(failures === 0 ? 0 : 1)
