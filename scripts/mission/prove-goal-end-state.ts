#!/usr/bin/env bun
// gate-watch: src/guards/mission.ts src/services/mission/goal.ts src/services/mission/goalJudge.ts
// gate-watch: src/commands/mission/** src/services/mission/missionCard.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-goal-end-state-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_DESKTOP_DRIVER = 'none'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
for (const key of ['MERCURY_HOME', 'MERCURY_BARE', 'TYPESAFE_API_KEY', 'https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY']) delete process.env[key]

let failures = 0
let checks = 0
const watchdog = setTimeout(() => {
  console.log('FATAL: prover watchdog (120s) — treat as failure')
  process.exit(1)
}, 120_000)
watchdog.unref?.()
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

const mission = await import('../../src/guards/mission.ts')
const { MISSION_MET_SENTINEL, MISSION_DIRECTIVE_HEADER, buildMissionDirective, clearActiveMission, getActiveMission, setActiveMission } = mission
const { readMissionCard } = await import('../../src/services/mission/missionCard.ts')
const goalModule = await import('../../src/services/mission/goal.ts').catch(() => null)
const judgeModule = await import('../../src/services/mission/goalJudge.ts').catch(() => null)
const { guardsEngaged, judgeTurnEnd, takeTurnNotes } = await import('../../src/guards/guards.ts')
const { _resetContinuationLatchesForTesting } = await import('../../src/services/run/continuationLatch.ts')
const { setJevEnabled } = await import('../../src/services/jev/jevSetting.ts')
const { storeJevApiKey } = await import('../../src/services/jev/jevKey.ts')
const { jevLedgerSnapshot, resetJevLedger } = await import('../../src/services/jev/jevLedger.ts')
const { markMutation } = await import('../../src/utils/verification/verificationState.ts')

judgeModule?._setMissionJudgeForTesting(null)

type Verdict = { kind: 'met' | 'not yet' | 'impossible'; confidence: number; reason: string; road: 'model' | 'jev' | 'claim' | 'compile' }
type Judge = (goal: unknown, evidence: unknown, signal?: AbortSignal) => Promise<Verdict | null>
type Stop = { allowed: boolean; words: string }

const user = (text: string): unknown => ({ type: 'user', message: { role: 'user', content: text } })
const asst = (text: string): unknown => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })
const asstTool = (text: string): unknown => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }, { type: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: '/tmp/x' } }] },
})
const toolResult = (): unknown => ({ type: 'user', toolUseResult: { ok: true }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'ok' }] } })
const asstToolOnly = (): unknown => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: '/tmp/x' } }] } })
const meta = (text: string): unknown => ({ type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text }] } })
const treeChanged = async (): Promise<void> => {
  markMutation(undefined, undefined, process.cwd())
  await new Promise(resolve => setTimeout(resolve, 2))
}

const arm = (sessionId: string, goal: string, judge?: Judge | null): string => {
  _resetContinuationLatchesForTesting()
  return setActiveMission(goal, { sessionId, ...(judge === undefined ? {} : { judge: judge as never }) })
}
const stop = async (sessionId: string, messages: unknown[]): Promise<Stop> => {
  if (guardsEngaged(sessionId).turn.filter(id => id.startsWith('mission-')).length !== 1) throw new Error(`expected one mission guard on ${sessionId}`)
  const holds = await judgeTurnEnd(sessionId, { messages: messages as never })
  return { allowed: holds.length === 0, words: holds[0]?.words ?? '' }
}
const verdict = (kind: Verdict['kind'], confidence = 0.9, reason = `fixture read the goal as ${kind}`): Verdict => ({ kind, confidence, reason, road: 'model' })

console.log('============================================================')
console.log(' /goal — the mission as a goal with an end-state check')
console.log('============================================================')

section('§1 the census: /goal is a second name for /mission')
{
  const { builtinCommands, findCommand } = await import('../../src/commands.ts')
  const commands = [...builtinCommands()]
  const forms = commands.filter(command => command.name === 'mission')
  check('both mission command forms carry the goal alias', forms.length === 2 && forms.every(command => command.aliases?.includes('goal') === true), j(forms.map(command => ({ type: command.type, aliases: command.aliases }))))
  check('/goal resolves to the mission command', findCommand('goal', commands)?.name === 'mission', j(findCommand('goal', commands)?.name))
  check('no other command answers to goal', commands.every(command => command.name !== 'goal' && (command.aliases?.includes('goal') !== true || command.name === 'mission')))
  const { generateCommandSuggestions } = await import('../../src/utils/suggestions/commandSuggestions.ts')
  const { setIsInteractive } = await import('../../src/bootstrap/state.ts')
  setIsInteractive(true)
  const painted = generateCommandSuggestions('/goa', commands).map(item => item.displayText)
  check('the typeahead paints /mission (goal) for the alias', painted.includes('/mission (goal)'), j(painted.slice(0, 6)))
}

section('§2 the goal statement: the condition stated once as an end state with its constraints; a short directive')
{
  check('the goal module exists', goalModule !== null)
  const compiled = goalModule?.compileGoal('the parser suite is green and the fix is pushed, without touching the public API; no force-push')
  check('the end state is the first clause, the constraints the rest', compiled?.endState === 'the parser suite is green and the fix is pushed' && j(compiled?.constraints) === j(['without touching the public API', 'no force-push']), j(compiled))
  check('a plain goal compiles to its end state alone', j(goalModule?.compileGoal('the docs build is green')) === j({ endState: 'the docs build is green', constraints: [] }))
  const directive = buildMissionDirective('the parser suite is green; without touching the public API')
  check('the directive opens with the header the transcript boundary keys on', directive.startsWith(MISSION_DIRECTIVE_HEADER))
  check('the directive states the goal once: one Goal line, one Constraints line', (directive.match(/^\s*Goal: /gm) ?? []).length === 1 && (directive.match(/^\s*Constraints: /gm) ?? []).length === 1 && directive.includes('Goal: the parser suite is green') && directive.includes('Constraints: without touching the public API'), directive)
  check('the directive names the judge, the completion line and the ask-the-human exit', /a judge reads the end state/.test(directive) && directive.includes(MISSION_MET_SENTINEL) && /one question to the operator/.test(directive))
  check('the directive is short (at most 16 lines)', directive.split('\n').length <= 16, String(directive.split('\n').length))
  check('the imperative re-prompt loop is gone from the directive', !/Stop hook will keep re-prompting/.test(directive) && !/Do not stop until/.test(directive))
}

