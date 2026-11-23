#!/usr/bin/env bun
// gate-watch: src/sessions/mneme/entryKnapsack.ts src/sessions/mneme/entryState.ts src/sessions/mneme/memoryRefs.ts src/sessions/mneme/mnemeUsage.ts src/sessions/mneme/mnemeLookup.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
process.env.MERCURY_ENTRYPOINT = 'headless'
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'entry-stale-wiring-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_DAEMON_DIR = join(HOME, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_BARE

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 700)}` : ''}${!cond && hint ? ` — ${hint}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)

const DAY = 86_400_000
const T = Date.UTC(2026, 9, 13, 9, 0, 0, 0)
let frozen = T
Date.now = () => frozen

writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ memory: { startLimit: 1000 } }))
const repo = realpathSync(mkdtempSync(join(tmpdir(), 'entry-stale-wiring-repo-')))
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
const git = (...args: string[]): void => {
  const run = spawnSync('git', ['-c', 'user.name=proof', '-c', 'user.email=proof@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, env: GIT_ENV, encoding: 'utf8' })
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr}`)
}
git('init', '-q', '-b', 'lane/quartz-rotation')
writeFileSync(join(repo, 'README.md'), 'quartz\n')
git('add', '.')
git('commit', '-q', '-m', 'first')

const state = await import('../../src/boot/process-state/processState.ts')
process.chdir(repo)
state.setOriginalCwd(repo)
state.setCwdState(repo)
state.setProjectRoot(repo)
const { mnemeLibraryDir } = await import('../../src/sessions/mneme/mnemeGates.ts')
const { mnemeProjectKey } = await import('../../src/sessions/mneme/paths.ts')
const knapsack = await import('../../src/sessions/mneme/entryKnapsack.ts')
const { readProjectState } = await import('../../src/sessions/mneme/entryState.ts')
const { factMemoryState, FACT_STALE_FLOOR } = await import('../../src/sessions/mneme/memoryRefs.ts')
const { appendObservation } = await import('../../src/sessions/mneme/mnemeBuffer.ts')
const { maybeConsolidate } = await import('../../src/sessions/mneme/mnemeConsolidate.ts')
const { listTopicDocs } = await import('../../src/sessions/mneme/mnemeLibrary.ts')
const { bumpUsage, readPins, readUsage, startTextLimit } = await import('../../src/sessions/mneme/mnemeUsage.ts')
const { memoryGrade } = await import('../../src/sessions/mneme/memoryEvidence.ts')
const grade = memoryGrade({ dir: mnemeLibraryDir() })

const dir = mnemeLibraryDir()
mkdirSync(dir, { recursive: true })
check('the library of the scratch project lives under the scratch home', dir.startsWith(HOME), dir, 'mnemeLibraryDir in src/sessions/mneme/mnemeGates.ts must resolve under MERCURY_CONFIG_DIR')
check('the allowance is the thousand the scratch settings name', startTextLimit() === 1000, String(startTextLimit()), 'startTextLimit in src/sessions/mneme/mnemeUsage.ts must read memory.startLimit from the settings file')

const STALE_FACT = 'quartz rotation: the quartz keys rotate on the quartz rotation night'
const FRESH_FACT = `the quartz rotation moved to the morning on the owner's word; the nightly run is gone and the rotation ledger is written by the morning job ${'(the ledger line names the key, the holder, the time and the receipt) '.repeat(11).trim()}`
const seqOf = (text: string): number => {
  for (const doc of listTopicDocs(dir)) for (const s of doc.sections) for (const e of s.entries) if (e.text === text) return e.seq
  throw new Error(`no fact reads ${text}`)
}

section('§1 a fact seventy days old and never opened is stale by the one computation; a fact two days old is current')
frozen = T - 70 * DAY
appendObservation({ text: STALE_FACT, source: 'proof', topicHint: 'quartz' }, dir)
frozen = T - 3 * DAY
appendObservation({ text: 'the amber archive is kept offline', source: 'proof', topicHint: 'amber' }, dir)
frozen = T - 2 * DAY
appendObservation({ text: FRESH_FACT, source: 'proof', topicHint: 'quartz' }, dir)
frozen = T - 1 * DAY
const landed = maybeConsolidate({ force: true, dir, now: new Date(frozen) })
check('the two quartz facts and the amber one landed through the real road, unmerged', landed.consolidated && landed.entries === 3, landed.reason, 'maybeConsolidate in src/sessions/mneme/mnemeConsolidate.ts must write the three buffered facts as three unmerged entries')
frozen = T
const staleSeq = seqOf(STALE_FACT)
const freshSeq = seqOf(FRESH_FACT)
const entries = new Map(listTopicDocs(dir).flatMap(doc => doc.sections.flatMap(s => s.entries.map(e => [e.seq, e] as const))))
const staleState = factMemoryState(entries.get(staleSeq)!, { pins: readPins(dir), usage: readUsage(dir), now: new Date(T) })
const freshState = factMemoryState(entries.get(freshSeq)!, { pins: readPins(dir), usage: readUsage(dir), now: new Date(T) })
check(`the old fact reads stale (confidence ${staleState.confidence.toFixed(3)} under the floor ${FACT_STALE_FLOOR}), not confirmed since the day it was retained`, staleState.status === 'stale' && staleState.confidence < FACT_STALE_FLOOR && staleState.confirmedAt.slice(0, 10) === new Date(T - 70 * DAY).toISOString().slice(0, 10), j(staleState), 'factMemoryState and FACT_STALE_FLOOR in src/sessions/mneme/memoryRefs.ts must mark a seventy-day-old, never opened fact stale')
check('the fresh fact reads current', freshState.status === 'current' && freshState.confidence > 0.9, j(freshState), 'factMemoryState in src/sessions/mneme/memoryRefs.ts must keep a two-day-old fact current')

section('§2 the control: without the stale mark the dense old fact wins the thousand by relevance per character, and the fresh fact is left')
const PK = mnemeProjectKey()
const projectState = await readProjectState({ projectKey: PK, root: repo, now: new Date(T), ledger: [] })
check('the state is the branch alone: lane/quartz-rotation, no files, no note', projectState.branch === 'lane/quartz-rotation' && projectState.files.length === 0 && projectState.note === null, j(projectState), 'readProjectState in src/sessions/mneme/entryState.ts must report only the branch for a fresh repository')
const unmarked = knapsack.composeStartPage({ dir, projectKey: PK, state: projectState, previous: [], limit: 1000, now: T, root: repo })
check('only one of the two quartz facts fits the thousand; the amber fact shares no word and never rides', unmarked.choice.rode.length === 1 && unmarked.choice.left.length === 2 && unmarked.choice.left.every(c => c.seq !== unmarked.choice.rode[0]?.seq), j(unmarked.choice.rode.map(c => [c.id, c.chars])), 'composeStartPage in src/sessions/mneme/entryKnapsack.ts must fit exactly one quartz fact into the thousand characters and leave the amber one')
check('unmarked, the old dense fact rides and the fresh long one is left', unmarked.choice.rode[0]?.seq === staleSeq && unmarked.choice.left.some(c => c.seq === freshSeq && c.score > 0), j([unmarked.choice.rode.map(c => [c.id, c.density]), unmarked.choice.left.map(c => [c.id, c.density])]), 'composeStartPage in src/sessions/mneme/entryKnapsack.ts must pick by relevance per character when no stale mark is given')

section('§3 the fold wiring: the real start page reads factMemoryState, so the stale fact yields its room to the fresh one')
const page = await knapsack.composeMemoryAtStart({ projectKey: PK, sessionId: 'review-session', root: repo, dir, now: new Date(T) })
const status = knapsack.memoryAtStartStatus()
check('the page composed', page !== null && status !== null, j(status), 'composeMemoryAtStart and memoryAtStartStatus in src/sessions/mneme/entryKnapsack.ts must return a page and a status for this project')
check('the fresh fact rides behind its grade', page !== null && page.includes(`- ${grade} ${FRESH_FACT} <seq=${freshSeq}>`), page ?? 'null', 'composeMemoryAtStart in src/sessions/mneme/entryKnapsack.ts must carry the fresh fact on the start page')
check('the stale fact is left for Recall', page !== null && !page.includes(`<seq=${staleSeq}>`), page ?? 'null', 'composeMemoryAtStart in src/sessions/mneme/entryKnapsack.ts must pass factMemoryState (src/sessions/mneme/memoryRefs.ts) to the page so a stale fact yields its room')
check('the line reads one of two facts against the branch', page !== null && page.includes('and 1 of 3 facts most relevant to branch lane/quartz-rotation; Recall finds the rest.'), page ?? 'null', 'the start page line in composeMemoryAtStart (src/sessions/mneme/entryKnapsack.ts) must count the facts that rode against the facts eligible')
check('the status the /config row reads agrees', status !== null && status.rodeFacts === 1 && status.facts === 3 && status.limit === 1000, j(status), 'memoryAtStartStatus in src/sessions/mneme/entryKnapsack.ts must report the rode facts, the facts and the limit of the last page')

section('§4 stale is an order, not a ban: with room for both the stale fact still rides, its text as written; an open today restores it')
writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ memory: { startLimit: 2000 } }))
const { resetSettingsCache } = await import('../../src/platform/settings/settingsCache.ts')
resetSettingsCache()
const roomy = await knapsack.composeMemoryAtStart({ projectKey: PK, sessionId: 'review-session', root: repo, dir, now: new Date(T) })
check('with two thousand characters (scaled to 1,200 by the two eligible records) both ride, the stale one as written with its mark after the line', roomy !== null && roomy.includes(`- ${grade} ${STALE_FACT} <seq=${staleSeq}> [stale`) && roomy.includes(`- ${grade} ${FRESH_FACT} <seq=${freshSeq}>`) && roomy.includes('and 2 of 3 facts most relevant to branch lane/quartz-rotation'), roomy ?? 'null', 'composeMemoryAtStart in src/sessions/mneme/entryKnapsack.ts must still carry a stale fact, as written with a stale mark, when the limit leaves room')
writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ memory: { startLimit: 1000 } }))
resetSettingsCache()
bumpUsage([staleSeq], dir, new Date(T))
const restored = factMemoryState(entries.get(staleSeq)!, { pins: readPins(dir), usage: readUsage(dir), now: new Date(T) })
check('one open today makes the old fact current again, confirmed today', restored.status === 'current' && restored.confirmedAt.slice(0, 10) === new Date(T).toISOString().slice(0, 10), j(restored), 'bumpUsage in src/sessions/mneme/mnemeUsage.ts and factMemoryState in src/sessions/mneme/memoryRefs.ts must treat one open today as a confirmation of the fact')
const after = await knapsack.composeMemoryAtStart({ projectKey: PK, sessionId: 'review-session', root: repo, dir, now: new Date(T) })
check('restored, the dense old fact takes the thousand again by relevance per character', after !== null && after.includes(`<seq=${staleSeq}>`) && !after.includes(`<seq=${freshSeq}>`), after ?? 'null', 'composeMemoryAtStart in src/sessions/mneme/entryKnapsack.ts must rank a restored fact by relevance per character again')

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log(`✅ ENTRY STALE WIRING GREEN (${checks} checks)`)
else console.log(`❌ ENTRY STALE WIRING RED (${failures} of ${checks} checks failed)`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
