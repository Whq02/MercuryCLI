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
const { guardsEngaged, judgeTurnEnd } = await import('../../src/guards/guards.ts')
const { _resetContinuationLatchesForTesting } = await import('../../src/services/run/continuationLatch.ts')
const { setJevEnabled } = await import('../../src/services/jev/jevSetting.ts')
const { storeJevApiKey } = await import('../../src/services/jev/jevKey.ts')
const { jevLedgerSnapshot, resetJevLedger } = await import('../../src/services/jev/jevLedger.ts')
const { markMutation } = await import('../../src/utils/verification/verificationState.ts')

type Verdict = { kind: 'met' | 'open' | 'ambiguous' | 'unattainable'; confidence: number; reason: string; road: 'jev' | 'claim' | 'compile' }
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
const verdict = (kind: Verdict['kind'], confidence = 0.9, reason = `fixture read the goal as ${kind}`): Verdict => ({ kind, confidence, reason, road: 'jev' })

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
  check('the directive names the end-state check, the completion line and the ask-the-human exit', /judges the end state/.test(directive) && directive.includes(MISSION_MET_SENTINEL) && /one question to the operator/.test(directive))
  check('the directive is short (at most 16 lines)', directive.split('\n').length <= 16, String(directive.split('\n').length))
  check('the imperative re-prompt loop is gone from the directive', !/Stop hook will keep re-prompting/.test(directive) && !/Do not stop until/.test(directive))
}