section("§3 a met end state ends on the judge's verdict over an itemised close, not the block counter")
{
  const S = 'goal-judge-met'
  const GOAL = 'the parser suite is green'
  let asked = 0
  arm(S, GOAL, async () => {
    asked += 1
    return verdict('met', 0.92, 'the evidence shows the suite green')
  })
  const first = await stop(S, [user(`/goal ${GOAL}`), asst(`1. ${GOAL} — the suite is green now, 212 passing\n${MISSION_MET_SENTINEL}`)])
  check('the stop passes on the judge over an itemised close: no counter burned', first.allowed && asked === 1, j({ first, asked }))
  const live = getActiveMission(S)
  const card = readMissionCard(S)
  check('the mission reads met with the verdict as its reason', live?.met === true && (live?.lastReason ?? '').includes('the evidence shows the suite green'), j(live))
  check('the card settled met at the first judged end: one counter of judged ends, the met end included, and the outcome names one turn', card?.state === 'met' && card?.iterations === 1 && card?.outcome?.turns === 1 && card?.nextStep === null, j(card))
  clearActiveMission(S)
  arm(S, GOAL, async () => verdict('met', 0.92, 'the evidence shows the suite green'))
  const unclosed = await stop(S, [user(`/goal ${GOAL}`), asst('the suite is green now; moving on')])
  check('the itemised close is the prerequisite for met from any judge: a met verdict over a turn without the close is held, the structural reason in the hold', unclosed.allowed === false && unclosed.words.startsWith(`Mission not completed: ${GOAL} — the turn ended without the completion line; the judge read the goal as met, but the itemised close is the prerequisite`) && readMissionCard(S)?.state === 'armed', j({ unclosed, card: readMissionCard(S) }))
  clearActiveMission(S)
}
{
  const S = 'goal-already-there'
  const { mkdtempSync, writeFileSync: write } = await import('node:fs')
  const dir = mkdtempSync(join(HOME, 'already-'))
  const file = join(dir, 'hello.txt')
  write(file, 'goodbye\n')
  const GOAL = `the file ${file} exists and contains the word hello`
  check('no compile probe stands: the goal module exports no contract, and a goal naming a file that already exists is judged like any other', goalModule !== null && !('goalContract' in goalModule), j(Object.keys(goalModule ?? {})))
  arm(S, GOAL, null)
  check('the card is armed at arming, not met, though the file stands with the wrong content', readMissionCard(S)?.state === 'armed' && getActiveMission(S)?.met !== true, j(readMissionCard(S)))
  const held = await stop(S, [user(`/goal ${GOAL}`), asst('the file is there already.')])
  check('a turn without the itemised close is held like any other', held.allowed === false && held.words.startsWith(`Mission not completed: ${GOAL} — the turn ended without the completion line`), j(held))
  clearActiveMission(S)
}
{
  const S = 'goal-judge-outranks-claim'
  const GOAL = 'the parser suite is green'
  arm(S, GOAL, async () => verdict('not yet', 0.2, 'the suite still fails three cases'))
  const claimed = await stop(S, [user(`/goal ${GOAL}`), asst(`all green.\n${MISSION_MET_SENTINEL}`)])
  check('a completion claim the judge rejects is held', claimed.allowed === false, j(claimed))
  check('the hold is one line of the form "Mission not completed: <goal> — <what is open>. Continue.", the judge\'s reason as what is open', claimed.words === `Mission not completed: ${GOAL} — the suite still fails three cases. Continue.`, claimed.words)
  const card = readMissionCard(S)
  check('the card advanced to check 1 and carries the reason', card?.state === 'armed' && card?.iterations === 1 && (card?.nextStep ?? '').includes('not yet met'), j(card))
  clearActiveMission(S)
}
{
  const S = 'goal-no-cap'
  const GOAL = 'every proof in the suite is green'
  arm(S, GOAL, async () => verdict('not yet', 0.8, 'two proofs still red'))
  check('the record carries no stall measure: no progress counter, no verification snapshot', !('stalledChecks' in (getActiveMission(S) ?? {})) && !('lastSeen' in (getActiveMission(S) ?? {})) && judgeModule !== null && !('GOAL_STALL_CHECKS' in judgeModule), j(Object.keys(getActiveMission(S) ?? {})))
  const transcript: unknown[] = [user(`/goal ${GOAL}`), asst('working')]
  let held = 0
  for (let i = 0; i < 14; i++) {
    await treeChanged()
    const result = await stop(S, transcript)
    if (!result.allowed) held += 1
    transcript.push(asstTool(`round ${i}`), toolResult(), asst(`still red after round ${i}`))
  }
  check('fourteen not-yet verdicts over fourteen rounds that each make a tool call hold fourteen stops: no block cap, no idle brake, stands down a goal that works', held === 14 && readMissionCard(S)?.state === 'armed' && getActiveMission(S)?.paused === undefined, j({ held, card: readMissionCard(S) }))
  clearActiveMission(S)
}
{
  const S = 'goal-idle-brake'
  const GOAL = 'every proof in the suite is green'
  const IDLE = mission.MISSION_IDLE_TURNS
  let judged = 0
  arm(S, GOAL, async () => {
    judged += 1
    return verdict('not yet', 0.8, 'two proofs still red')
  })
  const idle: unknown[] = [user(`/goal ${GOAL}`), asst('thinking about it')]
  const trail: string[] = []
  for (let i = 0; i < 8; i++) {
    const result = await stop(S, idle)
    trail.push(result.allowed ? 'pass' : result.words.split('\n')[0]!)
    if (result.allowed) break
    idle.push(meta('(hold)'), asst(`still thinking (${i})`))
  }
  const idleNotes = takeTurnNotes(S)
  check(`The only brake on the loop: ${IDLE} consecutive turn ends without a tool call pause the goal — ${IDLE - 1} holds, then paused, the goal still armed, the judge called at every end, the card counting ${IDLE} judged ends`, IDLE === 3 && trail.length === IDLE && trail.slice(0, IDLE - 1).every(line => line.startsWith(`Mission not completed: ${GOAL} — two proofs still red`)) && trail[IDLE - 1] === 'pass' && judged === IDLE && readMissionCard(S)?.state === 'paused' && readMissionCard(S)?.iterations === IDLE && (readMissionCard(S)?.nextStep ?? '').includes(`${IDLE} turns without a tool call`) && guardsEngaged(S).turn.some(id => id.startsWith('mission-')), j({ trail, judged, card: readMissionCard(S) }))
  check('the idle pause note says what happened and what resumes it', idleNotes.some(note => note.text === `mission paused after ${IDLE} turns without a tool call — your next message resumes it`), j(idleNotes))
  _resetContinuationLatchesForTesting()
  const resumedIdle = await stop(S, [...idle, user('go on'), asst('looking again')])
  check("the operator's next message resumes it and the idle count starts over: the next end without a tool call is held, not paused", resumedIdle.allowed === false && readMissionCard(S)?.state === 'armed', j({ resumedIdle, card: readMissionCard(S) }))
  clearActiveMission(S)
  arm(S, GOAL, async () => verdict('not yet', 0.8, 'two proofs still red'))
  const working: unknown[] = [user(`/goal ${GOAL}`), asst('working')]
  let workingHolds = 0
  for (let i = 0; i < 6; i++) {
    const result = await stop(S, working)
    if (!result.allowed) workingHolds += 1
    else break
    working.push(meta('(hold)'), asstTool(`reading test ${i}`), toolResult(), asst(`read more (${i})`))
  }
  check('a turn with any tool call never triggers the brake: six ends that each read a file are six holds, never a pause', workingHolds === 6 && readMissionCard(S)?.state === 'armed' && getActiveMission(S)?.paused === undefined, j({ workingHolds, card: readMissionCard(S) }))
  clearActiveMission(S)
  arm(S, GOAL, async () => verdict('not yet', 0.8, 'two proofs still red'))
  const mixed: unknown[] = [user(`/goal ${GOAL}`)]
  const mixedTrail: boolean[] = []
  const withTool = [false, false, true, false, false, false]
  for (const tool of withTool) {
    mixed.push(...(tool ? [asstTool('reading the red proof'), toolResult()] : []), asst('still thinking'))
    const result = await stop(S, mixed)
    mixedTrail.push(result.allowed)
    if (result.allowed) break
    mixed.push(meta(`Mission not completed: ${GOAL} — two proofs still red. Continue.`))
  }
  check('a tool call resets the count: tool-less, tool-less, Read, tool-less, tool-less, tool-less is five holds and then the pause', j(mixedTrail) === j([false, false, false, false, false, true]) && readMissionCard(S)?.state === 'paused', j({ mixedTrail, card: readMissionCard(S) }))
  clearActiveMission(S)
  const window = mission.toolCallsSinceLastStop([
    user(`/goal ${GOAL}`),
    asst('first'),
    meta(`Mission not completed: ${GOAL} — two proofs still red. Continue.`),
    asstTool('reading'),
    toolResult(),
    meta('(a correction the turn machine wrote after the tool result)'),
    asst('done reading'),
  ] as never)
  check('the idle window is bounded by the previous judged stop, never by a meta row the turn machine wrote: [hold, Read + result, meta correction, text] counts one tool call', j(window) === j(['Read']), j(window))
  const opened = mission.toolCallsSinceLastStop([user('read it'), asstTool('reading'), toolResult(), asst('read'), meta(buildMissionDirective(GOAL)), asst('working on it')] as never)
  check("the window also stops at the mission's own directive row (the runner queues /mission as a meta row): the tool calls of the turn before the mission was set never count as this turn's", j(opened) === j([]), j(opened))
  const seen: number[] = []
  arm(S, GOAL, async (_goal, evidence) => {
    seen.push((evidence as { toolCalls: number }).toolCalls)
    return verdict('not yet', 0.8, 'two proofs still red')
  })
  const armedMidway: unknown[] = [user('read it'), asstTool('reading'), toolResult(), asst('read'), meta(buildMissionDirective(GOAL)), asst('working on it')]
  const midwayTrail: boolean[] = []
  for (let i = 0; i < 5; i++) {
    const result = await stop(S, armedMidway)
    midwayTrail.push(result.allowed)
    if (result.allowed) break
    armedMidway.push(meta(`Mission not completed: ${GOAL} — two proofs still red. Continue.`), asst(`still thinking (${i})`))
  }
  check('a mission set by the meta /mission row after a tool-calling turn: the first judged end sees zero tool calls and counts one idle turn, so three tool-less ends are two holds and then the pause', j(seen.slice(0, 1)) === j([0]) && j(midwayTrail) === j([false, false, true]) && readMissionCard(S)?.state === 'paused', j({ seen, midwayTrail, card: readMissionCard(S) }))
  clearActiveMission(S)
}

