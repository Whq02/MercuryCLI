#!/usr/bin/env bun
// gate-watch: src/mneme/mnemeText.ts src/mneme/handoffNovelty.ts src/mneme/handoffAsk.ts src/mneme/ledger.ts src/mneme/entryKnapsack.ts src/mneme/memoryRefs.ts src/mneme/mnemeContradiction.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
process.env.MERCURY_ENTRYPOINT = 'headless'
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'wording-fixes-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_DAEMON_DIR = join(HOME, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_BARE

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

const DAY = 86_400_000
const T = Date.UTC(2026, 9, 14, 2, 0, 0, 0)
let frozen = T
Date.now = () => frozen

writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ memory: { startLimit: 2000 } }))
const repo = realpathSync(mkdtempSync(join(tmpdir(), 'wording-fixes-repo-')))
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
const git = (...args: string[]): void => {
  const run = spawnSync('git', ['-c', 'user.name=proof', '-c', 'user.email=proof@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, env: GIT_ENV, encoding: 'utf8' })
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr}`)
}
git('init', '-q', '-b', 'lane/quartz-rotation')
writeFileSync(join(repo, 'README.md'), 'quartz\n')
git('add', '.')
git('commit', '-q', '-m', 'first')

const state = await import('../../src/bootstrap/state.ts')
process.chdir(repo)
state.setOriginalCwd(repo)
state.setCwdState(repo)
state.setProjectRoot(repo)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { sentencesOf } = await import('../../src/mneme/mnemeText.ts')
const { measureNovelty } = await import('../../src/mneme/handoffNovelty.ts')
const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.ts')
const { mnemeProjectKey } = await import('../../src/mneme/paths.ts')
const knapsack = await import('../../src/mneme/entryKnapsack.ts')
const { readProjectState } = await import('../../src/mneme/entryState.ts')
const { factMemoryState, memoryStatusWords } = await import('../../src/mneme/memoryRefs.ts')
const { memoryGrade } = await import('../../src/mneme/memoryEvidence.ts')
const { appendObservation } = await import('../../src/mneme/mnemeBuffer.ts')
const { maybeConsolidate } = await import('../../src/mneme/mnemeConsolidate.ts')
const { listTopicDocs, writeDoc } = await import('../../src/mneme/mnemeLibrary.ts')
const { emptyDoc } = await import('../../src/mneme/mnemeTopicDocs.ts')
const { readPins, readUsage } = await import('../../src/mneme/mnemeUsage.ts')
const { contradictionCandidates, recordEntries } = await import('../../src/mneme/mnemeContradiction.ts')
const { retainItems, _resetMemoryVerbSessionStateForTesting } = await import('../../src/mneme/memoryVerbs.ts')
const { noteSessionEngine } = await import('../../src/mneme/lineageSession.ts')
const { askForHandoff, handoffNotice, HANDOFF_ASK, _resetHandoffAskForTesting } = await import('../../src/mneme/handoffAsk.ts')
const { HANDOFF_TEXT_CAP, ledgerEntryOf } = await import('../../src/mneme/ledger.ts')
const { getSessionId } = await import('../../src/bootstrap/state.ts')
const { createAssistantMessage } = await import('../../src/utils/messages/factories.ts')
const { HANDOFF_ASK_MARK } = await import('../lib/fixtureApi.ts')

section('§1 the sentence count does not split on e.g., i.e., vs., cf., a title or a decimal number')
const count = (text: string): number => sentencesOf(text).length
check('"e.g." inside a sentence is no boundary: two sentences, not three', count('Run the api suite (e.g. the prefix proof) before the fold. Then tag.') === 2, j(sentencesOf('Run the api suite (e.g. the prefix proof) before the fold. Then tag.')))
check('"i.e." and "Dr." are no boundaries', count('The judge, i.e. the second seat, reads the table. Dr. Owen signed it.') === 2, j(sentencesOf('The judge, i.e. the second seat, reads the table. Dr. Owen signed it.')))
check('"vs." and a decimal number are no boundaries', count('The fold lands at 2.5 seconds vs. the old 4.0 run. Then it tags.') === 2, j(sentencesOf('The fold lands at 2.5 seconds vs. the old 4.0 run. Then it tags.')))
check('a sentence that ends on a full stop still ends; a bullet list still counts one per line', count('Use bun. Never npm.') === 2 && count('- first thing\n- second thing\n- e.g. a third') === 3)
check('"ms" is a unit, not a title: "40 ms. Then" is two sentences', count('The latency is 40 ms. Then it settles.') === 2)
const measured = measureNovelty('Run the api suite (e.g. the prefix proof) before the fold. Then tag.', [])
check('the re-ask measure counts the same two sentences', measured.sentences === 2 && measured.repeated === 0 && measured.reask === false, j(measured))

section('§2 the start page marks a stale fact that rides, in the words Recall and the centre use, after its line')
const dir = mnemeLibraryDir()
mkdirSync(dir, { recursive: true })
const STALE_FACT = 'quartz rotation: the quartz keys rotate on the quartz rotation night'
const FRESH_FACT = 'the quartz rotation moved to the morning on the owner\'s word and the rotation ledger is written by the morning job'
frozen = T - 70 * DAY
appendObservation({ text: STALE_FACT, source: 'proof', topicHint: 'quartz' }, dir)
frozen = T - 3 * DAY
appendObservation({ text: 'the amber archive is kept offline', source: 'proof', topicHint: 'amber' }, dir)
frozen = T - 2 * DAY
appendObservation({ text: FRESH_FACT, source: 'proof', topicHint: 'quartz' }, dir)
frozen = T - 1 * DAY
check('the two quartz facts and the amber one landed through the real road', maybeConsolidate({ force: true, dir, now: new Date(frozen) }).consolidated)
frozen = T
const seqOf = (text: string): number => {
  for (const doc of listTopicDocs(dir)) for (const s of doc.sections) for (const e of s.entries) if (e.text === text) return e.seq
  throw new Error(`no fact reads ${text}`)
}
const staleSeq = seqOf(STALE_FACT)
const freshSeq = seqOf(FRESH_FACT)
const entries = new Map(listTopicDocs(dir).flatMap(doc => doc.sections.flatMap(s => s.entries.map(e => [e.seq, e] as const))))
const staleState = factMemoryState(entries.get(staleSeq)!, { pins: readPins(dir), usage: readUsage(dir), now: new Date(T) })
check('the old fact reads stale, not confirmed since the day it was retained', staleState.status === 'stale' && staleState.confirmedAt.slice(0, 10) === new Date(T - 70 * DAY).toISOString().slice(0, 10), j(staleState))
const expectedMark = ` [${memoryStatusWords({ status: 'stale', confirmedAt: staleState.confirmedAt })}]`
check('the mark is the words Recall uses', expectedMark === ` [stale — not confirmed since ${new Date(T - 70 * DAY).toISOString().slice(0, 10)}]` && knapsack.staleMark(staleState.confirmedAt) === expectedMark, expectedMark)
const PK = mnemeProjectKey()
const page = await knapsack.composeMemoryAtStart({ projectKey: PK, sessionId: 'wording-session', root: repo, dir, now: new Date(T) })
const grade = memoryGrade({ dir })
check('with room for both, the stale fact rides (behind its grade) with the mark after its line and the fresh fact without one', page !== null && `${page}\n`.includes(`- ${grade} ${STALE_FACT} <seq=${staleSeq}>${expectedMark}\n`) && `${page}\n`.includes(`- ${grade} ${FRESH_FACT} <seq=${freshSeq}>\n`), page ?? 'null')
const projectState = await readProjectState({ projectKey: PK, root: repo, now: new Date(T), ledger: [] })
const marked = knapsack.composeStartPage({ dir, projectKey: PK, state: projectState, previous: [], limit: 2000, now: T, root: repo, stale: c => c.seq === staleSeq, confirmedAt: () => staleState.confirmedAt })
const rode = marked.choice.rode.find(c => c.seq === staleSeq)
check('the mark counts against the start page\'s characters, as the grade does', rode !== undefined && rode.chars === `- ${grade} ${STALE_FACT} <seq=${staleSeq}>`.length + 1 + expectedMark.length, j(rode?.chars))
const unmarked = knapsack.composeStartPage({ dir, projectKey: PK, state: projectState, previous: [], limit: 2000, now: T, root: repo })
check('without the stale option the page prints the fact as written behind its grade, no mark', unmarked.text !== null && `${unmarked.text}\n`.includes(`- ${grade} ${STALE_FACT} <seq=${staleSeq}>\n`) && !unmarked.text.includes('[stale'), unmarked.text ?? 'null')

section('§3 the handoff ask says the cap in its own words; a note over the cap is not stored, and the notice says the count')
noteSessionEngine('fixture')
const cacheSafeParams = { systemPrompt: [] as never, userContext: {}, systemContext: {}, toolUseContext: {} as never, forkContextMessages: [] }
check('the ask names the cap after "exactly as written" and still carries the mark the fixtures answer to', HANDOFF_ASK.endsWith('Reply with the note alone; it is stored exactly as written, up to 8,000 characters.') && HANDOFF_ASK.includes(HANDOFF_ASK_MARK) && HANDOFF_TEXT_CAP === 8000, HANDOFF_ASK)
const runWith = (content: string) => async () => ({ messages: [createAssistantMessage({ content })], terminal: { reason: 'completed' as const } })
const over = 'x'.repeat(HANDOFF_TEXT_CAP + 1)
const refused = await askForHandoff({ cacheSafeParams, run: runWith(over) })
check('a note one character over the cap is not stored and says why', refused !== null && refused.stored === false && refused.overCap === true && refused.text === over, j(refused && { stored: refused.stored, overCap: refused.overCap, length: refused.text.length }))
check('the ledger holds no note for the session', ledgerEntryOf(mnemeProjectKey(), String(getSessionId()))?.handoff === null)
check('the notice carries the count and the cap in the ask\'s own words', handoffNotice(refused) === 'the note was not stored: 8,001 characters, and a note is stored exactly as written only up to 8,000; the session ends with no note left for the next one', handoffNotice(refused))
_resetHandoffAskForTesting()
const exact = 'y'.repeat(HANDOFF_TEXT_CAP)
const kept = await askForHandoff({ cacheSafeParams, run: runWith(exact) })
check('a note at the cap is stored byte for byte', kept?.stored === true && kept.overCap === undefined && ledgerEntryOf(mnemeProjectKey(), String(getSessionId()))?.handoff?.text === exact, j(kept && { stored: kept.stored, length: kept.text.length }))
check('the kept note\'s notice is the ledger line', handoffNotice(kept) === `the note for the next session is in the ledger (${HANDOFF_TEXT_CAP} characters)`, handoffNotice(kept))

section('§4 the write guard reads the archived pages too, as the merge does')
const archive = emptyDoc('backup', 'backup facts', new Date(T - 120 * DAY).toISOString())
archive.id = 'archive-backup'
archive.sections = [{ heading: 'notes', entries: [{ seq: 900, text: 'The nightly backup is encrypted beside the journal.', time: new Date(T - 120 * DAY).toISOString(), source: 'proof' }] }]
writeDoc(archive, dir)
check('the archived fact is among the records the guard reads', recordEntries(dir).some(entry => entry.id === 'seq:900' && entry.kind === 'fact'), j(recordEntries(dir).map(e => e.id)))
const against = contradictionCandidates('The nightly backup is never encrypted beside the journal.', dir)
check('a candidate that flips the archived fact is a candidate against it', against.some(c => c.entry.id === 'seq:900' && c.flip === 'a negation'), j(against.map(c => [c.entry.id, c.flip, c.overlap])))
_resetMemoryVerbSessionStateForTesting()
const outcome = retainItems([{ content: 'The nightly backup is never encrypted beside the journal.' }], { session: 'wording-fixes' }, dir)[0]
check('and the retain is refused naming the archived fact', outcome?.status === 'refused' && outcome.reason.startsWith('conflicts with fact 900: "The nightly backup is encrypted beside the journal."'), j(outcome))
check('its own words retained again are a restatement, not a conflict', retainItems([{ content: 'The nightly backup is encrypted beside the journal.' }], { session: 'wording-fixes' }, dir)[0]?.status === 'stored')

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log(`✅ WORDING FIXES GREEN (${checks} checks)`)
else console.log(`❌ WORDING FIXES RED (${failures} of ${checks} checks failed)`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
