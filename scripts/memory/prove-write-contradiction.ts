#!/usr/bin/env bun

;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0', PACKAGE_URL: 'https://example.invalid/mercury' }
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-write-guard-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_DESKTOP_DRIVER = 'none'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
for (const key of ['MERCURY_HOME', 'MERCURY_BARE', 'TYPESAFE_API_KEY', 'NODE_ENV', 'https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY']) delete process.env[key]

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)

writeFileSync(join(HOME, '.mercury.json'), JSON.stringify({ hasCompletedOnboarding: true, numStartups: 3 }))
const { startJevStandin } = await import('../jev/lib/jevStandin.ts')
const standin = await startJevStandin()
process.env.MERCURY_JEV_BASE = standin.base

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const guard = await import('../../src/mneme/mnemeContradiction.ts')
const { retainItems, retainItemsJudged, correctMemory, correctMemoryJudged, readMemoryRecord, _resetMemoryVerbSessionStateForTesting } = await import('../../src/mneme/memoryVerbs.ts')
const { appendObservation, pendingRows } = await import('../../src/mneme/mnemeBuffer.ts')
const { maybeConsolidate, listTopicDocs } = await import('../../src/mneme/mnemeConsolidate.ts')
const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.ts')
const { pinFact, readPins, pinsPath } = await import('../../src/mneme/mnemeUsage.ts')
const { docFileName } = await import('../../src/mneme/mnemeTopicDocs.ts')
const { USER_ASKED_RULE_ROAD } = await import('../../src/mneme/mnemeCorrect.ts')
const { RetainTool, CorrectTool } = await import('../../src/tools/MemoryTools/MemoryTools.ts')
const { conflictLines } = await import('../../src/tools/MemoryTools/UI.tsx')
const { RETAIN_PROMPT } = await import('../../src/tools/MemoryTools/prompt.ts')
const { setJevEnabled } = await import('../../src/services/jev/jevSetting.ts')
const { storeJevApiKey } = await import('../../src/services/jev/jevKey.ts')
const { jevLedgerSnapshot, resetJevLedger } = await import('../../src/services/jev/jevLedger.ts')

const dir = mnemeLibraryDir()