section('§4 the Jev road: the verdict rides the existing judge road, counted in the ledger; closed, the claim stands')
{
  const S = 'goal-jev'
  const GOAL = 'the parser suite is green and the fix is pushed; without touching the public API'
  check('Jev off: the judge road is closed', judgeModule !== null && judgeModule.goalJudgeOpen() === false)
  setJevEnabled(true)
  storeJevApiKey('proof-key-jev-not-a-real-key-0106')
  resetJevLedger()
  standin.reset()
  check('Jev on with a key: the judge road is open', judgeModule !== null && judgeModule.goalJudgeOpen() === true)
  const answer = (choice: string, p: number): unknown => {
    const rest = (1 - p) / 3
    const probabilities: Record<string, number> = { met: rest, open: rest, ambiguous: rest, unattainable: rest }
    probabilities[choice] = p
    return { model: 'jev-1.13.0', answers: { goal: { type: 'choice', choice, probabilities, confidence: p } }, usage: { input_tokens: 400, output_tokens: 10 } }
  }
  const itemised = `1. the parser suite is green and the fix is pushed — suite green on CI, pushed as 9f1c2d\n2. without touching the public API — no diff under src/api\n${MISSION_MET_SENTINEL}`
  standin.answerWith(() => answer('met', 0.91))
  arm(S, GOAL)
  const unclosed = await stop(S, [user(`/goal ${GOAL}`), asst('suite green, pushed; the API untouched')])
  const request = standin.received[0]?.body as { model?: string; state?: Record<string, string>; questions?: Record<string, { type?: string; criteria?: Record<string, string> }> } | undefined
  check('one request reached Jev', standin.received.length === 1, String(standin.received.length))
  check('the request carries the goal statement, the closing words and the verification record as its state', (request?.state?.goal ?? '').startsWith('Goal: the parser suite is green and the fix is pushed') && (request?.state?.goal ?? '').includes('Constraints: without touching the public API') && (request?.state?.closing ?? '').includes('suite green, pushed') && typeof request?.state?.verification === 'string' && request?.state?.claimed_met === 'no', j(request?.state))
  check('one choice question with the four verdicts', request?.questions?.goal?.type === 'choice' && j(Object.keys(request?.questions?.goal?.criteria ?? {})) === j(['met', 'open', 'ambiguous', 'unattainable']), j(request?.questions))
  check('the request rides the pinned model on the official road', request?.model === 'jev-1.13.0', j(request?.model))
  check('Jev at 0.91 met over a turn without the itemised close: held, the structural reason first, Jev named after it', unclosed.allowed === false && unclosed.words.includes('the turn ended without the completion line; the judge read the goal as met, but the itemised close is the prerequisite') && readMissionCard(S)?.state === 'armed', j({ unclosed, card: readMissionCard(S) }))
  clearActiveMission(S)
  arm(S, GOAL)
  const met = await stop(S, [user(`/goal ${GOAL}`), asst(itemised)])
  check("Jev at 0.91 met over the itemised close: the stop passes and the card reads met on Jev's verdict", met.allowed && readMissionCard(S)?.state === 'met' && (getActiveMission(S)?.lastReason ?? '').includes('Jev read the goal as met'), j({ met, live: getActiveMission(S)?.lastReason }))
  check('both calls are counted in the Jev ledger', jevLedgerSnapshot().attempts === 2, j(jevLedgerSnapshot()))
  clearActiveMission(S)

  standin.answerWith(() => answer('open', 0.8))
  arm(S, GOAL)
  const claimed = await stop(S, [user(`/goal ${GOAL}`), asst(itemised)])
  check("Jev at 0.8 open outranks the itemised close: held, with Jev's reading in the words", claimed.allowed === false && claimed.words.includes('Jev read the goal as open'), j(claimed))
  const claimedRequest = standin.received[2]?.body as { state?: Record<string, string> } | undefined
  check('the itemised claim is evidence Jev sees, not the verdict', claimedRequest?.state?.claimed_met === 'yes', j(claimedRequest?.state))
  clearActiveMission(S)
  standin.answerWith(() => answer('met', 0.91))
  arm(S, GOAL)
  const bare = await stop(S, [user(`/goal ${GOAL}`), asst(`done.\n${MISSION_MET_SENTINEL}`)])
  const bareRequest = standin.received[3]?.body as { state?: Record<string, string> } | undefined
  check('a bare completion line with Jev answering met is held: Jev sees claimed_met no, and the hold names the missing criterion lines before the judge', bare.allowed === false && bareRequest?.state?.claimed_met === 'no' && bare.words.includes('the completion line stands alone: no criterion lines precede it; the judge read the goal as met, but the itemised close is the prerequisite') && readMissionCard(S)?.state === 'armed', j({ bare, state: bareRequest?.state }))
  clearActiveMission(S)
  arm(S, GOAL)
  const skippedWithJev = await stop(S, [user(`/goal ${GOAL}`), asst(`1. the parser suite is green and the fix is pushed — suite green on CI, pushed as 9f1c2d\n${MISSION_MET_SENTINEL}`)])
  check('a close that skips a criterion with Jev answering met is held with the skipped criterion named', skippedWithJev.allowed === false && skippedWithJev.words.includes('criterion 2 has no line in the close') && readMissionCard(S)?.state === 'armed', j(skippedWithJev))
  clearActiveMission(S)

  standin.answerWith(() => answer('met', 0.5))
  arm(S, GOAL)
  const leaning = await stop(S, [user(`/goal ${GOAL}`), asst('probably green')])
  check('a met reading under the 0.6 floor keeps the goal open', leaning.allowed === false && leaning.words.includes('under the 0.6 floor'), j(leaning))
  clearActiveMission(S)

  standin.answerWith(undefined)
  standin.next({ status: 500, body: { error: { message: 'fixture down' } } })
  arm(S, GOAL)
  const down = await stop(S, [user(`/goal ${GOAL}`), asst(itemised)])
  check('Jev down: the itemised claim is the verification and the goal is met on the claim road', down.allowed && (getActiveMission(S)?.lastReason ?? '').includes('the claim is the verification'), j({ down, live: getActiveMission(S)?.lastReason }))
  clearActiveMission(S)
  standin.next({ status: 500, body: { error: { message: 'fixture down' } } })
  arm(S, GOAL)
  const skipped = await stop(S, [user(`/goal ${GOAL}`), asst(`1. the parser suite is green and the fix is pushed — suite green on CI, pushed as 9f1c2d\n${MISSION_MET_SENTINEL}`)])
  check('Jev down, a close that skips a criterion is held with the skipped criterion named', skipped.allowed === false && skipped.words.includes('criterion 2 has no line in the close'), j(skipped))
  clearActiveMission(S)
  standin.next({ status: 500, body: { error: { message: 'fixture down' } } })
  arm(S, GOAL, async () => verdict('not yet', 0.9, 'the lines name no evidence: "yes" and "untouched" show nothing'))
  const hollow = await stop(S, [user(`/goal ${GOAL}`), asst(`1. the parser suite is green and the fix is pushed — yes\n2. without touching the public API — untouched\n${MISSION_MET_SENTINEL}`)])
  check('Jev down, a hollow close is the judge\'s to read, not a word count\'s: the helper reads it as not yet and the hold carries its reason', hollow.allowed === false && hollow.words.includes('the lines name no evidence'), j(hollow))
  clearActiveMission(S)
  standin.next({ status: 500, body: { error: { message: 'fixture down' } } })
  arm(S, GOAL, async () => verdict('met', 0.9, 'the close names the CI run and the untouched API'))
  const helperMet = await stop(S, [user(`/goal ${GOAL}`), asst(itemised)])
  check('Jev down, the helper\'s met over the itemised close meets the goal with the helper\'s reason', helperMet.allowed && readMissionCard(S)?.state === 'met' && readMissionCard(S)?.outcome?.reason === 'the close names the CI run and the untouched API', j({ helperMet, card: readMissionCard(S) }))
  clearActiveMission(S)
  resetJevLedger()
  standin.reset()
  standin.answerWith(() => answer('open', 0.8))
  arm(S, GOAL, async () => verdict('met', 0.9, 'the helper read it as met'))
  const jevOnTop = await stop(S, [user(`/goal ${GOAL}`), asst(itemised)])
  check("Jev on top: when Jev answers, its verdict wins over the helper's — helper met, Jev open, the turn is held with Jev's reading", jevOnTop.allowed === false && jevOnTop.words.includes('Jev read the goal as open'), j(jevOnTop))
  clearActiveMission(S)
  setJevEnabled(false)
  storeJevApiKey(null)
  check('Jev off again: the road is closed', judgeModule !== null && judgeModule.goalJudgeOpen() === false)
}

