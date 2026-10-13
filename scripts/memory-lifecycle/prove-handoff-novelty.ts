#!/usr/bin/env bun
// gate-watch: src/mneme/handoffNovelty.ts src/mneme/mnemeText.ts src/mneme/mnemeStemmer.ts src/mneme/mnemeContradiction.ts src/mneme/ledger.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HANDOFF_ASK_MARK } from '../lib/fixtureApi.ts'

const HOME = mkdtempSync(join(tmpdir(), 'handoff-novelty-home-'))
const configDir = join(HOME, 'home', '.mercury')
mkdirSync(configDir, { recursive: true })
process.env.MERCURY_CONFIG_DIR = configDir
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'sk-ant-fixture-not-a-real-key'
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_BARE
delete process.env.ANTHROPIC_BASE_URL

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const novelty = await import('../../src/mneme/handoffNovelty.ts')
const { openEntry, closeEntry } = await import('../../src/mneme/ledger.ts')
const { mnemeProjectKey } = await import('../../src/mneme/paths.ts')
const { appendObservation } = await import('../../src/mneme/mnemeBuffer.ts')
const { maybeConsolidate, listTopicDocs } = await import('../../src/mneme/mnemeConsolidate.ts')
const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.ts')
const { pinFact } = await import('../../src/mneme/mnemeUsage.ts')

section('§1 the measure: each sentence\'s nearest neighbour on record; the floor is more than half AND at least two sentences')
const dir = mnemeLibraryDir()
for (const text of [
  'Prefix build, deploy and proof commands with cd into the working tree; never rely on the shell working directory.',
  'Run suites in parallel and batch the ready fold lanes together.',
  'The handoff ask budget is 120 seconds on the turn road and 20 seconds on the exit road.',
]) appendObservation({ text, source: 'operator', topicHint: 'rules' }, dir)
check('the record consolidated', maybeConsolidate({ force: true, dir }).consolidated)
const entries = listTopicDocs(dir).find(d => d.slug === 'rules')!.sections.flatMap(s => s.entries)
const prefixSeq = entries.find(e => e.text.startsWith('Prefix'))!.seq
const suitesSeq = entries.find(e => e.text.startsWith('Run suites'))!.seq
const budgetSeq = entries.find(e => e.text.startsWith('The handoff'))!.seq
pinFact(prefixSeq, dir, new Date(), { asked: true })
pinFact(suitesSeq, dir, new Date(), { asked: true })
const key = mnemeProjectKey()
const PREVIOUS = 'The work: the write guard.\nDecided: a refused fact is refused whole.\nStill to do: the novelty proof.'
openEntry(key, { sessionId: 'earlier-session', model: 'fixture' })
closeEntry(key, 'earlier-session', { outcome: 'closed', handoff: PREVIOUS })
const record = novelty.noveltyRecord(key, 'this-session', dir)
check('the record holds the three entries and the previous note', record.length === 4 && record.some(u => u.label === `rule ${prefixSeq}`) && record.some(u => u.label === `fact ${budgetSeq}`) && record.some(u => u.label === novelty.PREVIOUS_NOTE_LABEL), j(record.map(u => u.label)))
const REPEATING =
  'Prefix build, deploy and proof commands with cd into the working tree.\n' +
  'Run the suites in parallel and batch the ready fold lanes together.\n' +
  'The handoff ask budget is 120 seconds on the turn road.\n' +
  'Decided: a refused fact is refused whole.\n' +
  'The novelty proof now covers the re-ask road end to end.\n' +
  'The contradiction filter needs no model call.\n' +
  'Next: fold the bank commits into the brief\'s order.'
const measured = novelty.measureNovelty(REPEATING, record)
check('four of the seven sentences are repetition, each traced to its nearest record', measured.sentences === 7 && measured.repeated === 4 && measured.reask === true, j({ ...measured, sources: measured.sources.map(s => s.label) }))
check('the sources are the two rules, the fact and the previous note', measured.sources.map(s => s.label).join(' · ') === `rule ${prefixSeq} · rule ${suitesSeq} · fact ${budgetSeq} · ${novelty.PREVIOUS_NOTE_LABEL}`, measured.sources.map(s => s.label).join(' · '))
const words = novelty.handoffReask(measured)
console.log(`  the re-ask: ${words}`)
check('the re-ask names the count in words and the sources, and rides the marked road', words === `Four of your seven sentences are already on record (rules ${prefixSeq} and ${suitesSeq}, fact ${budgetSeq}, the previous note). Leave one note for the next session again: reply with the note alone, keeping only what is new — it is stored exactly as written; if nothing is new, say so.` && words.includes(HANDOFF_ASK_MARK), words)
check('the re-ask carries no digit but the record numbers, no percentage and no code', !/%|\d\.\d|seq:|pending:/.test(words), words)
const threeOfSeven = novelty.measureNovelty(REPEATING.split('\n').slice(1).concat('One more new sentence about the fold.').join('\n'), record)
check('three of seven is under the floor: stored at once', threeOfSeven.repeated === 3 && threeOfSeven.sentences === 7 && threeOfSeven.reask === false, j({ repeated: threeOfSeven.repeated, sentences: threeOfSeven.sentences }))
const oneLiner = novelty.measureNovelty('Decided: a refused fact is refused whole.', record)
check('a one-sentence note that repeats the previous note is never re-asked (nothing to keep)', oneLiner.repeated === 1 && oneLiner.reask === false, j(oneLiner))
const both = novelty.measureNovelty('Run the suites in parallel and batch the ready fold lanes together.\nStill to do: the novelty proof.', record)
check('a two-sentence note with both on record is re-asked, in words', both.reask === true && novelty.repetitionInWords(both).startsWith('Both of your sentences are already on record ('), novelty.repetitionInWords(both))
const fresh = novelty.measureNovelty('The fold lands tonight.\nThe novelty proof is green.\nNothing is cut.', record)
check('a novel note has no repetition', fresh.repeated === 0 && fresh.reask === false, j(fresh))
check('"nothing new" is a plain note, never re-asked', novelty.measureNovelty('nothing new', record).reask === false)
check('the thresholds are the named ones: more than half of a sentence\'s word pairs, more than half of the sentences, two at least', novelty.NOVELTY_SENTENCE_SHARE === 0.5 && novelty.NOVELTY_REASK_SHARE === 0.5 && novelty.NOVELTY_REASK_MIN_REPEATED === 2)
check('a sentence sharing exactly half of its word pairs with the record is still new', novelty.measureNovelty('The novelty proof is green.', record).repeated === 0)

console.log('\n============================================================')
if (failures === 0) {
  console.log(` ✅ HANDOFF NOVELTY GREEN (${checks} checks)`)
  process.exit(0)
}
console.log(` ❌ HANDOFF NOVELTY RED (${failures} of ${checks} checks failed)`)
process.exit(1)