section('§1 the polarity list is small, named and proven; overlap alone never makes a candidate')
check('the share is three of every four content words of the shorter statement; the Jev floor is the study\'s 0.6', guard.CONTRADICTION_OVERLAP_SHARE === 0.75 && guard.CONTRADICTION_CONFIDENCE === 0.6)
check('the polarity pairs are the named seven', guard.POLARITY_PAIRS.map(p => p.name).join(' · ') === 'always/never · on/off · enabled/disabled · allowed/forbidden · included/excluded · before/after · true/false', guard.POLARITY_PAIRS.map(p => p.name).join(' · '))
check('the negation words are the named eight', guard.NEGATION_WORDS.join(' ') === 'not never no none nothing neither nor without', guard.NEGATION_WORDS.join(' '))
const TRUE: Array<[string, string, string]> = [
  ['always use bun for installs', 'never use bun for installs', 'a negation'],
  ['the advisor is on by default', 'the advisor is off by default', 'on/off'],
  ['run the suites in parallel', 'do not run the suites in parallel', 'a negation'],
  ['the handoff ask budget is 120 seconds', 'the handoff ask budget is 60 seconds', 'a number that differs'],
  ['thinking is enabled for every lane', 'thinking is disabled for every lane', 'enabled/disabled'],
  ['commit messages carry the attribution trailer', 'commit messages never carry the attribution trailer', 'a negation'],
  ['run the tests before the commit', 'run the tests after the commit', 'before/after'],
  ['push to main is allowed after the checks', 'push to main is forbidden after the checks', 'allowed/forbidden'],
  ['memory.enabled is true in the owner home', 'memory.enabled is false in the owner home', 'true/false'],
  ['deploy with the flag', 'deploy without the flag', 'a negation'],
  ['the worktree is included in the pool', 'the worktree is excluded from the pool', 'included/excluded'],
]
const FALSE: Array<[string, string, string]> = [
  ['always use bun for installs', 'use bun for every install, always', 'the same rule restated'],
  ['never push without asking', 'do not push without asking first', 'restated, both sides negated'],
  ['never push to main', 'always push the tags after a release', 'different things sharing a word'],
  ['never commit directly to main', 'a hotfix may go directly to main when the owner says so', 'a rule and its exception'],
  ['never commit directly to main', 'commit directly to main only for a hotfix', 'a rule and its exception (only)'],
  ['always use bun', 'never use npm', 'two consistent rules'],
  ['rule 12: run the suites in parallel', 'rule 43: run the suites in parallel', 'identifiers are not quantities'],
  ['the box has 15 cores and 48 GB', 'the box has 15 cores', 'a subset of the numbers'],
  ['Prefix build, deploy, and proof commands with cd mercury-working', 'Verify directory HEAD before building or deploying', 'the same topic, no flip'],
  ['the lead folds; a lane never merges', 'the lead folds the lanes after the wave checks read green', 'a longer restatement'],
  ['Report in plain English without internal test names', 'Keep exact test names and paths in records for verification', 'two rules about names, no flip'],
  ['the release is 1.0.0-beta.34', 'the next release is 1.0.0-beta.35 after the fold', 'numbers differ but the frame differs too'],
  ['Never TaskStop background Bash tasks; kill one pid instead', 'Never edit a running script; write the replacement to a new file', 'two rules of one shelf'],
]
console.log('  expected · outcome · overlap · flip · pair')
let falsePositives = 0
for (const [old, fresh, flip] of TRUE) {
  const found = guard.contradictionBetween(fresh, old)
  console.log(`  TRUE  · ${found ? 'candidate' : 'missed   '} · ${found ? found.overlap.toFixed(2) : '-'} · ${found?.flip ?? '-'} · "${old}" / "${fresh}"`)
  check(`a true contradiction is a candidate with the flip named (${flip})`, found !== null && found.flip === flip, j(found))
}
for (const [old, fresh, why] of FALSE) {
  const found = guard.contradictionBetween(fresh, old)
  if (found !== null) falsePositives++
  console.log(`  FALSE · ${found ? 'FALSE+   ' : 'clear    '} · ${found ? found.overlap.toFixed(2) : '-'} · ${found?.flip ?? '-'} · "${old}" / "${fresh}"`)
  check(`no candidate: ${why}`, found === null, j(found))
}
check('the table has no false positive', falsePositives === 0, String(falsePositives))
check('the number flip needs the same frame on both sides: a differing number inside a longer sentence is no candidate', guard.contradictionBetween('the budget is 60 seconds for the exit road and the turn road alike', 'the budget is 120 seconds') === null)
check('a negated side clause is not a flip when the negated word is not shared', guard.contradictionBetween('run the suites one at a time, never in parallel', 'run the screen suites one slot at a time') === null)
check('a flat negation of a rule with a trailing clause is a candidate (the share is of the shorter side)', guard.contradictionBetween('do not run the suites in parallel', 'run the suites in parallel and batch the ready lanes together')?.flip === 'a negation')
check('only as an adverb is not an exception marker; only for/when/if is', guard.contradictionBetween('never use bun', 'the lockfile only resolves under bun; always use bun') !== null && guard.contradictionBetween('use npm only for the docs site', 'never use npm') === null)