section('§5 the pause: an impossible verdict pauses the mission with its reason as the note — armed, waiting — never an end, never a silent loop')
{
  const S = 'goal-impossible'
  const GOAL = 'the report is improved'
  arm(S, GOAL, async () => verdict('impossible', 0.85, 'improved names no observable state'))
  const first = await stop(S, [user(`/goal ${GOAL}`), asst('I tightened two paragraphs')])
  const firstNotes = takeTurnNotes(S)
  check('an impossible verdict never holds and never ends: the stop passes, the mission pauses with the reason as the note', first.allowed && readMissionCard(S)?.state === 'paused' && (readMissionCard(S)?.nextStep ?? '').includes('improved names no observable state') && firstNotes.some(note => note.text.startsWith('mission paused — improved names no observable state') && note.text.includes('your next message resumes it')), j({ first, card: readMissionCard(S), notes: firstNotes }))
  check('the live record says so too: paused, still armed, not met', getActiveMission(S)?.paused !== undefined && getActiveMission(S)?.met !== true && guardsEngaged(S).turn.some(id => id.startsWith('mission-')), j(getActiveMission(S)))
  const sameTurn = await stop(S, [user(`/goal ${GOAL}`), asst('I tightened two paragraphs'), meta('(a carried notice)'), asst('still waiting')])
  check('while paused, a stop in the same turn passes without a hold: the model waits on the operator', sameTurn.allowed && readMissionCard(S)?.state === 'paused', j(sameTurn))
  _resetContinuationLatchesForTesting()
  const third = await stop(S, [user(`/goal ${GOAL}`), asst('I tightened two paragraphs'), user('shorter'), asst('made it shorter')])
  check("the operator's next message resumes it and the end is judged again: the fixture still reads impossible, so it pauses again with the reason — still armed, never cleared by the harness", third.allowed && readMissionCard(S)?.state === 'paused' && getActiveMission(S)?.met !== true && guardsEngaged(S).turn.some(id => id.startsWith('mission-')), j({ third, card: readMissionCard(S) }))
  clearActiveMission(S)
}
{
  const S = 'goal-asks-itself'
  const GOAL = 'the migration is applied to the right database'
  let asked = 0
  arm(S, GOAL, async () => {
    asked += 1
    return verdict('not yet')
  })
  const own = await stop(S, [user(`/goal ${GOAL}`), asst('Two databases match that name. Which one should receive the migration?')])
  check('a turn that ends on a question to the operator pauses the mission: no hold, the judge called once like every turn end', own.allowed && asked === 1, j({ own, asked }))
  check('the card reads paused with the question', readMissionCard(S)?.state === 'paused' && (readMissionCard(S)?.nextStep ?? '').includes('Which one should receive the migration?'), j(readMissionCard(S)))
  clearActiveMission(S)
  for (const closing of ['**Which database should receive the migration?**', 'Two match.\n"Which one?"', 'Which one do you mean (prod or staging)?']) {
    arm(S, GOAL, async () => verdict('not yet'))
    const styled = await stop(S, [user(`/goal ${GOAL}`), asst(closing)])
    check(`a closing question wrapped in markdown or quotes is a question too: ${j(closing)}`, styled.allowed && readMissionCard(S)?.state === 'paused', j({ styled, card: readMissionCard(S) }))
    clearActiveMission(S)
  }
  arm(S, GOAL, async () => verdict('not yet'))
  const midText = await stop(S, [user(`/goal ${GOAL}`), asst('Is the migration applied? Not yet: the second database still lacks it.')])
  check('a question answered in the same breath is not a question to the operator', midText.allowed === false && readMissionCard(S)?.state === 'armed', j(midText))
  clearActiveMission(S)
  arm(S, GOAL, async () => verdict('not yet'))
  const stale = await stop(S, [asst('Do you want the prod or the staging database?'), meta(buildMissionDirective(GOAL)), user('go'), asstToolOnly(), toolResult()])
  check('a turn without closing words never reads a question from before the goal: the closing stops at the turn boundary', stale.allowed === false && readMissionCard(S)?.state === 'armed', j({ stale: stale.words.split('\n')[0], card: readMissionCard(S)?.state }))
  _resetContinuationLatchesForTesting()
  const earlier = await stop(S, [user(`/goal ${GOAL}`), asst('Which one?'), user('the second'), asstToolOnly(), toolResult()])
  check("nor a question from the previous turn, answered since", earlier.allowed === false && readMissionCard(S)?.state === 'armed', j({ earlier: earlier.words.split('\n')[0] }))
  clearActiveMission(S)
}
{
  const S = 'goal-contradiction'
  const GOAL = 'ensure X is simultaneously enabled and disabled, with no observable regression'
  let asked = 0
  arm(S, GOAL, async () => {
    asked += 1
    return verdict('not yet', 0.9, 'nothing was changed yet')
  })
  const first = await stop(S, [user(`/goal ${GOAL}`), asst('trying')])
  check('no regex rules a goal impossible: contradiction or "observable" words in the goal change nothing, the judge is called and its verdict holds the turn', first.allowed === false && asked === 1 && first.words === `Mission not completed: ${GOAL} — nothing was changed yet. Continue.` && readMissionCard(S)?.state === 'armed', j({ first, asked, card: readMissionCard(S) }))
  clearActiveMission(S)
}
{
  const S = 'goal-claim-road'
  const GOAL = 'the flaky test is fixed'
  arm(S, GOAL, null)
  const transcript: unknown[] = [user(`/goal ${GOAL}`), asst('thinking about it')]
  const trail: boolean[] = []
  for (let i = 0; i < 8; i++) {
    const result = await stop(S, transcript)
    trail.push(result.allowed)
    if (result.allowed) break
    transcript.push(user('(hold)'), asst(`still thinking (${i})`))
  }
  check('with no judge to call (the claim road, fixture and offline runs only), the idle brake is the only brake: two holds without a tool call, then paused, never an end', j(trail) === j([false, false, true]) && readMissionCard(S)?.state === 'paused' && (readMissionCard(S)?.nextStep ?? '').includes('turns without a tool call'), j({ trail, card: readMissionCard(S) }))
  clearActiveMission(S)
  arm(S, GOAL, null)
  const closes: unknown[] = [user(`/goal ${GOAL}`), asst('thinking about it')]
  const closeTrail: boolean[] = []
  for (let i = 0; i < 8; i++) {
    const result = await stop(S, closes)
    closeTrail.push(result.allowed)
    if (result.allowed) break
    closes.push(user('(hold)'), asst(i === 1 ? `1. ${GOAL} \u2014 pinned the flaky await in test/flaky.test.ts; 20 green runs in a row\n${MISSION_MET_SENTINEL}` : `still thinking (${i})`))
  }
  check('on the claim road an itemised close is the verification: met before the brake would fall, with the outcome recorded', j(closeTrail) === j([false, false, true]) && readMissionCard(S)?.state === 'met' && readMissionCard(S)?.outcome?.turns === 3 && getActiveMission(S)?.met === true, j({ closeTrail, card: readMissionCard(S) }))
  clearActiveMission(S)
}
{
  const S = 'goal-clear-during-judgement'
  const GOAL = 'the parser suite is green'
  const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 5))
  for (const kind of ['not yet', 'met'] as const) {
    let settle: (v: Verdict | null) => void = () => {}
    arm(S, GOAL, () => new Promise<Verdict | null>(resolve => { settle = resolve }))
    const pending = stop(S, [user(`/goal ${GOAL}`), asst(kind === 'met' ? `1. ${GOAL} \u2014 212 passing on CI\n${MISSION_MET_SENTINEL}` : 'working')])
    await tick()
    const cleared = clearActiveMission(S)
    settle(verdict(kind))
    const result = await pending
    check(`a clear that lands while the judge is out (${kind} verdict) wins: no hold, no card write over the cleared card, no live record`, cleared === GOAL && result.allowed && readMissionCard(S)?.state === 'cleared' && getActiveMission(S) === undefined, j({ kind, result, card: readMissionCard(S), live: getActiveMission(S) }))
  }
}
{
  const S = 'goal-reads-are-work'
  const GOAL = 'the flaky test is fixed'
  arm(S, GOAL, null)
  const transcript: unknown[] = [user(`/goal ${GOAL}`), asst('looking')]
  let held = 0
  for (let i = 0; i < 8; i++) {
    const result = await stop(S, transcript)
    if (!result.allowed) held += 1
    else break
    transcript.push(user('(hold)'), asstTool(`reading test ${i}`), toolResult(), asstTool(`grepping ${i}`), toolResult(), asst(`read more (${i})`))
  }
  check('a turn that reads files makes tool calls and is never braked: eight read-only rounds are eight holds, the goal still armed', held === 8 && readMissionCard(S)?.state === 'armed', j({ held, card: readMissionCard(S) }))
  clearActiveMission(S)
}