section("§3 a met end state ends on the judge's verdict, not the block counter")
{
  const S = 'goal-judge-met'
  const GOAL = 'the parser suite is green'
  let asked = 0
  arm(S, GOAL, async () => {
    asked += 1
    return verdict('met', 0.92, 'the evidence shows the suite green')
  })
  const first = await stop(S, [user(`/goal ${GOAL}`), asst('the suite is green now; moving on')])
  check('the stop passes on the judge alone: no completion line in the transcript, no counter burned', first.allowed && asked === 1, j({ first, asked }))
  const live = getActiveMission(S)
  const card = readMissionCard(S)
  check('the mission reads met with the verdict as its reason', live?.met === true && (live?.lastReason ?? '').includes('the evidence shows the suite green'), j(live))
  check('the card settled met at check 0', card?.state === 'met' && card?.iterations === 0 && card?.nextStep === null, j(card))
  clearActiveMission(S)
}
{
  const S = 'goal-judge-outranks-claim'
  const GOAL = 'the parser suite is green'
  arm(S, GOAL, async () => verdict('open', 0.2, 'the suite still fails three cases'))
  const claimed = await stop(S, [user(`/goal ${GOAL}`), asst(`all green.\n${MISSION_MET_SENTINEL}`)])
  check('a completion claim the judge rejects is held', claimed.allowed === false, j(claimed))
  check("the hold's first line names the goal and the check number; the judge's reason rides below", claimed.words.startsWith(`The goal for this session is not yet met (check 1): ${GOAL}`) && claimed.words.includes('the suite still fails three cases'), claimed.words)
  const card = readMissionCard(S)
  check('the card advanced to check 1 and carries the reason', card?.state === 'armed' && card?.iterations === 1 && (card?.nextStep ?? '').includes('not yet met'), j(card))
  clearActiveMission(S)
}
{
  const S = 'goal-no-cap'
  const GOAL = 'every proof in the suite is green'
  arm(S, GOAL, async () => verdict('open', 0.8, 'two proofs still red'))
  check('the record is seeded with the verification record at arm, so the first check already counts', getActiveMission(S)?.lastSeen !== undefined && getActiveMission(S)?.stalledChecks === 0, j(getActiveMission(S)?.lastSeen))
  const transcript: unknown[] = [user(`/goal ${GOAL}`), asst('working')]
  let held = 0
  for (let i = 0; i < 14; i++) {
    await treeChanged()
    const result = await stop(S, transcript)
    if (!result.allowed) held += 1
    transcript.push(asstTool(`round ${i}`), toolResult(), asst(`still red after round ${i}`))
  }
  check('fourteen open verdicts over fourteen rounds that each change the tree hold fourteen stops: no block cap stands down a goal that advances', held === 14 && readMissionCard(S)?.state === 'armed' && getActiveMission(S)?.needsOperator !== true, j({ held, card: readMissionCard(S) }))
  clearActiveMission(S)
}
{
  const S = 'goal-stalled-under-jev'
  const GOAL = 'every proof in the suite is green'
  arm(S, GOAL, async () => verdict('open', 0.8, 'two proofs still red'))
  const transcript: unknown[] = [user(`/goal ${GOAL}`), asst('working')]
  const trail: string[] = []
  for (let i = 0; i < 8; i++) {
    const result = await stop(S, transcript)
    trail.push(result.allowed ? 'pass' : result.words.split('\n')[0]!.slice(0, 60))
    if (result.allowed) break
    transcript.push(meta('(hold)'), asstTool(`reading more (${i})`), toolResult(), asst(i === 2 ? 'I keep reading the same files. Which proof do you mean by red?' : `still reading (${i})`))
  }
  const stall = judgeModule?.GOAL_STALL_CHECKS ?? 0
  check(`open verdicts over rounds that only read files are bounded too: after ${stall} checks that change nothing the goal asks the operator, whatever road answered`, trail.length === stall + 1 && trail.slice(0, stall - 1).every(line => line.startsWith('The goal for this session is not yet met')) && trail[stall - 1]!.startsWith('The goal for this session reads as unattainable') && trail[stall] === 'pass' && readMissionCard(S)?.state === 'needs-operator', j({ trail, card: readMissionCard(S) }))
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
  standin.answerWith(() => answer('met', 0.91))
  arm(S, GOAL)
  const met = await stop(S, [user(`/goal ${GOAL}`), asst('suite green, pushed; the API untouched')])
  const request = standin.received[0]?.body as { model?: string; state?: Record<string, string>; questions?: Record<string, { type?: string; criteria?: Record<string, string> }> } | undefined
  check('one request reached Jev', standin.received.length === 1, String(standin.received.length))
  check('the request carries the goal statement, the closing words and the verification record as its state', (request?.state?.goal ?? '').startsWith('Goal: the parser suite is green and the fix is pushed') && (request?.state?.goal ?? '').includes('Constraints: without touching the public API') && (request?.state?.closing ?? '').includes('suite green, pushed') && typeof request?.state?.verification === 'string' && request?.state?.claimed_met === 'no', j(request?.state))
  check('one choice question with the four verdicts', request?.questions?.goal?.type === 'choice' && j(Object.keys(request?.questions?.goal?.criteria ?? {})) === j(['met', 'open', 'ambiguous', 'unattainable']), j(request?.questions))
  check('the request rides the pinned model on the official road', request?.model === 'jev-1.13.0', j(request?.model))
  check("Jev at 0.91 met: the stop passes and the card reads met on Jev's verdict", met.allowed && readMissionCard(S)?.state === 'met' && (getActiveMission(S)?.lastReason ?? '').includes('Jev read the goal as met'), j({ met, live: getActiveMission(S)?.lastReason }))
  check('the call is counted in the Jev ledger', jevLedgerSnapshot().attempts === 1, j(jevLedgerSnapshot()))
  clearActiveMission(S)

  standin.answerWith(() => answer('open', 0.8))
  arm(S, GOAL)
  const claimed = await stop(S, [user(`/goal ${GOAL}`), asst(`done.\n${MISSION_MET_SENTINEL}`)])
  check("Jev at 0.8 open outranks the completion line: held, with Jev's reading in the words", claimed.allowed === false && claimed.words.includes('Jev read the goal as open'), j(claimed))
  const claimedRequest = standin.received[1]?.body as { state?: Record<string, string> } | undefined
  check('the claim is evidence Jev sees, not the verdict', claimedRequest?.state?.claimed_met === 'yes', j(claimedRequest?.state))
  clearActiveMission(S)

  standin.answerWith(() => answer('met', 0.5))
  arm(S, GOAL)
  const leaning = await stop(S, [user(`/goal ${GOAL}`), asst('probably green')])
  check('a met reading under the 0.6 floor keeps the goal open', leaning.allowed === false && leaning.words.includes('under the 0.6 floor'), j(leaning))
  clearActiveMission(S)

  standin.answerWith(undefined)
  standin.next({ status: 500, body: { error: { message: 'fixture down' } } })
  arm(S, GOAL)
  const down = await stop(S, [user(`/goal ${GOAL}`), asst(`pushed.\n${MISSION_MET_SENTINEL}`)])
  check('Jev down: the claim stands and the goal is met on the claim road', down.allowed && (getActiveMission(S)?.lastReason ?? '').includes('the claim stands'), j({ down, live: getActiveMission(S)?.lastReason }))
  clearActiveMission(S)
  setJevEnabled(false)
  storeJevApiKey(null)
  check('Jev off again: the road is closed', judgeModule !== null && judgeModule.goalJudgeOpen() === false)
}