section('§2 the no-Jev road: a fact that contradicts a record is refused whole with the record named; nothing lands beside its opposite')
const seeds = [
  'always use bun for installs; the lockfile only resolves under bun',
  'run the suites in parallel and batch the ready lanes together',
  'the handoff ask budget is 120 seconds',
]
for (const text of seeds) appendObservation({ text, source: 'operator', topicHint: 'rules' }, dir)
check('the seed batch consolidated', maybeConsolidate({ force: true, dir }).consolidated)
const rulesDoc = listTopicDocs(dir).find(d => d.slug === 'rules')!
const entries = rulesDoc.sections.flatMap(s => s.entries)
const bunSeq = entries.find(e => e.text.startsWith('always use bun'))!.seq
const suitesSeq = entries.find(e => e.text.startsWith('run the suites'))!.seq
const budgetSeq = entries.find(e => e.text.startsWith('the handoff'))!.seq
pinFact(bunSeq, dir, new Date(), { asked: true })
const rulesPath = join(dir, docFileName('rules'))
const docBefore = readFileSync(rulesPath, 'utf8')
const pinsBefore = readFileSync(pinsPath(dir), 'utf8')
const pendingBefore = pendingRows(dir).length
_resetMemoryVerbSessionStateForTesting()
const outcomes = retainItems(
  [
    { content: 'never use bun for installs' },
    { content: 'do not run the suites in parallel' },
    { content: 'the handoff ask budget is 60 seconds' },
    { content: 'use bun for every install, always' },
    { content: 'run the screen suites one slot at a time' },
  ],
  { session: 'write-guard-proof' },
  dir,
)
const [againstRule, againstFact, againstNumber, restated, unrelated] = outcomes
check('the fact against the pinned rule is refused', againstRule?.status === 'refused', j(againstRule))
const ruleReason = againstRule?.status === 'refused' ? againstRule.reason : ''
check(`the reason names the rule by number and its first words and sends the model to the user's road`, ruleReason.startsWith(`conflicts with rule ${bunSeq}: "always use bun for installs; the lockfile only…"`) && ruleReason.includes(USER_ASKED_RULE_ROAD), ruleReason)
check('the fact against a plain fact is refused with the user\'s call named, and the advice never says supersede', againstFact?.status === 'refused' && againstFact.reason.startsWith(`conflicts with fact ${suitesSeq}: "run the suites in parallel and batch the…"`) && againstFact.reason.includes(`ask the user which is true; on their word, Correct seq:${suitesSeq} with their reason, or retain both with the difference stated (when, where, which)`) && !againstFact.reason.includes('supersede') && !againstFact.reason.includes('evidence'), j(againstFact))
check('the differing number is refused', againstNumber?.status === 'refused' && againstNumber.reason.startsWith(`conflicts with fact ${budgetSeq}:`), j(againstNumber))
check('the restated rule is stored (overlap alone is never a conflict)', restated?.status === 'stored', j(restated))
check('an unrelated fact sharing words is stored', unrelated?.status === 'stored', j(unrelated))
check('exactly the two honest facts landed in the buffer', pendingRows(dir).length === pendingBefore + 2, `${pendingBefore} → ${pendingRows(dir).length}`)
check('the pinned rule is byte-identical on disk and its pin untouched', readFileSync(rulesPath, 'utf8') === docBefore && readFileSync(pinsPath(dir), 'utf8') === pinsBefore)
check('the refused words are nowhere on disk', !readFileSync(rulesPath, 'utf8').includes('never use bun') && !pendingRows(dir).some(r => r.text.includes('never use bun') || r.text.includes('60 seconds')))
const block = RetainTool.mapToolResultToToolResultBlockParam({ outcomes, stored: 2, refused: 3 }, 'tid')
const content = String(block.content)
check('the tool result carries each refusal with the fact NOT stored', content.startsWith('2 stored · 3 refused') && content.includes(`REFUSED — conflicts with rule ${bunSeq}:`) && content.includes('(the fact was NOT stored)'), content.slice(0, 300))
const lines = conflictLines(outcomes)
console.log(`  the user's lines:\n    ${lines.join('\n    ')}`)
check('one line reaches the user per conflict, in plain words', lines.length === 3 && lines[0] === `not stored: it conflicts with rule ${bunSeq}, "always use bun for installs; the lockfile only…" — the rule stands` && lines[1] === `not stored: it conflicts with fact ${suitesSeq}, "run the suites in parallel and batch the…"`, j(lines))
check('the user\'s lines carry no code, no id and no percentage', lines.every(line => !/seq:|pending:|%|\d\.\d/.test(line)), j(lines))
check('the Retain prompt tells the model the refusal, that a contradiction is the user\'s call, and the two roads on their word', RETAIN_PROMPT.includes('refused whole, naming the record it conflicts with') && RETAIN_PROMPT.includes("A contradiction is the user's call: tell them the conflict in one line and ask which is true; never Correct the record on a contradiction refusal without their word in the same conversation.") && RETAIN_PROMPT.includes('On their word, Correct the old one with their reason and retain again, or retain both with the difference stated') && RETAIN_PROMPT.includes("a pinned rule is the user's to change"))