section('§6 the surfaces keep their words: the receipt, the panel, the card')
{
  const jsx = await import('../../src/commands/mission/mission-jsx.tsx')
  const S = 'goal-surface'
  arm(S, 'the rail paints the goal', async () => verdict('impossible', 0.9, 'no observable state'))
  const { readFileSync } = await import('node:fs')
  const panel = readFileSync(join(import.meta.dir, '..', '..', 'src/commands/mission/mission-jsx.tsx'), 'utf8')
  check('the interactive panel paints completed (reason, turns, elapsed) and paused as distinct states, the block-cap and needs-operator states gone', /Mission completed — \$\{outcome\.reason\} · \$\{outcome\.turns\}/.test(panel) && /Mission paused — /.test(panel) && !/block cap/.test(panel) && !/NEEDS THE OPERATOR/.test(panel) && typeof jsx.call === 'function')
  check("the panel reads the session's card, never a record of its own", panel.includes('workRoster().missionCard') && !panel.includes('getActiveMission') && !panel.includes('setActiveMission('))
  const local = readFileSync(join(import.meta.dir, '..', '..', 'src/commands/mission/mission.ts'), 'utf8')
  check('the print form mirrors the same states', /Mission completed/.test(local) && /Mission PAUSED/.test(local) && !/block cap/.test(local) && !/NEEDS THE OPERATOR/.test(local))
  const guard = readFileSync(join(import.meta.dir, '..', '..', 'src/guards/mission.ts'), 'utf8')
  check('the guard carries no block counter, no maxBlocks option and no stall road', !/maxBlocks/.test(guard) && !/DEFAULT_MISSION_MAX_BLOCKS/.test(guard) && !/stalledChecks|GOAL_STALL_CHECKS|askWords|asking|gave no question/.test(guard))
  check('the guard still claims through the shared continuation latch', guard.includes('claimContinuation('))
  clearActiveMission(S)
}

