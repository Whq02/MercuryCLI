#!/usr/bin/env bun
// gate-watch: src/mneme/mnemeContradiction.ts src/mneme/mnemeText.ts src/mneme/mnemeStemmer.ts src/mneme/memoryVerbs.ts
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0', PACKAGE_URL: 'https://example.invalid/mercury' }
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-write-guard-restatements-')))
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
const { contradictionBetween, contradictionCandidates } = await import('../../src/mneme/mnemeContradiction.ts')
const { retainItems, _resetMemoryVerbSessionStateForTesting } = await import('../../src/mneme/memoryVerbs.ts')
const { appendObservation, pendingRows } = await import('../../src/mneme/mnemeBuffer.ts')
const { maybeConsolidate, listTopicDocs } = await import('../../src/mneme/mnemeConsolidate.ts')
const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.ts')
const { pinFact } = await import('../../src/mneme/mnemeUsage.ts')

const dir = mnemeLibraryDir()

const SHAPE_RULE =
  'The lane shape is: builders first, then the fold, then the reviewers. No planner seats, no second reviewers and no verifiers sit between build and review. On the first day the lead built the program with planner seats, researchers, second reviewers and verifiers between the build and the review tiers, and the owner cut them as slow.'
const CUT_RECORD =
  'The wave was cut at 23:12 when a daemon restart killed every agent. The judge is back on for the lead\'s rulings. Long runs go through the background road and die with a runner restart.'
const LOSS_NOTE =
  'The judge tables were lost at the reboot; they had never been banked. Rule from it: study data lives under the records folder, never in a lead\'s scratch; a lead\'s scratch holds only logs. The benchmark needs a newly recorded corpus before it runs again.'
const WORKTREE_RULE = 'Never remove a worktree without checking the main clone\'s dependency link first; a forced removal deletes the ignored files under it.'
const WORKTREE_RESTATED = 'Never remove a worktree without first checking the main clone\'s dependency link; a forced removal deletes the ignored files under it.'

section('§1 a record never contradicts its own words: a rule that carries its history (what was cut, and why) is one fact, not two')
for (const [name, text] of [['the lane-shape rule with its history', SHAPE_RULE], ['the cut record', CUT_RECORD], ['the loss note', LOSS_NOTE], ['the worktree rule', WORKTREE_RULE]] as const) {
  const found = contradictionBetween(text, text)
  check(`${name} is not its own contradiction`, found === null, j(found))
}

section('§2 a restatement of a rule is not its contradiction: an adverb inside the negated phrase ("without first checking") is the same rule')
const restated = contradictionBetween(WORKTREE_RESTATED, WORKTREE_RULE)
check('"without first checking" against "without checking" is no candidate', restated === null, j(restated))

section('§3 a short sentence inside a record does not make a long, unrelated note its contradiction')
const unrelated = contradictionBetween(LOSS_NOTE, CUT_RECORD)
check('a note about lost study data is no contradiction of a record whose five-word sentence shares three of its words (judge, lead, rule)', unrelated === null, j(unrelated))
const reversed = contradictionBetween(CUT_RECORD, LOSS_NOTE)
check('nor the other way round', reversed === null, j(reversed))

section('§4 the write road: the same facts retained again land; a verbatim re-retain is the road that restores a fact\'s confidence')
for (const [text, topic] of [[SHAPE_RULE, 'lanes'], [CUT_RECORD, 'waves'], [WORKTREE_RULE, 'worktrees']] as const) appendObservation({ text, source: 'operator', topicHint: topic }, dir)
check('the seed batch consolidated', maybeConsolidate({ force: true, dir }).consolidated)
const seeded = listTopicDocs(dir).flatMap(doc => doc.sections.flatMap(section => section.entries))
check('three facts are live', seeded.length === 3, j(seeded.map(e => e.seq)))
const worktreeSeq = seeded.find(e => e.text === WORKTREE_RULE)?.seq
if (worktreeSeq !== undefined) pinFact(worktreeSeq, dir, new Date(), { asked: true })
check('no live fact is a candidate against itself through the library', seeded.every(e => contradictionCandidates(e.text, dir).length === 0), j(seeded.map(e => [e.seq, contradictionCandidates(e.text, dir).map(c => [c.entry.id, c.flip, c.overlap])])))
_resetMemoryVerbSessionStateForTesting()
const before = pendingRows(dir).length
const outcomes = retainItems(
  [{ content: SHAPE_RULE }, { content: CUT_RECORD }, { content: LOSS_NOTE }, { content: WORKTREE_RESTATED }],
  { session: 'review-restatements' },
  dir,
)
const [shapeAgain, cutAgain, lossNote, worktreeAgain] = outcomes
check('the lane-shape rule retained again verbatim is stored', shapeAgain?.status === 'stored', j(shapeAgain))
check('the cut record retained again verbatim is stored', cutAgain?.status === 'stored', j(cutAgain))
check('the loss note is stored beside the cut record', lossNote?.status === 'stored', j(lossNote))
check('the restated worktree rule is stored beside the pinned rule it restates', worktreeAgain?.status === 'stored', j(worktreeAgain))
check('all four rows landed in the buffer', pendingRows(dir).length === before + 4, `${before} → ${pendingRows(dir).length}`)

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log(`✅ WRITE GUARD RESTATEMENTS GREEN (${checks} checks)`)
else console.log(`❌ WRITE GUARD RESTATEMENTS RED (${failures} of ${checks} checks failed)`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