section('§3 a pending row is on record too; an item that replaces a rule is judged against everything but that rule')
_resetMemoryVerbSessionStateForTesting()
const pendingPair = retainItems([{ content: 'the daemon restarts after an update' }, { content: 'the daemon never restarts after an update' }], { session: 'write-guard-proof' }, dir)
check('the second item of a batch is refused against the first, now a pending fact', pendingPair[0]?.status === 'stored' && pendingPair[1]?.status === 'refused' && pendingPair[1].reason.startsWith('conflicts with a pending fact: "the daemon restarts after an update"'), j(pendingPair))
check('the user\'s line for a pending fact', conflictLines(pendingPair)[0] === 'not stored: it conflicts with a pending fact, "the daemon restarts after an update"', j(conflictLines(pendingPair)))
_resetMemoryVerbSessionStateForTesting()
const replacing = retainItems([{ content: 'run the suites one at a time, never in parallel', replaces: `seq:${suitesSeq}` }], { session: 'write-guard-proof' }, dir)
check('a replacement is not refused against the rule it replaces', replacing[0]?.status === 'stored', j(replacing))

section('§4 the Jev road: only the candidates are judged, one closed question each; under 0.6 the fact is stored, at or above it is refused; Jev off or unready means the lexical verdict')
check('Jev off: the judge road is closed and the lexical filter decides', guard.jevJudgeOpen() === false)
const asked: Array<{ existing: string; candidate: string }> = []
const scripted: ContradictionJudgeScore = { 'the advisor is off by default': 0.3, 'never use bun for installs': 0.9 }
type ContradictionJudgeScore = Record<string, number>
const fixtureJudge = async (pairs: ReadonlyArray<{ existing: string; candidate: string }>) => {
  asked.push(...pairs)
  return pairs.map(pair => scripted[pair.candidate] ?? null)
}
appendObservation({ text: 'the advisor is on by default', source: 'operator', topicHint: 'rules' }, dir)
check('the advisor fact consolidated', maybeConsolidate({ force: true, dir }).consolidated)
_resetMemoryVerbSessionStateForTesting()
const judged = await retainItemsJudged(
  [{ content: 'the advisor is off by default' }, { content: 'never use bun for installs' }, { content: 'the memory page lists every topic' }],
  { session: 'write-guard-proof' },
  { dir, judge: fixtureJudge },
)
check('the judge saw only candidates, each paired with the record it meets (the bun fact meets the rule and the restated pending row)', asked.length === 3 && asked.every(p => p.candidate !== 'the memory page lists every topic') && asked.some(p => p.candidate === 'the advisor is off by default' && p.existing === 'the advisor is on by default') && asked.some(p => p.candidate === 'never use bun for installs' && p.existing.startsWith('always use bun')), j(asked))
check('the candidate Jev read as unsure (0.3) is stored; the one at 0.9 is refused; the non-candidate never went to Jev', judged[0]?.status === 'stored' && judged[1]?.status === 'refused' && judged[2]?.status === 'stored', j(judged))
check('contradictionHolds is the 0.6 floor', guard.contradictionHolds({ candidate: judged[1]!.status === 'refused' ? judged[1].conflict! : (null as never), judged: 0.6 }) && !guard.contradictionHolds({ candidate: judged[1]!.status === 'refused' ? judged[1].conflict! : (null as never), judged: 0.59 }))