section('§7 a newer card wins by time: /goal run again with the same words after a pause re-arms, and the older record never writes over it')
{
  const { writeMissionCard } = await import('../../src/services/mission/missionCard.ts')
  const { syncMissionFromCard } = mission
  const S = 'goal-same-words-again'
  const GOAL = 'the report is improved'
  arm(S, GOAL, async () => verdict('impossible', 0.85, 'improved names no observable state'))
  const first = await stop(S, [user(`/goal ${GOAL}`), asst('I tightened two paragraphs')])
  const before = getActiveMission(S)
  check('the impossible verdict pauses the record', first.allowed && before?.paused !== undefined, j({ first, paused: before?.paused }))
  const again = new Date((before?.setAt ?? Date.now()) + 5_000).toISOString()
  writeMissionCard({ schema: 1, sessionId: S, goal: GOAL, state: 'armed', nextStep: null, iterations: 0, setAt: again, updatedAt: again })
  _resetContinuationLatchesForTesting()
  const stale = await stop(S, [user(`/goal ${GOAL}`), asst('I tightened two paragraphs'), user('(hold)'), asst('reading the report again')])
  const standing = readMissionCard(S)
  check('without a sync, the older record settles itself but never writes over the newer card: it still reads armed at iterations 0 with its own setAt', stale.allowed && standing?.state === 'armed' && standing?.iterations === 0 && standing?.setAt === again, j({ stale, standing }))
  syncMissionFromCard(S)
  const live = getActiveMission(S)
  check('the sync adopts the newer card though its words match: a fresh record born at the card\'s setAt, not paused, nothing met', live !== undefined && live !== before && live.paused === undefined && live.met !== true && live.iterations === 0 && live.setAt === Date.parse(again), j({ setAt: live?.setAt, again: Date.parse(again), paused: live?.paused, iterations: live?.iterations }))
  _resetContinuationLatchesForTesting()
  const armedStill = guardsEngaged(S).turn.some(id => id.startsWith('mission-'))
  const judged = armedStill ? await stop(S, [user(`/goal ${GOAL}`), asst('reading the report again')]) : { allowed: true, words: 'no mission guard stands' }
  check('the next turn end is judged anew for the re-armed goal (held as not completed on the claim road), not paused by the old record', judged.allowed === false && judged.words.startsWith(`Mission not completed: ${GOAL} — `) && readMissionCard(S)?.state === 'armed' && readMissionCard(S)?.iterations === 1, j({ judged: judged.words.split('\n')[0], card: readMissionCard(S) }))
  clearActiveMission(S)
}

