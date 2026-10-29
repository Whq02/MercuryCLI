#!/usr/bin/env bun
// gate-watch: src/mneme/mnemeSimilarity.ts src/mneme/mnemePolarity.ts src/mneme/mnemeConsolidate.ts src/mneme/mnemeContradiction.ts src/mneme/mnemeText.ts
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'memory-protected-words-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const { mergeSimilar, shingleSimilarity, protectedWords, properNames, polarityKeepsApart, CONSOLIDATE_SIMILARITY_THRESHOLD } = await import('../../src/mneme/mnemeSimilarity.ts')
const { POLARITY_PAIRS } = await import('../../src/mneme/mnemePolarity.ts')
const guard = await import('../../src/mneme/mnemeContradiction.ts')
const { currentBufferPath } = await import('../../src/mneme/mnemeBuffer.ts')
const { maybeConsolidate, listTopicDocs, listArchiveDocs } = await import('../../src/mneme/mnemeConsolidate.ts')

const now = new Date('2026-10-14T02:00:00.000Z')
const seed = (dir: string, text: string, stamp: number) => {
  mkdirSync(dir, { recursive: true })
  appendFileSync(currentBufferPath(dir), JSON.stringify({ text, source: 'proof', ts: new Date(now.getTime() + stamp).toISOString(), topicHint: 'rules' }) + '\n')
}
const rows = (dir: string) => [...listTopicDocs(dir), ...listArchiveDocs(dir)].flatMap(d => d.sections.flatMap(s => s.entries))
const history = (dir: string) => [...listTopicDocs(dir), ...listArchiveDocs(dir)].flatMap(d => d.history)
let lanes = 0
function throughConsolidation(left: string, right: string): { live: number; history: number } {
  const dir = join(home, `lane-${lanes++}`)
  seed(dir, left, 0)
  seed(dir, right, 1)
  if (!maybeConsolidate({ dir, now, force: true }).consolidated) return { live: -1, history: -1 }
  return { live: rows(dir).length, history: history(dir).length }
}
const similar = (a: string, b: string): string => shingleSimilarity(a, b).toFixed(3)

