#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { HANDOFF_ASK_MARK, handoffTurn, isHandoffRequest, startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

const REPO = resolve(import.meta.dir, '..', '..')
const DIST = join(REPO, 'dist', 'mercury.mjs')
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
const { askForHandoff, HANDOFF_ASK, _resetHandoffAskForTesting } = await import('../../src/mneme/handoffAsk.ts')
const { noteSessionEngine, _resetLineageSessionForTesting } = await import('../../src/mneme/lineageSession.ts')
const { ledgerEntryOf, openEntry, closeEntry, readLedger } = await import('../../src/mneme/ledger.ts')
const { mnemeProjectKey, mnemeProjectKeyFor } = await import('../../src/mneme/paths.ts')
const { getSessionId, switchSession } = await import('../../src/bootstrap/state.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/utils/messages/factories.ts')
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

section('§2 the ask in process: one re-ask through the same runner; the second answer stored exactly as written; a failed re-ask keeps the first')
const fakeParams = { systemPrompt: ['system'] as never, userContext: {}, systemContext: {}, toolUseContext: {} as never, forkContextMessages: [] }
type Seen = { prompts: unknown[]; texts: string[] }
function runner(answers: string[], seen: Seen, fail = false) {
  return async (params: { promptMessages: Array<{ type: string; message: { content: unknown } }> }) => {
    seen.prompts.push(params.promptMessages.map(m => ({ type: m.type, content: m.message.content })))
    const texts = params.promptMessages.flatMap(m => (typeof m.message.content === 'string' ? [m.message.content] : Array.isArray(m.message.content) ? (m.message.content as Array<{ text?: string }>).map(b => b.text ?? '') : []))
    seen.texts.push(texts.join('\n'))
    if (fail && seen.prompts.length === 2) throw new Error('the re-ask fell over')
    const text = answers[seen.prompts.length - 1] ?? 'unscripted'
    return { messages: [createAssistantMessage({ content: text })], terminal: { reason: 'completed' as const } }
  }
}
function freshSession(id: string): void {
  _resetHandoffAskForTesting()
  _resetLineageSessionForTesting()
  openEntry(key, { sessionId: `earlier-${id}`, model: 'fixture' })
  closeEntry(key, `earlier-${id}`, { outcome: 'closed', handoff: PREVIOUS })
  switchSession(id as never)
  noteSessionEngine('fixture')
}
freshSession('00000000-0000-4000-8000-00000000a001')
const SECOND = '  Nothing new beyond the record.\n    The fold lands tonight.  \n'
const seenA: Seen = { prompts: [], texts: [] }
const reasked = await askForHandoff({ cacheSafeParams: fakeParams, run: runner([REPEATING, SECOND], seenA) as never })
check('the runner was asked twice: the ask, then the one re-ask', seenA.prompts.length === 2, String(seenA.prompts.length))
check('the re-ask rides the first ask, the first answer and the re-ask line, in that order', Array.isArray(seenA.prompts[1]) && (seenA.prompts[1] as Array<{ type: string }>).map(m => m.type).join(',') === 'user,assistant,user', j(seenA.prompts[1]))
check('the re-ask request carries the mark the fixtures answer to and the count in words', seenA.texts[1]!.includes(HANDOFF_ASK) && seenA.texts[1]!.includes('Four of your seven sentences are already on record') && seenA.texts[1]!.split(HANDOFF_ASK_MARK).length === 3, seenA.texts[1])
check('the second answer is stored exactly as written, indentation and trailing newline included', reasked?.text === SECOND && reasked.stored === true && reasked.reasked === true && ledgerEntryOf(key, String(getSessionId()))?.handoff?.text === SECOND, j(reasked))
freshSession('00000000-0000-4000-8000-00000000a002')
const seenB: Seen = { prompts: [], texts: [] }
const novel = await askForHandoff({ cacheSafeParams: fakeParams, run: runner(['The fold lands tonight.\nThe novelty proof is green.'], seenB) as never })
check('a novel note is stored at once after one request', seenB.prompts.length === 1 && novel?.reasked === false && novel.text === 'The fold lands tonight.\nThe novelty proof is green.', j({ calls: seenB.prompts.length, novel }))
freshSession('00000000-0000-4000-8000-00000000a003')
const seenC: Seen = { prompts: [], texts: [] }
const nothing = await askForHandoff({ cacheSafeParams: fakeParams, run: runner([REPEATING, 'nothing new'], seenC) as never })
check('"nothing new" as the second answer is a valid note, stored as written', seenC.prompts.length === 2 && nothing?.text === 'nothing new' && nothing.stored === true, j(nothing))
freshSession('00000000-0000-4000-8000-00000000a004')
const seenD: Seen = { prompts: [], texts: [] }
const kept = await askForHandoff({ cacheSafeParams: fakeParams, run: runner([REPEATING, 'never'], seenD, true) as never })
check('a re-ask that fails keeps the first note, stored as written — never a lost note, never a third ask', seenD.prompts.length === 2 && kept?.text === REPEATING && kept.stored === true && kept.reasked === true, j(kept))
freshSession('00000000-0000-4000-8000-00000000a005')
const seenE: Seen = { prompts: [], texts: [] }
const twice = await askForHandoff({ cacheSafeParams: fakeParams, run: runner([REPEATING, REPEATING, 'a third'], seenE) as never })
check('the second answer is stored whatever it is: a repeated second answer is never asked a third time', seenE.prompts.length === 2 && twice?.text === REPEATING, j({ calls: seenE.prompts.length }))