section('§8 the concourse paints no marker: the live tile\'s last line and the now label elide the completion line')
{
  const { lastLineOf } = await import('../../src/components/concourse/liveTiles.ts')
  const { tailActivity, activityNowLabel } = await import('../../src/services/concourse/concourseSnapshot.ts')
  const { entryToRecord } = await import('../../src/fabric/entryCodec.ts')
  const { ordinalOf } = await import('../../src/fabric/ordinal.ts')
  const { workerTranscriptPath } = await import('../../src/services/concourse/workerTranscript.ts')
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const { dirname } = await import('node:path')
  check('the live tile\'s last line drops a trailing completion line and keeps the words before it', lastLineOf(`wrote hello.txt with the word hello.\n${MISSION_MET_SENTINEL}\n`) === 'wrote hello.txt with the word hello.' && lastLineOf(`done\n${MISSION_MET_SENTINEL}`) === 'done' && lastLineOf('still working') === 'still working', j([lastLineOf(`wrote hello.txt with the word hello.\n${MISSION_MET_SENTINEL}\n`), lastLineOf(`done\n${MISSION_MET_SENTINEL}`)]))
  const SID = 'goal-concourse-tile-1'
  const WS = join(HOME, 'ws-goal-tile')
  const path = workerTranscriptPath({ sessionId: SID, workspaceId: WS })
  mkdirSync(dirname(path), { recursive: true })
  let n = 0
  const ctx = { sessionId: SID, nextOrdinal: () => ordinalOf(++n), observedAt: '2026-11-04T12:00:00.000Z', source: { channel: 'interactive' } }
  const entries = [
    { type: 'user', message: { role: 'user', content: 'go' }, timestamp: '2026-11-04T12:00:00.000Z' },
    { type: 'assistant', timestamp: '2026-11-04T12:00:01.000Z', message: { id: 'm1', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: `wrote hello.txt with the word hello.\n${MISSION_MET_SENTINEL}` }], usage: { input_tokens: 10, output_tokens: 5 } } },
  ]
  writeFileSync(path, entries.map(e => JSON.stringify(entryToRecord(e as never, ctx as never))).join('\n') + '\n', 'utf8')
  const activity = tailActivity({ sessionId: SID, workspaceId: WS })
  check('the now label reads the closing words without the completion line', activity?.kind === 'text' && activity.label === 'wrote hello.txt with the word hello.' && activityNowLabel(activity) === 'wrote hello.txt with the word hello.', j(activity))
  const onlyMarker = [
    entries[0],
    { type: 'assistant', timestamp: '2026-11-04T12:00:01.000Z', message: { id: 'm2', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'all green, pushed.' }, { type: 'text', text: MISSION_MET_SENTINEL }], usage: { input_tokens: 10, output_tokens: 5 } } },
  ]
  n = 0
  writeFileSync(path, onlyMarker.map(e => JSON.stringify(entryToRecord(e as never, ctx as never))).join('\n') + '\n', 'utf8')
  const earlier = tailActivity({ sessionId: SID, workspaceId: WS })
  check('a text block that is only the completion line yields to the words before it', earlier?.kind === 'text' && earlier.label === 'all green, pushed.', j(earlier))
}