try {
  section('§1 one list: the merge reads the guard\'s polarity pairs')
  check('the guard re-exports the one list the merge reads', guard.POLARITY_PAIRS === POLARITY_PAIRS && POLARITY_PAIRS.map(p => p.name).join(' · ') === 'always/never · on/off · enabled/disabled · allowed/forbidden · included/excluded · before/after · true/false')

  section('§2 a flipped polarity never merges, however close the shingles read')
  const ON = 'the memory advisor for every new session of this project is on'
  const OFF = 'the memory advisor for every new session of this project is off'
  console.log(`  on/off at eleven tokens reads ${similar(ON, OFF)} by shingles (the threshold is ${CONSOLIDATE_SIMILARITY_THRESHOLD})`)
  check('on/off at eleven tokens is above the threshold by shingles alone', shingleSimilarity(ON, OFF) >= CONSOLIDATE_SIMILARITY_THRESHOLD)
  check('and does not merge', !mergeSimilar(ON, OFF))
  const onOff = throughConsolidation(ON, OFF)
  check('through consolidation both rows stay current, nothing goes to history', onOff.live === 2 && onOff.history === 0, JSON.stringify(onOff))
  const ENABLED = 'for every lane of this wave the owner\'s word keeps thinking enabled'
  const DISABLED = 'for every lane of this wave the owner\'s word keeps thinking disabled'
  check('enabled/disabled does not merge', shingleSimilarity(ENABLED, DISABLED) >= CONSOLIDATE_SIMILARITY_THRESHOLD && !mergeSimilar(ENABLED, DISABLED), similar(ENABLED, DISABLED))
  const BEFORE = 'the lead runs the identity suite and the component proofs on the merged tree before the fold lands on working, then reads the hosted verdict, writes the gate line and asks the owner for the go'
  const AFTER = BEFORE.replace('before the fold', 'after the fold')
  check('before/after inside a thirty-one token sentence does not merge', shingleSimilarity(BEFORE, AFTER) >= CONSOLIDATE_SIMILARITY_THRESHOLD && !mergeSimilar(BEFORE, AFTER), similar(BEFORE, AFTER))
  for (const [left, right] of [['push to main is allowed after the checks read green on the tree', 'push to main is forbidden after the checks read green on the tree'], ['the worktree is included in the release pool of this wave now', 'the worktree is excluded from the release pool of this wave now'], ['memory.enabled reads true in the scratch home of every proof run', 'memory.enabled reads false in the scratch home of every proof run'], ['always run the suites in parallel and batch the ready lanes together', 'never run the suites in parallel and batch the ready lanes together']]) {
    check(`${guard.polarityFlip(left, right)} does not merge`, !mergeSimilar(left, right), similar(left, right))
  }

  section('§3 a name change never merges: identifiers with digits, dots, slashes or dashes, and words capitalised mid-sentence')
  const MINI = 'the release build for the tag day runs on the mini'
  const LAPTOP = 'the release build for the tag day runs on the laptop'
  console.log(`  mini/laptop reads ${similar(MINI, LAPTOP)} by shingles`)
  check('"runs on the mini" against "runs on the laptop" does not merge (the word after a polarity word is part of its protected window)', shingleSimilarity(MINI, LAPTOP) >= CONSOLIDATE_SIMILARITY_THRESHOLD && !mergeSimilar(MINI, LAPTOP))
  const miniLaptop = throughConsolidation(MINI, LAPTOP)
  check('through consolidation both stay current', miniLaptop.live === 2 && miniLaptop.history === 0, JSON.stringify(miniLaptop))
  const HALL = 'The fold of every wave lands each morning after the gate at the Hall.'
  const YARD = 'The fold of every wave lands each morning after the gate at the Yard.'
  check('a proper name is read from the raw text: capitalised mid-sentence, never the sentence\'s first word', JSON.stringify(properNames(HALL)) === '["hall"]' && JSON.stringify(properNames('Never remove it. The Mini and the laptop both build.')) === '["mini"]')
  check('Hall against Yard does not merge', shingleSimilarity(HALL, YARD) >= CONSOLIDATE_SIMILARITY_THRESHOLD && !mergeSimilar(HALL, YARD), similar(HALL, YARD))
  const OWEN = 'The fold of every wave lands each morning after the gate with Dr. Owen.'
  const EVANS = 'The fold of every wave lands each morning after the gate with Dr. Evans.'
  check('a proper name after a title or abbreviation ("Dr.", "e.g.") is protected through sentencesOf', JSON.stringify(properNames('Run the suite (e.g. Hall) with Dr. Owen.')) === '["hall","dr","owen"]' && shingleSimilarity(OWEN, EVANS) >= CONSOLIDATE_SIMILARITY_THRESHOLD && !mergeSimilar(OWEN, EVANS), JSON.stringify(properNames(OWEN)))
  check('a dashed identifier is protected: working-35 against working-34', protectedWords('the fold target of this wave is the working-35 tree').includes('working-35') && !mergeSimilar('the fold target of this wave is the working-35 tree', 'the fold target of this wave is the working-34 tree'))
  const COMMON = 'the release build for the tag day runs beside the ledger of the mini'
  const COMMON_OTHER = 'the release build for the tag day runs beside the ledger of the laptop'
  console.log(`  not ruled, measured: two lowercase common nouns with no polarity word before them ("of the mini" / "of the laptop") read ${similar(COMMON, COMMON_OTHER)} and ${mergeSimilar(COMMON, COMMON_OTHER) ? 'merge' : 'do not merge'}`)

  section('§4 the consolidate lane\'s road is kept: a polarity word on one side alone is not a flip, and an unchanged polarity window still merges')
  const OLD = 'The service stores encrypted backup records beside the journal and checks every checksum before restoring the saved workspace.'
  check('a trailing "Always." on a restatement still merges (its opposite is on neither side)', mergeSimilar(OLD, `${OLD} Always.`) && !polarityKeepsApart(OLD, `${OLD} Always.`))
  const SAME_WINDOW = 'the advisor is on for every session of this project, the owner said today'
  const SAME_WINDOW_OTHER = 'the advisor is on for every session of this project, the owner said yesterday'
  check('the same polarity word with the same window on both sides merges as before', mergeSimilar(SAME_WINDOW, SAME_WINDOW_OTHER), similar(SAME_WINDOW, SAME_WINDOW_OTHER))
  check('negations and numbers are protected as before', !mergeSimilar(OLD, OLD.replace('stores', 'never stores')) && !mergeSimilar(OLD, OLD.replace('every checksum', 'every checksum 2')))
  const edge = throughConsolidation('amber birch cedar dogwood elm fir', 'amber birch cedar dogwood elm fir ginkgo')
  check('the inclusive edge at four shared shingles of five still merges through consolidation', edge.live === 1 && edge.history === 1, JSON.stringify(edge))
} finally {
  rmSync(home, { recursive: true, force: true })
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log(`✅ CONSOLIDATE PROTECTED WORDS GREEN (${checks} checks)`)
else console.log(`❌ CONSOLIDATE PROTECTED WORDS RED (${failures} of ${checks} checks failed)`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