section('§3 the marked road end to end: the re-ask reaches the engine as one more marked request; handoffTurn answers it; the fixture counts two')
const nodeBin = Bun.which('node')
const project = realpathSync(mkdtempSync(join(tmpdir(), 'handoff-novelty-project-')))
writeFileSync(join(project, 'README.md'), 'a project under proof\n')
seedFirstRun(configDir, [project])
const projectKey = mnemeProjectKeyFor(project)
type Captured = { body: unknown; raw: string }
async function session(sid: string, prompt: string, turns: ScriptedTurn[]): Promise<{ exit: number | null; stdout: string; stderr: string; requests: Captured[] }> {
  const fixture = await startFixtureApi(turns)
  const env: Record<string, string> = {
    HOME: join(HOME, 'home'),
    PATH: `/usr/bin:/bin:${dirname(nodeBin!)}`,
    TERM: 'dumb',
    MERCURY_CONFIG_DIR: configDir,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    ANTHROPIC_BASE_URL: fixture.url,
    ANTHROPIC_API_KEY: 'fixture-key-000',
    MERCURY_DAEMON_DIR: join(HOME, 'home', 'daemon'),
    MERCURY_THINKING_BINDING: 'drop_block',
  }
  const result = await new Promise<{ exit: number | null; stdout: string; stderr: string }>(done => {
    const child = spawn(nodeBin!, [DIST, 'run', prompt, '--model', 'claude-opus-4-8', '--format', 'rows', '--session-id', sid], { cwd: project, env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => (stdout += d))
    child.stderr.on('data', d => (stderr += d))
    const killer = setTimeout(() => child.kill('SIGKILL'), 120_000)
    child.on('close', exit => {
      clearTimeout(killer)
      done({ exit, stdout, stderr })
    })
  })
  const requests = [...(fixture.requests as unknown as Captured[])]
  await fixture.close()
  return { ...result, requests }
}
const NOTE_ONE = 'The work: the probe.\nDecided: answer with the marker.\nStill to do: the second probe.\nWrong: nothing yet.'
const NOTE_REPEAT = 'The work: a different task entirely.\nDecided: answer with the marker.\nStill to do: the second probe.\nWrong: nothing yet.'
if (!existsSync(DIST)) {
  check('dist/mercury.mjs present (build first; the gate prebuilds it)', false, DIST)
} else if (!nodeBin) {
  check('a node binary on PATH', false)
} else {
  const one = await session('11111111-0000-4000-8000-00000000b001', 'first probe', [{ kind: 'text', text: 'ANSWER-ONE', whenBody: 'first probe' }, handoffTurn(NOTE_ONE)])
  check('the first session: the turn and ONE marked ask; its note stored', one.exit === 0 && one.requests.filter(isHandoffRequest).length === 1 && readLedger(projectKey)[0]?.handoff?.text === NOTE_ONE, `exit=${one.exit} asks=${one.requests.filter(isHandoffRequest).length} ${one.stderr.slice(0, 200)}`)
  const two = await session('22222222-0000-4000-8000-00000000b002', 'second probe', [{ kind: 'text', text: 'ANSWER-TWO', whenBody: 'second probe' }, handoffTurn(NOTE_REPEAT), handoffTurn('nothing new since the last note')])
  const asks = two.requests.filter(isHandoffRequest)
  check('the second session: a note repeating three of its four sentences brings ONE re-ask — two marked requests, both answered by handoffTurn', two.exit === 0 && asks.length === 2, `exit=${two.exit} asks=${asks.length} ${two.stderr.slice(0, 200)}`)
  const reaskBody = asks[1]?.raw ?? ''
  check('the re-ask request carries the first ask, the first answer and the count in words', reaskBody.includes('Three of your four sentences are already on record (the previous note)') && reaskBody.includes(NOTE_REPEAT.split('\n')[0]!), reaskBody.slice(-400))
  const ledger = readLedger(projectKey)
  check('the second answer is the note in the ledger, as written', ledger[1]?.handoff?.text === 'nothing new since the last note' && ledger[1]?.endedAt !== null, j(ledger.map(e => e.handoff?.text)))
  check('the run exits 0 and the outcome row answers the prompt, not the note', two.exit === 0 && two.stdout.includes('ANSWER-TWO') && !two.stdout.includes('nothing new since'), two.stdout.slice(0, 300))
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(` ✅ HANDOFF NOVELTY GREEN (${checks} checks)`)
  process.exit(0)
}
console.log(` ❌ HANDOFF NOVELTY RED (${failures} of ${checks} checks failed)`)
process.exit(1)