section("§9 the judge's answer is read strictly: one JSON object, a known verdict, a one-line reason — anything else is not yet")
{
  const read = judgeModule?.readJudgeAnswer
  const verdictOf = judgeModule?.verdictOfAnswer
  check('the judge module exposes the reader and the mapping', typeof read === 'function' && typeof verdictOf === 'function')
  if (read !== undefined && verdictOf !== undefined) {
    check('the three well-formed verdicts read as themselves with their reasons', j(read('{"verdict":"met","reason":"hello.txt holds hello"}')) === j({ kind: 'met', reason: 'hello.txt holds hello' }) && j(read(' {"verdict":"not yet","reason":"no file yet"} \n')) === j({ kind: 'not yet', reason: 'no file yet' }) && j(read('{"reason":"needs the operator","verdict":"impossible"}')) === j({ kind: 'impossible', reason: 'needs the operator' }))
    const prose = 'Looks done. {"verdict":"met","reason":"all good"}'
    const noReason = '{"verdict":"met"}'
    const emptyReason = '{"verdict":"met","reason":"  "}'
    const twoLines = '{"verdict":"met","reason":"first line\\nsecond line"}'
    const unknown = '{"verdict":"maybe","reason":"who knows"}'
    const notJson = 'met — the file is there'
    const list = '[{"verdict":"met","reason":"x"}]'
    check('a prose-wrapped object, a missing or empty reason, a two-line reason, an unknown verdict, plain prose and a list are unreadable', [prose, noReason, emptyReason, twoLines, unknown, notJson, list].every(text => read(text) === null), j([prose, noReason, emptyReason, twoLines, unknown, notJson, list].map(text => read(text))))
    check("an unreadable answer maps to not yet with the reason 'the judge gave no readable verdict', never to met and never with an invented reason", [prose, noReason, unknown, notJson].every(text => j(verdictOf(text)) === j({ kind: 'not yet', confidence: 0, reason: judgeModule?.JUDGE_UNREADABLE, road: 'model' })) && verdictOf('{"verdict":"met","reason":"all criteria shown"}').kind === 'met', j(verdictOf(prose)))
    const { readFileSync: readSource } = await import('node:fs')
    const judge = readSource(join(import.meta.dir, '..', '..', 'src/services/mission/goalJudge.ts'), 'utf8')
    check("an API error, a thrown call or the timeout is not the claim road: judgeWithModel answers not yet with 'the judge could not be reached', and null only when no model call can be made", (judge.match(/reason: JUDGE_UNREACHABLE/g) ?? []).length === 2 && /if \(!modelRoadOpen\(call\.model\)\) return null/.test(judge) && !/return null\n\s+\}\n\s+return verdictOfAnswer/.test(judge))
  }
}
await standin.close()
console.log('\n' + '═'.repeat(76))
console.log(failures === 0 ? `✅ ALL GOAL END-STATE PROOFS PASS (${checks} checks)` : `❌ ${failures}/${checks} GOAL END-STATE CHECK(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