section('§5 the ask-the-human exit: an ambiguous or unattainable goal ends with a question to the operator, never silently and never by looping')
{
  const S = 'goal-ambiguous'
  const GOAL = 'the report is improved'
  arm(S, GOAL, async () => verdict('ambiguous', 0.85, 'improved names no observable state'))
  const first = await stop(S, [user(`/goal ${GOAL}`), asst('I tightened two paragraphs')])
  check('the first stop is held once, with the words that send the question to the operator', first.allowed === false && first.words.startsWith('The goal for this session reads as ambiguous: improved names no observable state') && /one question to the operator/.test(first.words), first.words)
  check('the card still reads armed while the question is being asked', readMissionCard(S)?.state === 'armed' && (readMissionCard(S)?.nextStep ?? '').includes('asking the operator'), j(readMissionCard(S)))
  const second = await stop(S, [user(`/goal ${GOAL}`), asst('I tightened two paragraphs'), user('(hold)'), asst('The goal names no measurable state. Which reading do you want: shorter, or more complete?')])
  check('the next stop passes: the goal ends with the question pending', second.allowed, j(second))
  const card = readMissionCard(S)
  check('the card reads needs-operator and carries the question as its next step', card?.state === 'needs-operator' && (card?.nextStep ?? '').includes('Which reading do you want'), j(card))
  check('the live record says so too', getActiveMission(S)?.needsOperator === true && getActiveMission(S)?.met !== true, j(getActiveMission(S)))
  const third = await stop(S, [user(`/goal ${GOAL}`), asst('I tightened two paragraphs'), user('(hold)'), asst('Which reading?'), user('(a stray continuation)'), asst('still here')])
  check('no loop: a later stop passes without another hold', third.allowed, j(third))
  clearActiveMission(S)
}
{
  const S = 'goal-asks-itself'
  const GOAL = 'the migration is applied to the right database'
  let asked = 0
  arm(S, GOAL, async () => {
    asked += 1
    return verdict('open')
  })
  const own = await stop(S, [user(`/goal ${GOAL}`), asst('Two databases match that name. Which one should receive the migration?')])
  check("a turn that already ends on a question to the operator is the exit itself: no hold, no judge call", own.allowed && asked === 0, j({ own, asked }))
  check('the card reads needs-operator with the question', readMissionCard(S)?.state === 'needs-operator' && (readMissionCard(S)?.nextStep ?? '').includes('Which one should receive the migration?'), j(readMissionCard(S)))
  clearActiveMission(S)
  for (const closing of ['**Which database should receive the migration?**', 'Two match.\n"Which one?"', 'Which one do you mean (prod or staging)?']) {
    arm(S, GOAL, async () => verdict('open'))
    const styled = await stop(S, [user(`/goal ${GOAL}`), asst(closing)])
    check(`a closing question wrapped in markdown or quotes is a question too: ${j(closing)}`, styled.allowed && readMissionCard(S)?.state === 'needs-operator', j({ styled, card: readMissionCard(S) }))
    clearActiveMission(S)
  }
  arm(S, GOAL, async () => verdict('open'))
  const midText = await stop(S, [user(`/goal ${GOAL}`), asst('Is the migration applied? Not yet: the second database still lacks it.')])
  check('a question answered in the same breath is not a question to the operator', midText.allowed === false && readMissionCard(S)?.state === 'armed', j(midText))
  clearActiveMission(S)
  arm(S, GOAL, async () => verdict('open'))
  const stale = await stop(S, [asst('Do you want the prod or the staging database?'), meta(buildMissionDirective(GOAL)), user('go'), asstToolOnly(), toolResult()])
  check('a turn without closing words never reads a question from before the goal: the closing stops at the turn boundary', stale.allowed === false && readMissionCard(S)?.state === 'armed', j({ stale: stale.words.split('\n')[0], card: readMissionCard(S)?.state }))
  _resetContinuationLatchesForTesting()
  const earlier = await stop(S, [user(`/goal ${GOAL}`), asst('Which one?'), user('the second'), asstToolOnly(), toolResult()])
  check("nor a question from the previous turn, answered since", earlier.allowed === false && readMissionCard(S)?.state === 'armed', j({ earlier: earlier.words.split('\n')[0] }))
  clearActiveMission(S)
}
{
  const S = 'goal-contradiction'
  const GOAL = 'ensure X is simultaneously enabled and disabled'
  arm(S, GOAL, async () => verdict('open'))
  const first = await stop(S, [user(`/goal ${GOAL}`), asst('trying')])
  const second = await stop(S, [user(`/goal ${GOAL}`), asst('trying'), user('(hold)'), asst('Enabled and disabled at once cannot both hold. Which state do you want?')])
  check('a goal that contradicts itself at compile asks the operator after one hold and ends', first.allowed === false && first.words.startsWith('The goal for this session reads as unattainable: the goal demands mutually exclusive states at once') && second.allowed && readMissionCard(S)?.state === 'needs-operator', j({ first: first.words.split('\n')[0], second, card: readMissionCard(S) }))
  clearActiveMission(S)
}
{
  const S = 'goal-stalled'
  const GOAL = 'the flaky test is fixed'
  arm(S, GOAL, null)
  const transcript: unknown[] = [user(`/goal ${GOAL}`), asst('thinking about it')]
  const trail: boolean[] = []
  for (let i = 0; i < 8; i++) {
    const result = await stop(S, transcript)
    trail.push(result.allowed)
    if (result.allowed) break
    transcript.push(user('(hold)'), asst(i === 2 ? 'I cannot see what makes it flaky. What does the failing run look like on your machine?' : `still thinking (${i})`))
  }
  const stall = judgeModule?.GOAL_STALL_CHECKS ?? 0
  check(`with the judge road closed, ${stall} checks that change nothing end the goal with a question, not a silent stand-down`, j(trail) === j([false, false, false, true]) && readMissionCard(S)?.state === 'needs-operator', j({ trail, card: readMissionCard(S) }))
  clearActiveMission(S)
}
{
  const S = 'goal-reads-only'
  const GOAL = 'the flaky test is fixed'
  arm(S, GOAL, null)
  const transcript: unknown[] = [user(`/goal ${GOAL}`), asst('looking')]
  const trail: string[] = []
  for (let i = 0; i < 8; i++) {
    const result = await stop(S, transcript)
    trail.push(result.allowed ? 'pass' : result.words.split('\n')[0]!.slice(0, 60))
    if (result.allowed) break
    transcript.push(user('(hold)'), asstTool(`reading test ${i}`), toolResult(), asstTool(`grepping ${i}`), toolResult(), asst(i === 2 ? 'Nothing in the files explains the flake. What does the failing run look like on your machine?' : `read more (${i})`))
  }
  const stall = judgeModule?.GOAL_STALL_CHECKS ?? 0
  check(`turns that only read files are not progress: ${stall} such checks end the goal on the ask-the-human exit`, trail.length === stall + 1 && trail[stall - 1]!.startsWith('The goal for this session reads as unattainable') && trail[stall] === 'pass' && readMissionCard(S)?.state === 'needs-operator' && (readMissionCard(S)?.nextStep ?? '').includes('What does the failing run look like'), j({ trail, card: readMissionCard(S) }))
  clearActiveMission(S)
  arm(S, GOAL, null)
  const edits: unknown[] = [user(`/goal ${GOAL}`), asst('editing')]
  let heldWithProgress = 0
  for (let i = 0; i < stall + 2; i++) {
    await treeChanged()
    const result = await stop(S, edits)
    if (!result.allowed) heldWithProgress += 1
    edits.push(user('(hold)'), asst(`edited again (${i})`))
  }
  check('rounds that change the tree keep the goal open past the stall count', heldWithProgress === stall + 2 && readMissionCard(S)?.state === 'armed', j({ heldWithProgress, card: readMissionCard(S) }))
  clearActiveMission(S)
}

