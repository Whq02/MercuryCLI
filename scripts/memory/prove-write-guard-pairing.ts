#!/usr/bin/env bun

;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0', PACKAGE_URL: 'https://example.invalid/mercury' }
import { cpSync, existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-write-guard-pairing-')))
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
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const guard = await import('../../src/mneme/mnemeContradiction.ts')
const { contradictionBetween, contradictionCandidates, comparableLength, restates, conflictReason, conflictNotice, recordEntries, COMPARABLE_LENGTH_RATIO } = guard
const { retainItems, _resetMemoryVerbSessionStateForTesting } = await import('../../src/mneme/memoryVerbs.ts')
const { appendObservation, pendingRows } = await import('../../src/mneme/mnemeBuffer.ts')
const { maybeConsolidate } = await import('../../src/mneme/mnemeConsolidate.ts')
const { listTopicDocs, listArchiveDocs } = await import('../../src/mneme/mnemeLibrary.ts')
const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.ts')
const { pinFact, readPins } = await import('../../src/mneme/mnemeUsage.ts')
const { USER_ASKED_RULE_ROAD } = await import('../../src/mneme/mnemeCorrect.ts')
const { RETAIN_PROMPT } = await import('../../src/tools/MemoryTools/prompt.ts')

const stems = (n: number): Set<string> => new Set(Array.from({ length: n }, (_, i) => `w${i}`))

section('§1 the comparable-length ratio is named: the shorter unit carries at least two fifths of the longer one, and at least two content words')
check('the ratio is 0.4', COMPARABLE_LENGTH_RATIO === 0.4, String(COMPARABLE_LENGTH_RATIO))
check('three words against seven are comparable (a flat negation of a rule with a trailing clause)', comparableLength(stems(3), stems(7)))
check('four words against eleven are not (a short sentence inside a record against a long note)', !comparableLength(stems(4), stems(11)))
check('two against five sit on the edge and are comparable', comparableLength(stems(2), stems(5)))
check('one word is never comparable with anything', !comparableLength(stems(1), stems(2)))

section('§2 like with like: a sentence is measured against a sentence and a whole against a whole, never a record sentence against the whole candidate')
const RECORD_WITH_SHORT_SENTENCE = 'The run ended at midnight after the restart. The advisor is on for every lane. Logs go to the records folder beside the ledger.'
const LONG_NOTE = 'The advisor and the lane budget are off the table for this release because the owner wants the gate green first and the notes read.'
const shortAgainstLong = contradictionBetween(LONG_NOTE, RECORD_WITH_SHORT_SENTENCE)
check('a two-word sentence inside a record (on) does not make a long note that says off its contradiction', shortAgainstLong === null, j(shortAgainstLong))
check('nor the other way round', contradictionBetween(RECORD_WITH_SHORT_SENTENCE, LONG_NOTE) === null, j(contradictionBetween(RECORD_WITH_SHORT_SENTENCE, LONG_NOTE)))
const likeWithLike = contradictionBetween('The advisor is off for every lane.', RECORD_WITH_SHORT_SENTENCE)
check('the same flip as a whole sentence against that record sentence is a candidate (on/off at a full share)', likeWithLike?.flip === 'on/off' && likeWithLike.overlap === 1, j(likeWithLike))
const flatNegation = contradictionBetween('do not run the suites in parallel', 'run the suites in parallel and batch the ready lanes together')
check('three words against seven: the share is of the shorter side and the flat negation is a candidate', flatNegation?.flip === 'a negation' && flatNegation.overlap === 1, j(flatNegation))

section('§3 the negated word: a negation governs the content words of its clause (to the next comma, semicolon or and/but/or); the record flips it only when it says all of them without the negation')
const unsaid = contradictionBetween("Study data lives under the records folder, never in a lead's scratch.", 'The lead keeps study data under the records folder.')
check('"never in a lead\'s scratch" against a record that says lead but not "in a lead\'s scratch" is no flip', unsaid === null, j(unsaid))
const said = contradictionBetween("Study data lives under the records folder, never in a lead's scratch.", "The lead keeps study data in a lead's scratch under the records folder.")
check('against a record that does say "in a lead\'s scratch" it is a flip', said?.flip === 'a negation' && said.overlap >= 0.75, j(said))
check('an adverb moved inside the negated phrase is the same rule ("do not push without asking first" / "never push without asking")', contradictionBetween('do not push without asking first', 'never push without asking') === null)
const clauseBound = contradictionBetween('Do not run the suites in parallel, and batch the ready lanes together.', 'Run the suites in parallel.')
check('the clause ends at the comma: the words after it are not asked of the record, so the negation flips', clauseBound?.flip === 'a negation', j(clauseBound))
check('a negation whose governed words the record does not share is no flip ("never in parallel" against "one slot at a time")', contradictionBetween('run the suites one at a time, never in parallel', 'run the screen suites one slot at a time') === null)

section('§4 identity first: a candidate whose sentences are the record\'s own (or contain them) is a restatement, never a contradiction; a span under a negation is not')
const HISTORY_RULE = 'No planner seats sit between build and review. On the first day the lead built the program with planner seats between the build and the review tiers, and the owner cut them as slow.'
check('the same text with other punctuation and case restates its record', restates('no planner seats sit between build and review! On the first day the lead built the program with planner seats between the build and the review tiers, and the owner cut them as slow', HISTORY_RULE))
check('one of the record\'s own sentences restates it', restates('No planner seats sit between build and review.', HISTORY_RULE))
check('and is no contradiction, though the history sentence beside it says the seats once sat there', contradictionBetween('No planner seats sit between build and review.', HISTORY_RULE) === null, j(contradictionBetween('No planner seats sit between build and review.', HISTORY_RULE)))
check('a record that is its own candidate restates itself', restates(HISTORY_RULE, HISTORY_RULE) && contradictionBetween(HISTORY_RULE, HISTORY_RULE) === null)
check('a candidate that carries the record whole plus a sentence of its own restates it', restates(`${HISTORY_RULE} The fold runs after the reviewers.`, HISTORY_RULE))
check('"do not run the suites in parallel" does not restate "run the suites in parallel": the span sits under a negation', !restates('do not run the suites in parallel', 'run the suites in parallel') && contradictionBetween('do not run the suites in parallel', 'run the suites in parallel')?.flip === 'a negation')
check('an empty side never restates', !restates('', HISTORY_RULE) && !restates(HISTORY_RULE, '...'))

section('§5 the words: the refusal never says supersede; a contradiction is the user\'s call, and on their word the record is corrected with their reason or both facts kept with the difference stated')
const factEntry = { id: 'seq:7', seq: 7, kind: 'fact' as const, asked: false, text: 'run the suites in parallel and batch the ready lanes together' }
const factReason = conflictReason({ entry: factEntry, overlap: 1, flip: 'a negation' })
check('a fact: ask the user which is true; on their word Correct it with their reason, or retain both with the difference stated', factReason === 'conflicts with fact 7: "run the suites in parallel and batch the…": ask the user which is true; on their word, Correct seq:7 with their reason, or retain both with the difference stated (when, where, which)', factReason)
const ruleReason = conflictReason({ entry: { ...factEntry, id: 'seq:43', seq: 43, kind: 'rule', asked: true }, overlap: 1, flip: 'a negation' })
check('a rule: the rule stands, the user\'s road, and the both-true road', ruleReason.startsWith('conflicts with rule 43: "run the suites in parallel and batch the…" — a pinned rule stands until the user changes it: ') && ruleReason.includes(USER_ASKED_RULE_ROAD) && ruleReason.endsWith('; if both are true, retain it again with the difference stated (when, where, which)'), ruleReason)
const pendingReason = conflictReason({ entry: { id: 'pending:1', kind: 'pending', asked: false, text: 'the daemon restarts after an update' }, overlap: 1, flip: 'a negation' })
check('a pending fact takes the fact road', pendingReason.startsWith('conflicts with a pending fact: "the daemon restarts after an update": ask the user which is true; on their word, Correct pending:1 with their reason'), pendingReason)
check('no refusal reason says supersede', ![factReason, ruleReason, pendingReason].some(reason => reason.toLowerCase().includes('supersede')))
check('the user\'s line is unchanged and plain', conflictNotice({ entry: { ...factEntry, id: 'seq:43', seq: 43, kind: 'rule', asked: true }, overlap: 1, flip: 'a negation' }) === 'not stored: it conflicts with rule 43, "run the suites in parallel and batch the…" — the rule stands')
const promptLine = RETAIN_PROMPT.split('\n').find(line => line.includes('states the opposite of one already on record')) ?? ''
check('the Retain prompt gives the model the same law (the user\'s call, then the two roads on their word) and never says supersede', promptLine.includes("A contradiction is the user's call: tell them the conflict in one line and ask which is true; never Correct the record on a contradiction refusal without their word in the same conversation. On their word, Correct the old one with their reason and retain again, or retain both with the difference stated (when, where, which)") && !promptLine.includes('supersede'), promptLine)

section('§6 the library census: every fact of a library re-retained word for word is already on record — no candidate against the library, none refused')
const library = process.argv[2] === undefined ? null : resolve(process.argv[2])
const dir = mnemeLibraryDir()
if (library !== null) {
  check('the named library exists and is copied into the scratch home (the source is read only)', existsSync(library), library)
  cpSync(library, dir, { recursive: true })
  console.log(`  census over a copy of ${library}`)
} else {
  const SYNTHETIC = [
    ['The lane shape is: builders first, then the fold, then the reviewers. No planner seats, no second reviewers and no verifiers sit between build and review. On the first day the lead built the program with planner seats, researchers, second reviewers and verifiers between the build and the review tiers, and the owner cut them as slow.', 'lanes'],
    ["Never remove a worktree without checking the main clone's dependency link first; a forced removal deletes the ignored files under it. Safe removal: list the set, check it against the main clone, verify the links after.", 'worktrees'],
    ['Never stop a background task by its group; kill one pid. Prefer letting it finish or a no-op through a hold flag. After any kill, check the remaining jobs and relaunch the ones that died. Never edit a running script: write the replacement to a new file and relaunch from it.', 'tasks'],
    ['Run suites in parallel and batch ready lanes together. A load-sensitive failure is a test defect, not a scheduling issue: record the load, rerun the single red proof alone once, and fix the timing if it is green alone. (context: the owner, 2026-10-01, during the first drive)', 'proofs'],
    ['Report in plain English without internal test names unless asked. State what happened, the impact on the release, and the required owner action, in that order. Never say "same tree" without comparing tree hashes; say "not verified" and name what would verify it.', 'reports'],
    ['The judge tables were lost at the reboot; they had never been banked. Rule from it: study data lives under the records folder, never in a lead\'s scratch; a lead\'s scratch holds only logs. The benchmark needs a newly recorded corpus before it runs again.', 'study'],
    ['The wave was cut at 23:12 when a daemon restart killed every agent. The judge is back on for the lead\'s rulings. Long runs go through the background road and die with a runner restart.', 'waves'],
    ['Thinking stays on and the output ceiling stays at the stated maximum; never cap, remove or remap a capability as a fix. Fix the harness cause instead: a dropped continuation, a dead counter.', 'models'],
  ] as const
  for (const [text, topic] of SYNTHETIC) appendObservation({ text, source: 'operator', topicHint: topic }, dir)
  check('the synthetic library consolidated', maybeConsolidate({ force: true, dir }).consolidated)
  const seeded = listTopicDocs(dir).flatMap(doc => doc.sections.flatMap(section => section.entries))
  for (const entry of seeded.slice(0, 3)) pinFact(entry.seq, dir, new Date(), { asked: entry.seq % 2 === 1 })
  appendObservation({ text: 'The power cut of 2026-10-13 rebooted the box and wiped the scratch folder; a study bank lives under the records folder from now on.', source: 'operator', topicHint: 'study' }, dir)
  console.log('  census over a synthetic library shaped like a real one (eight facts, three pinned, one pending row)')
}
const live = [...listTopicDocs(dir), ...listArchiveDocs(dir)].flatMap(doc => doc.sections.flatMap(section => section.entries))
const pins = new Set(readPins(dir).map(pin => pin.seq))
const pending = pendingRows(dir)
const entries = recordEntries(dir)
console.log(`  ${live.length} live facts (${[...pins].filter(seq => live.some(entry => entry.seq === seq)).length} pinned), ${pending.length} pending rows, ${entries.length} record entries read by the guard`)
check('the census has facts to read', live.length > 0 && entries.length === live.length + pending.length, `${live.length} + ${pending.length} vs ${entries.length}`)
const candidatesByText = entries.map(entry => [entry.id, contradictionCandidates(entry.text, dir).map(c => `${c.entry.id} ${c.flip} ${c.overlap.toFixed(2)}`)] as const).filter(([, found]) => found.length > 0)
check('no record is a contradiction candidate against the library it sits in', candidatesByText.length === 0, j(candidatesByText))
_resetMemoryVerbSessionStateForTesting()
const before = pendingRows(dir).length
const outcomes = retainItems(entries.map(entry => ({ content: entry.text })), { session: 'census-re-retain' }, dir)
const refused = outcomes.filter(outcome => outcome.status === 'refused')
check(`every one of the ${entries.length} records re-retained word for word lands (stored or already staged), none refused`, refused.length === 0 && outcomes.every(outcome => outcome.status === 'stored' || outcome.status === 'already-staged'), j(refused.slice(0, 3)))
check('the re-retained rows are in the buffer', pendingRows(dir).length === before + outcomes.filter(outcome => outcome.status === 'stored').length, `${before} → ${pendingRows(dir).length}`)
const consolidated = maybeConsolidate({ force: true, dir })
const after = [...listTopicDocs(dir), ...listArchiveDocs(dir)].flatMap(doc => doc.sections.flatMap(section => section.entries))
const merged = after.filter(entry => entry.supersedes !== undefined).length
const grown = after.length - live.length
console.log(`  after consolidation (${consolidated.consolidated ? 'ran' : consolidated.reason}): ${after.length} live facts, ${merged} carry a supersedes link (the re-retain merged into its record), the live set grew by ${grown} (a pending row consolidated counts here)`)
console.log(`  live rows now: ${after.map(entry => `${entry.seq}${entry.supersedes === undefined ? '' : `→${entry.supersedes}`}${readPins(dir).some(pin => pin.seq === entry.seq) ? ' pinned' : ''}`).join(' · ')}`)
check('every unpinned fact re-retained word for word merged into its record, the text unchanged', live.filter(entry => !pins.has(entry.seq)).every(entry => after.some(current => current.text === entry.text && current.supersedes === String(entry.seq))), j(live.filter(entry => !pins.has(entry.seq) && !after.some(current => current.text === entry.text && current.supersedes === String(entry.seq))).map(entry => entry.seq)))
check('every pinned rule is still live with its own text', [...pins].every(seq => after.some(current => current.seq === seq) || !live.some(entry => entry.seq === seq)), j([...pins]))

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log(`✅ WRITE GUARD PAIRING GREEN (${checks} checks)`)
else console.log(`❌ WRITE GUARD PAIRING RED (${failures} of ${checks} checks failed)`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