section('§5 the Jev wire: one noul question per candidate on the stand-in, counted in the ledger')
setJevEnabled(true)
storeJevApiKey('proof-key-jev-not-a-real-key-0035')
resetJevLedger()
standin.reset()
check('Jev on with a key: the judge road is open', guard.jevJudgeOpen() === true)
standin.answerWith((body: unknown) => {
  const state = (body as { state?: { candidate?: string } }).state
  return { model: 'jev-1.13.0', answers: { contradicts: { type: 'noul', noul: state?.candidate?.startsWith('never') ? 0.88 : 0.12 } }, usage: { input_tokens: 400, output_tokens: 10 } }
})
_resetMemoryVerbSessionStateForTesting()
const wired = await retainItemsJudged(
  [{ content: 'never run the suites in parallel' }, { content: 'the handoff ask budget is 90 seconds' }],
  { session: 'write-guard-proof' },
  { dir },
)
const request = standin.received[0]?.body as { model?: string; state?: Record<string, string>; questions?: Record<string, { type?: string; instructions?: string }> } | undefined
check('two requests reached Jev, one per candidate', standin.received.length === 2, String(standin.received.length))
check('each request carries the pair as its state and one noul question', request?.state?.candidate !== undefined && request?.state?.existing !== undefined && request?.questions?.contradicts?.type === 'noul' && (request.questions.contradicts.instructions ?? '').includes('both cannot be true'), j(request))
check('the request rides the pinned model on the official road', request?.model === 'jev-1.13.0', j(request?.model))
check('Jev at 0.88 refuses; Jev at 0.12 stores the fact the lexical filter had caught', wired[0]?.status === 'refused' && wired[1]?.status === 'stored', j(wired))
check('both calls are counted in the Jev ledger', jevLedgerSnapshot().attempts === 2, j(jevLedgerSnapshot()))
standin.answerWith(undefined)
standin.next({ status: 500, body: { error: { message: 'fixture down' } } })
_resetMemoryVerbSessionStateForTesting()
const down = await retainItemsJudged([{ content: 'the advisor is off by default' }], { session: 'write-guard-proof' }, { dir })
check('Jev down: the lexical verdict stands (refused), nothing stored beside its opposite', down[0]?.status === 'refused', j(down))
setJevEnabled(false)
storeJevApiKey(null)

section('§6 Correct\'s amend goes through the same guard; the Memory Centre\'s own corrections and the hand-over import do not')
readMemoryRecord(`seq:${budgetSeq}`, dir)
const amendConflict = correctMemory({ op: 'amend', id: `seq:${budgetSeq}`, content: 'the advisor is off by default', reason: 'proof', session: 'write-guard-proof' }, dir)
check('an amend whose new wording contradicts another record is refused with code conflict', !amendConflict.ok && amendConflict.code === 'conflict' && amendConflict.message.startsWith('amend refused: the new wording conflicts with fact'), j(amendConflict))
const amendOwn = correctMemory({ op: 'amend', id: `seq:${budgetSeq}`, content: 'the handoff ask budget is 120 seconds (two minutes)', reason: 'proof', session: 'write-guard-proof' }, dir)
check('an amend that keeps its own meaning is not judged against the row it amends', amendOwn.ok === true, j(amendOwn))
const amendJudged = await correctMemoryJudged({ op: 'amend', id: `seq:${suitesSeq}`, content: 'the advisor is off by default', reason: 'proof', session: 'write-guard-proof' }, { dir, judge: async pairs => pairs.map(() => 0.2) })
check('the judged amend road: Jev unsure means the amend is refused only by the evidence rule, never by the guard', !amendJudged.ok && amendJudged.code === 'unseen-evidence', j(amendJudged))
const correctBlock = CorrectTool.mapToolResultToToolResultBlockParam(amendConflict, 'tid')
check('the Correct tool result names the conflict', String(correctBlock.content).includes('amend refused (conflict): amend refused: the new wording conflicts with fact'), String(correctBlock.content))
_resetMemoryVerbSessionStateForTesting()
const imported = retainItems([{ content: 'never use bun for installs' }], { session: 'handover', source: 'handover:old-notes', pin: false }, dir, { guard: 'off' })
check('with the guard off (the hand-over import) the row lands as today', imported[0]?.status === 'stored', j(imported))
const handover = readFileSync(join(import.meta.dir, '..', '..', 'src', 'mneme', 'mnemeHandover.ts'), 'utf8')
check('the hand-over import passes the guard off', /retainItems\([\s\S]*?\{ guard: 'off' \},?\s*\)/.test(handover))