section('§6 the surfaces keep their words: the receipt, the panel, the card')
{
  const jsx = await import('../../src/commands/mission/mission-jsx.tsx')
  const S = 'goal-surface'
  arm(S, 'the rail paints the goal', async () => verdict('ambiguous', 0.9, 'no observable state'))
  const { readFileSync } = await import('node:fs')
  const panel = readFileSync(join(import.meta.dir, '..', '..', 'src/commands/mission/mission-jsx.tsx'), 'utf8')
  check('the interactive panel paints met and NEEDS THE OPERATOR as distinct states, the block-cap state gone', /Mission met — stops are allowed/.test(panel) && /NEEDS THE OPERATOR/.test(panel) && !/block cap/.test(panel) && typeof jsx.call === 'function')
  const local = readFileSync(join(import.meta.dir, '..', '..', 'src/commands/mission/mission.ts'), 'utf8')
  check('the print form mirrors the same states', /Mission met/.test(local) && /NEEDS THE OPERATOR/.test(local) && !/block cap/.test(local))
  const guard = readFileSync(join(import.meta.dir, '..', '..', 'src/guards/mission.ts'), 'utf8')
  check('the guard carries no block counter and no maxBlocks option', !/maxBlocks/.test(guard) && !/DEFAULT_MISSION_MAX_BLOCKS/.test(guard))
  check('the guard still claims through the shared continuation latch', guard.includes('claimContinuation('))
  clearActiveMission(S)
}

await standin.close()
console.log('\n' + '═'.repeat(76))
console.log(failures === 0 ? `✅ ALL GOAL END-STATE PROOFS PASS (${checks} checks)` : `❌ ${failures}/${checks} GOAL END-STATE CHECK(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