section('§7 numbers belong to one subject, not every fact with the same words')
const drawerFact = (n: number): string => `Scratch filler fact number ${n}: the scratch drawer ${n} holds ${n} spoons.`
const drawerFacts = Array.from({ length: 20 }, (_, i) => drawerFact(i + 1))
for (let i = 0; i < drawerFacts.length; i++) {
  check(`drawer ${i + 1} conflicts with no other drawer`, drawerFacts.every(other => guard.contradictionBetween(drawerFacts[i]!, other) === null))
}
const quantityPairs: Array<[string, string]> = [
  ['the server has 8 cores', 'the server has 16 cores'],
  ['the server has 8 cores', 'the server has 9 cores'],
  ['drawer 10 holds 8 spoons', 'drawer 10 holds 16 spoons'],
  ['the cellar has 3 shelves', 'the cellar has 5 shelves'],
  ['the deploy runs from mercury-36', 'the deploy runs from mercury-37'],
  ['the drawer holds 10 spoons and is red', 'the drawer holds 12 spoons and is red'],
]
for (const [old, fresh] of quantityPairs) {
  check(`a value about one subject still differs: ${fresh}`, guard.contradictionBetween(fresh, old)?.flip === 'a number that differs' && guard.contradictionBetween(old, fresh)?.flip === 'a number that differs')
}
const literalPairs: Array<[string, string]> = [
  ['the deploy runs from X', 'the deploy runs from Y'],
  ['the config lives in A', 'the config lives in B'],
  ['the config lives in run', 'the config lives in build'],
  ['the config lives in Paris', 'the config lives in Rome'],
  ['the deploy runs from X and is slow', 'the deploy runs from Y and is slow'],
]
for (const [old, fresh] of literalPairs) {
  check(`a location value about one subject differs: ${fresh}`, guard.contradictionBetween(fresh, old)?.flip === 'a value that differs' && guard.contradictionBetween(old, fresh)?.flip === 'a value that differs')
}
const subjectPairs: Array<[string, string]> = [
  ['drawer 10 holds 10 spoons', 'drawer 11 holds 11 spoons'],
  ['drawer 10 holds 10 spoons', 'drawer 11 holds 10 spoons'],
  ['drawer 10 holds spoons', 'drawer 11 holds spoons'],
  ['the blue server has 16 cores', 'the red server has 32 cores'],
  ['step 1 is open', 'step 2 is open'],
  ['step 1 is done', 'step 2 is done'],
  ['item 3 is open', 'item 4 is open'],
  ['the server A has 8 cores', 'the server B has 16 cores'],
  ['the deploy from X runs daily', 'the deploy from Y runs daily'],
  ['the config in A lives here', 'the config in B lives here'],
  ...['seq', 'rule', 'issue', 'pr', 'step'].map(marker => [`${marker} 41 is open`, `${marker} 42 is open`] as [string, string]),
]
for (const [old, fresh] of subjectPairs) {
  check(`an identifier is not a changed value: ${fresh}`, guard.contradictionBetween(fresh, old) === null && guard.contradictionBetween(old, fresh) === null)
  const pairDir = mkdtempSync(join(HOME, 'distinct-subjects-'))
  _resetMemoryVerbSessionStateForTesting()
  const result = await retainItemsJudged([{ content: old }, { content: fresh }], { session: 'distinct-subjects' }, { dir: pairDir, judge: null })
  check(`both distinct facts are stored: ${fresh}`, result.every(outcome => outcome.status === 'stored') && pendingRows(pairDir).length === 2, j(result))
}
_resetMemoryVerbSessionStateForTesting()
const batchResult = await RetainTool.call({ items: drawerFacts.map(content => ({ content })) }, { messages: [{ type: 'user', uuid: 'drawer-ask', timestamp: '2026-10-19T09:00:00.000Z', message: { role: 'user', content: 'Remember these twenty drawer facts exactly as I give them.' } }] } as never, undefined as never, undefined as never)
check('one real Retain call stores all twenty exact drawer facts', 'data' in batchResult && batchResult.data.stored === 20 && batchResult.data.refused === 0, j(batchResult))
check('all twenty drawer facts read back verbatim from pending rows', drawerFacts.every(text => pendingRows(dir).some(row => row.text === text)))
if ('data' in batchResult) {
  check('the tool result says twenty stored and has no refusal', String(RetainTool.mapToolResultToToolResultBlockParam(batchResult.data, 'drawers').content).startsWith('20 stored · 0 refused'))
  check('no false conflict line reaches the user', conflictLines(batchResult.data.outcomes).length === 0)
}
const sequentialDir = mkdtempSync(join(HOME, 'sequential-'))
for (let n = 1; n <= 12; n++) {
  _resetMemoryVerbSessionStateForTesting()
  const result = await retainItemsJudged([{ content: drawerFact(n) }], { session: `drawer-${n}` }, { dir: sequentialDir, judge: null })
  check(`fresh Retain session ${n} stores its drawer`, result[0]?.status === 'stored', j(result))
}
check('the twelve separate Retains each wrote the exact fact', pendingRows(sequentialDir).length === 12 && drawerFacts.slice(0, 12).every(text => pendingRows(sequentialDir).some(row => row.text === text)))
const libraryDir = mkdtempSync(join(HOME, 'library-subjects-'))
appendObservation({ text: drawerFact(10), source: 'operator', topicHint: 'drawers' }, libraryDir)
appendObservation({ text: 'the server has 8 cores', source: 'operator', topicHint: 'servers' }, libraryDir)
check('the subject seeds consolidated to the library', maybeConsolidate({ force: true, dir: libraryDir }).consolidated)
check('the library has no candidate for another drawer', guard.contradictionCandidates(drawerFact(11), libraryDir).length === 0)
const serverEntry = guard.recordEntries(libraryDir).find(entry => entry.text === 'the server has 8 cores')!
_resetMemoryVerbSessionStateForTesting()
const mixed = await retainItemsJudged([
  { content: drawerFact(11) },
  { content: 'the server has 16 cores' },
  { content: drawerFact(12) },
], { session: 'mixed-subjects' }, { dir: libraryDir, judge: null })
check('the mixed batch refuses only the true conflict and names its library record', mixed[0]?.status === 'stored' && mixed[1]?.status === 'refused' && mixed[1].conflict?.entry.id === serverEntry.id && mixed[2]?.status === 'stored', j(mixed))
check('only the two distinct drawer facts reached pending rows', pendingRows(libraryDir).length === 2 && !pendingRows(libraryDir).some(row => row.text === 'the server has 16 cores'))
const sameSubjectDir = mkdtempSync(join(HOME, 'same-subject-'))
for (const [old, fresh] of [...quantityPairs, ...literalPairs, ['always use bun for installs', 'never use bun for installs'], ['the advisor is on by default', 'the advisor is off by default'], ['run the suites in parallel', 'do not run the suites in parallel']] as Array<[string, string]>) {
  const pairDir = mkdtempSync(join(sameSubjectDir, 'pair-'))
  _resetMemoryVerbSessionStateForTesting()
  const result = await retainItemsJudged([{ content: old }, { content: fresh }], { session: 'same-subject' }, { dir: pairDir, judge: null })
  check(`the real conflict still refuses against its pending record: ${fresh}`, result[0]?.status === 'stored' && result[1]?.status === 'refused' && result[1].conflict?.entry.id === result[0].id, j(result))
}
const judgedSubjects: Array<{ existing: string; candidate: string }> = []
_resetMemoryVerbSessionStateForTesting()
const subjectVerdicts = await retainItemsJudged([{ content: drawerFact(13) }, { content: 'the server has 16 cores' }], { session: 'judged-subjects' }, { dir: libraryDir, judge: async pairs => { judgedSubjects.push(...pairs); return pairs.map(() => 0.9) } })
check('the optional judge receives only the genuine same-subject candidate', judgedSubjects.length === 1 && judgedSubjects[0]?.existing === 'the server has 8 cores' && subjectVerdicts[0]?.status === 'stored' && subjectVerdicts[1]?.status === 'refused', j(judgedSubjects))

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log(`✅ WRITE CONTRADICTION GREEN (${checks} checks)`)
else console.log(`❌ WRITE CONTRADICTION RED (${failures} of ${checks} checks failed)`)
console.log('═'.repeat(76))
await standin.close()
process.exit(failures === 0 ? 0 : 1)
