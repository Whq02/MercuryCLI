#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  AFTER_RETURN_LINE,
  AGENT_TURN_ASK,
  CREW_NOTICE,
  CREW_TURN_ASK,
  DEEPER_DONE,
  doneText,
  FIRST_LINE,
  FOLD_LINE,
  FOLD_SUMMARY_MARK,
  FOLD_TURN_ASK,
  FORK_DONE,
  FORK_TURN_ASK,
  LINE,
  NESTED_TURN_ASK,
  RETURN_LINE,
  SECOND_LINE,
  SLEEP_TOOL_TURN_ASK,
  WORKFLOW_AGENT_DONE,
  WORKFLOW_ALLOW_RULE,
  WORKFLOW_NAME,
  WORKFLOW_SCRIPT,
  WORKFLOW_TURN_ASK,
} from './dupline-fixture-words.ts'
import { argAfter, bootRunner, bound, briefly, carriersOf, carrying, childEnv, CLOCK_TOLERANCE_MS, deliveryClockOf, describeRequests, DIST, exportWorld, inMainFile, isDrainedMainRow, isSession, isOutcome, j, makeTally, NODE, queueJournal, removeWorld, REPO, requestsOf, SCRATCH_ROOT, seedHome, settledCarriers, sleep, startFixture, waitWire, type Carrier, type Fixture, type Frame, type Runner, type Wire } from './dupline-world.ts'

const { check, section, finish, failed } = makeTally('prove-dupline-arms')
const src = (rel: string): string => readFileSync(join(REPO, 'src', ...rel.split('/')), 'utf8')
const only = new Set((argAfter('--only') ?? '').split(',').map(a => a.trim()).filter(a => a !== ''))
const runs = (arm: string): boolean => only.size === 0 || only.has(arm)

section('S the doors a sub-agent could nest or fork through are shut at their owners (the source)')
{
  const { ALL_AGENT_DISALLOWED_TOOLS, CUSTOM_AGENT_DISALLOWED_TOOLS } = await import('../../src/constants/tools.ts')
  const { AGENT_TOOL_NAME } = await import('../../src/tools/AgentTool/constants.ts')
  const { WORKFLOW_TOOL_NAME } = await import('../../src/tools/WorkflowTool/constants.ts')
  check('every sub-agent loses the Crewmate tool and the Workflow tool (the one deny set)', ALL_AGENT_DISALLOWED_TOOLS.has(AGENT_TOOL_NAME) && ALL_AGENT_DISALLOWED_TOOLS.has(WORKFLOW_TOOL_NAME) && CUSTOM_AGENT_DISALLOWED_TOOLS === ALL_AGENT_DISALLOWED_TOOLS)
  check('a launch that names no type takes the default type', src('utils/crew/agentLaunchPlan.ts').includes("(i.requestedType || undefined) ?? i.defaultAgentType"))
  const hooks = src('tools/WorkflowTool/agentHooks.ts')
  check("a workflow's agent queries under its own source label and its own agent id", hooks.includes('querySource: getQuerySourceForAgent(') && hooks.includes('agentId: args.agentId,'))
}

const U0 = '00000000-0000-4000-8000-000000000000'
const BATCH_ITEM_SHA = '1f925c0d1a5dcee2'
const UT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const uuidOf = (n: number): string => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`

type Sent = { word: string; uuid: string; sentAt: string }
type World = { name: string; home: string; fx: Fixture; runner: Runner; sessionId: string; failedAtOpen: number; holdFile?: string }

async function openWorld(name: string, agentSleepSeconds: number, foldPaceMs = 0, extra: { argv?: string[]; seed?: (cwd: string) => void; hold?: boolean } = {}): Promise<World> {
  const failedAtOpen = failed()
  const home = join(SCRATCH_ROOT, `mercury-dupline-${name}-${process.pid}`)
  const cwd = join(home, 'repo')
  seedHome(home, cwd)
  extra.seed?.(cwd)
  const holdFile = extra.hold === true ? join(home, 'release-final-answer') : undefined
  const fx = await startFixture(join(home, 'wire.jsonl'), agentSleepSeconds, 6, foldPaceMs, holdFile)
  const runner = bootRunner({ cwd, env: childEnv(home, fx.port), extraArgv: extra.argv })
  void runner.prompt('hello there', U0)
  const init = await runner.waitFor('the session row', isSession, bound(90_000))
  const first = await runner.waitFor('the first turn', isOutcome, bound(90_000))
  check(`${name}: the runner is up and the first turn answered`, init !== null && first !== null, runner.stderr().split('\n').slice(-5).join(' | '))
  return { name, home, fx, runner, sessionId: String(init?.session_id ?? ''), failedAtOpen, ...(holdFile === undefined ? {} : { holdFile }) }
}
async function closeWorld(w: World): Promise<void> {
  await w.runner.stop(bound(8_000))
  w.fx.kill()
  exportWorld(w.name, w.home, { 'frames.jsonl': w.runner.frames.map(l => JSON.stringify(l)).join('\n') + '\n', 'stderr.txt': w.runner.stderr() })
  if (failed() === w.failedAtOpen) await removeWorld(w.home)
  else console.log(`  [forensics] ${w.name} world kept: ${w.home}\n${w.runner.stderr().split('\n').slice(-12).join('\n')}`)
}
function send(w: World, word: string, n: number): Sent {
  const sent = { word, uuid: uuidOf(n), sentAt: new Date().toISOString() }
  void w.runner.prompt(word, sent.uuid, sent.sentAt)
  return sent
}
const projectsOf = (w: World): string => join(w.home, 'projects')
const wireOf = (w: World, arm: string, step: number): ((x: Wire) => boolean) => x => x.kind === 'request' && x.arm === arm && x.step === step

async function toolStarted(w: World, prefix: string, after: number): Promise<void> {
  const call = await w.runner.waitFor('the tool call on the product wire', f => f.type === 'tool_call' && String(f.call_id ?? '').startsWith(prefix), bound(60_000), after)
  check(`${w.name}: the tool call reached the wire before the line was sent`, call !== null, j(call))
}
function lineLaw(w: World, sent: Sent, subArms: string[], mainArm: string, mainStep: number, carriers: Carrier[]): void {
  const requests = requestsOf(w.fx.wire)
  const subCarrying = carrying(requests.filter(r => subArms.includes(String(r.arm))), sent.word)
  const mainCarrying = carrying(requests.filter(r => r.arm === mainArm), sent.word)
  check(`${w.name}: no request of a sub-agent carried "${sent.word}"`, subCarrying.length === 0, j(subCarrying.map(r => [r.n, r.arm, r.step])))
  check(`${w.name}: the session's own request at its boundary carried "${sent.word}", once`, mainCarrying.length >= 1 && mainCarrying[0]!.step === mainStep && mainCarrying[0]!.counts?.[sent.word] === 1, describeRequests(requests, [sent.word]))
  const mine = carriers.filter(c => c.word === sent.word)
  const mainRows = mine.filter(isDrainedMainRow)
  const agentRows = mine.filter(c => !inMainFile(c))
  check(`${w.name}: the session's transcript holds "${sent.word}" once, as the drained row under the send's identity and clock`, mainRows.length === 1 && mine.filter(inMainFile).length === 1 && mainRows[0]!.sourceUuid === sent.uuid && mainRows[0]!.occurredAt === sent.sentAt && mainRows[0]!.file.endsWith(`${w.sessionId}.jsonl`), briefly(mine))
  check(`${w.name}: no sub-agent's transcript holds "${sent.word}"`, agentRows.length === 0, briefly(agentRows))
}
function handoverLaw(w: World, result: Frame | null, ask: string, mainArm: string, mainStep: number, handedArms: string[], before: number): void {
  const requests = requestsOf(w.fx.wire)
  const boundary = requests.find(r => r.arm === mainArm && r.step === mainStep)
  const handedLast = requests.filter(r => handedArms.includes(String(r.arm))).map(r => r.at).sort((a, b) => b - a)[0] ?? 0
  const notices = requests.filter(r => r.arm === 'plain' && String(r.ask ?? '').startsWith('<task-notification>'))
  const frames = w.runner.frames.slice(before)
  const spoken = frames.filter(f => f.type === 'text' && f.turn !== undefined && String(f.text ?? '').startsWith(doneText(ask)))
  const parked = frames.findIndex(f => f.type === 'turn' && f.state === 'waiting' && Number(f.agents) >= 1)
  const ended = frames.reduce((last, f, i) => (f.type === 'task' && f.state === 'ended' ? i : last), -1)
  const outcomes = frames.filter(isOutcome)
  check(`${w.name}: the line handed the sub-agent to the background — the Crewmate tool returned with the handover receipt and the session's model answered with its own text at that boundary, once`, boundary !== undefined && boundary.lastToolResult?.isError === false && /launched in the background/i.test(boundary.lastToolResult?.text ?? '') && spoken.length === 1, j([boundary?.n, boundary?.lastToolResult, spoken.map(f => f.text)]))
  check(`${w.name}: the turn then parked on the handed-over sub-agent, which ran on to its own end (its last request after the boundary); its completion notice reached the session's own model once and the cycle settled with one outcome after it`, boundary !== undefined && handedLast > boundary.at && notices.length === 1 && parked >= 0 && ended > parked && outcomes.length === 1 && frames.indexOf(outcomes[0]!) > ended && result !== null && result.status === 'completed', j({ boundaryAt: boundary?.at, handedLast, notices: notices.map(r => r.n), parked, ended, outcomes: outcomes.map(f => [frames.indexOf(f), f.status, f.answer]) }))
}
function parkedLineLaw(w: World, sent: Sent, subArms: string[], carriers: Carrier[]): void {
  const requests = requestsOf(w.fx.wire)
  const subCarrying = carrying(requests.filter(r => subArms.includes(String(r.arm))), sent.word)
  const mainCarrying = carrying(requests.filter(r => !subArms.includes(String(r.arm))), sent.word)
  check(`${w.name}: no request of a sub-agent carried "${sent.word}"`, subCarrying.length === 0, j(subCarrying.map(r => [r.n, r.arm, r.step])))
  check(`${w.name}: the session's own model read "${sent.word}" once, as the parked turn's own next request (the line is its ask)`, mainCarrying.length >= 1 && mainCarrying[0]!.step === 0 && String(mainCarrying[0]!.ask ?? '').trim() === sent.word && mainCarrying[0]!.counts?.[sent.word] === 1, describeRequests(requests, [sent.word]))
  const mine = carriers.filter(c => c.word === sent.word)
  const mainRows = mine.filter(inMainFile)
  check(`${w.name}: the session's transcript holds "${sent.word}" once, as the parked turn's own input row under the send's identity, within the clock tolerance of the send`, mainRows.length === 1 && mine.length === 1 && mainRows[0]!.kind === 'input' && mainRows[0]!.uuid === sent.uuid && Math.abs(Date.parse(mainRows[0]!.occurredAt) - Date.parse(sent.sentAt)) <= CLOCK_TOLERANCE_MS && mainRows[0]!.file.endsWith(`${w.sessionId}.jsonl`), briefly(mine))
  check(`${w.name}: no sub-agent's transcript holds "${sent.word}"`, mine.filter(c => !inMainFile(c)).length === 0, briefly(mine.filter(c => !inMainFile(c))))
}
type WordCarrier = Carrier & { word: string }
async function settled(w: World, words: string[], timeoutMs: number, want: (cs: WordCarrier[]) => boolean): Promise<WordCarrier[]> {
  const read = (): WordCarrier[] => words.flatMap(word => carriersOf(projectsOf(w), word).map(c => ({ ...c, word })))
  const until = Date.now() + timeoutMs
  for (;;) {
    const cs = read()
    if (want(cs) || Date.now() >= until) return cs
    await sleep(100)
  }
}
const drainedOnce = (words: string[]) => (cs: WordCarrier[]): boolean => words.every(word => cs.some(c => c.word === word && isDrainedMainRow(c)))
async function queuedBoth(w: World, words: string[], timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const journal = queueJournal(projectsOf(w))
    if (words.every(word => journal.some(row => row.operation === 'enqueue' && row.content === word))) return true
    if (Date.now() >= until) return false
    await sleep(100)
  }
}

if (!existsSync(DIST)) {
  console.log(`\nFAIL ${DIST} missing — run \`bun run build.ts\` first (every arm boots the BUILT product)`)
  check('the built bundle is present', false, DIST)
} else {
  if (runs('A1')) {
  section("A1 two lines sent during one sub-agent's run reach the session's own model once each, in order: the first hands the sub-agent to the background and drains at the Crewmate tool's return, the second runs as the parked turn's own next request")
    const w = await openWorld('two-lines', 10)
    const before = w.runner.frames.length
    void w.runner.prompt(AGENT_TURN_ASK, UT)
    check('the sub-agent opened its own conversation', (await waitWire(w.fx.wire, "the sub-agent's first request", wireOf(w, 'subwork', 0), bound(60_000))) !== null)
    await toolStarted(w, 'toolu_sub_c', before)
    const first = send(w, FIRST_LINE, 1)
    const parked = await w.runner.waitFor('the handover parked on its agent', f => f.type === 'turn' && f.state === 'waiting' && Number(f.agents) >= 1, bound(60_000), before)
    check('the first line handed the agent over before the second line was sent', parked !== null, j(parked))
    const second = send(w, SECOND_LINE, 2)
    const result = await w.runner.waitFor("the agent turn's result", isOutcome, bound(90_000), before)
    handoverLaw(w, result, AGENT_TURN_ASK, 'agent', 1, ['subwork'], before)
    const carriers = await settled(w, [FIRST_LINE, SECOND_LINE], bound(10_000), cs => drainedOnce([FIRST_LINE])(cs) && cs.some(c => c.word === SECOND_LINE && inMainFile(c)))
    lineLaw(w, first, ['subwork'], 'agent', 1, carriers)
    parkedLineLaw(w, second, ['subwork'], carriers)
    const requests = requestsOf(w.fx.wire)
    const firstRequest = carrying(requests, FIRST_LINE)[0]
    const secondRequest = carrying(requests, SECOND_LINE)[0]
    check('the two lines reached the session\'s model in the order sent, each in a request of its own', firstRequest !== undefined && secondRequest !== undefined && firstRequest.n < secondRequest.n && (firstRequest.counts?.[SECOND_LINE] ?? 0) === 0, describeRequests(requests, [FIRST_LINE, SECOND_LINE]))
    const mainRows = carriers.filter(inMainFile).sort((a, b) => Number(a.ordinal) - Number(b.ordinal))
    check('the two rows landed in the order sent: the drained row, then the parked turn\'s input row', mainRows.length === 2 && mainRows[0]!.word === FIRST_LINE && isDrainedMainRow(mainRows[0]!) && mainRows[1]!.word === SECOND_LINE && mainRows[1]!.kind === 'input', briefly(mainRows))
    await closeWorld(w)
  }

  if (runs('A2')) {
  section("A2 a line sent while the sub-agent runs the Sleep tool reaches the session's own model once, at the handover boundary; the sub-agent crosses its Sleep boundary in the background")
    const w = await openWorld('sleep-tool', 10)
    const before = w.runner.frames.length
    void w.runner.prompt(SLEEP_TOOL_TURN_ASK, UT)
    const opened = await waitWire(w.fx.wire, "the sub-agent's first request", wireOf(w, 'subsleep', 0), bound(60_000))
    check('the sub-agent opened with the Sleep tool in its pool', opened !== null && opened.hasSleepTool === true, j(opened))
    await toolStarted(w, 'toolu_subsleep_c', before)
    const line = send(w, LINE, 1)
    const result = await w.runner.waitFor("the agent turn's result", isOutcome, bound(90_000), before)
    handoverLaw(w, result, SLEEP_TOOL_TURN_ASK, 'agentsleep', 1, ['subsleep'], before)
    const afterSleep = requestsOf(w.fx.wire).find(wireOf(w, 'subsleep', 1))
    check('the sub-agent crossed its Sleep boundary (the tool ran, no error)', afterSleep !== undefined && afterSleep.lastToolResult?.isError === false, j(afterSleep?.lastToolResult))
    const carriers = await settled(w, [LINE], bound(10_000), drainedOnce([LINE]))
    lineLaw(w, line, ['subsleep'], 'agentsleep', 1, carriers)
    await closeWorld(w)
  }

  if (runs('A3')) {
  section("A3 a crew notice raised while a sub-agent runs reaches the session's own model once, at the Crewmate tool's return")
    const w = await openWorld('crew-notice', 10)
    const before = w.runner.frames.length
    void w.runner.prompt(CREW_TURN_ASK, UT)
    const quick = await waitWire(w.fx.wire, 'the background agent', wireOf(w, 'quick', 0), bound(60_000))
    const fore = await waitWire(w.fx.wire, 'the foreground sub-agent', wireOf(w, 'subwork', 0), bound(60_000))
    check('both agents launched from the one block: the quick one in the background, the sleeping one in front', quick !== null && fore !== null)
    await toolStarted(w, 'toolu_sub_c', before)
    const noticeDeadline = Date.now() + bound(60_000)
    const noticeQueued = (): boolean => queueJournal(projectsOf(w)).some(row => row.operation === 'enqueue' && row.content.includes(CREW_NOTICE))
    while (!noticeQueued() && Date.now() < noticeDeadline) await sleep(100)
    check('the quick agent completion is queued before the handover line', noticeQueued())
    const line = send(w, LINE, 1)
    const result = await w.runner.waitFor("the crew turn's result", isOutcome, bound(90_000), before)
    handoverLaw(w, result, CREW_TURN_ASK, 'crew', 1, ['subwork'], before)
    const carriers = await settled(w, [LINE, CREW_NOTICE], bound(10_000), drainedOnce([LINE, CREW_NOTICE]))
    lineLaw(w, line, ['subwork', 'quick'], 'crew', 1, carriers)
    const requests = requestsOf(w.fx.wire)
    check('no request of either agent carried the notice', carrying(requests.filter(r => r.arm === 'subwork' || r.arm === 'quick'), CREW_NOTICE).length === 0, describeRequests(requests, [CREW_NOTICE]))
    const noticeRequest = carrying(requests.filter(r => r.arm === 'crew'), CREW_NOTICE)[0]
    check("the session's own request after the Crewmate tool carried the notice, once", noticeRequest !== undefined && noticeRequest.step === 1 && noticeRequest.counts?.[CREW_NOTICE] === 1, describeRequests(requests, [CREW_NOTICE]))
    const noticeRows = carriers.filter(c => c.word === CREW_NOTICE)
    const noticeMain = noticeRows.filter(isDrainedMainRow)
    const lastSub = requests.filter(r => r.arm === 'subwork').map(r => r.at).sort((a, b) => b - a)[0] ?? 0
    const lastQuick = requests.filter(r => r.arm === 'quick').map(r => r.at).sort((a, b) => b - a)[0] ?? 0
    check("the session's transcript holds the notice once, delivered at the handover boundary: after the quick agent's completion, no later than the session's own next request, while the sleeping sub-agent still ran in the background (the row's delivery clock, never its stamp: the stamp is the completion the row sits at)", noticeMain.length === 1 && noticeRows.filter(inMainFile).length === 1 && noticeRequest !== undefined && deliveryClockOf(noticeMain[0]!) >= lastQuick - 2000 && deliveryClockOf(noticeMain[0]!) <= noticeRequest.at + 2000 && lastSub > deliveryClockOf(noticeMain[0]!), briefly(noticeRows))
    check("the notice row's stamp is its completion — the send clock the queue gave it, no later than the sub-agent's last request and no later than its own delivery", noticeMain.length === 1 && noticeMain[0]!.deliveredAt !== '' && noticeMain[0]!.occurredAt === noticeMain[0]!.sentAt && Date.parse(noticeMain[0]!.occurredAt) <= lastSub + 2000 && Date.parse(noticeMain[0]!.occurredAt) <= deliveryClockOf(noticeMain[0]!), briefly(noticeRows))
    check("no sub-agent's transcript holds the notice", noticeRows.every(inMainFile), briefly(noticeRows.filter(c => !inMainFile(c))))
    await closeWorld(w)
  }

  if (runs('A4')) {
  section("A4 fold 46ao: a line sent during a sub-agent's content-sized compaction fold reaches the session's own model once, at the handover boundary; the fold lands and the sub-agent goes on in the background")
    const w = await openWorld('fold', 3, 800)
    const before = w.runner.frames.length
    void w.runner.prompt(FOLD_TURN_ASK, UT)
    const fold = await waitWire(w.fx.wire, "the sub-agent's fold request", x => x.kind === 'fold' && x.arm === 'subfold', bound(60_000))
    check('the sub-agent folded its own conversation (the fold request carries its opening)', fold !== null, j(w.fx.wire().map(x => [x.kind, x.arm, x.step])))
    const line = send(w, FOLD_LINE, 1)
    const result = await w.runner.waitFor("the fold turn's result", isOutcome, bound(120_000), before)
    handoverLaw(w, result, FOLD_TURN_ASK, 'agentfold', 1, ['subfold'], before)
    const wire = w.fx.wire()
    const landed = wire.find(x => x.kind === 'fold-landed' && x.n === fold?.n)
    const postFold = wire.filter(x => x.kind === 'request' && x.arm === 'subfold' && x.folded === true)
    check('the fold landed and the sub-agent went on to another tool round on the folded record', landed !== undefined && postFold.some(x => x.step === 0) && postFold.some(x => x.step === 1), j(postFold.map(x => [x.n, x.step])))
    check('the line was sent while the fold streamed', landed !== undefined && Date.parse(line.sentAt) < landed.at, `sent ${line.sentAt}, landed ${landed === undefined ? '-' : new Date(landed.at).toISOString()}`)
    const carriers = await settled(w, [FOLD_LINE], bound(10_000), drainedOnce([FOLD_LINE]))
    lineLaw(w, line, ['subfold'], 'agentfold', 1, carriers)
    await closeWorld(w)
  }

  if (runs('A5')) {
  section('A5 a sub-agent cannot nest: its Crewmate call is refused (in the background too), and the line sent during its run reaches the session\'s own model once')
    const w = await openWorld('nested', 5)
    const before = w.runner.frames.length
    void w.runner.prompt(NESTED_TURN_ASK, UT)
    const opened = await waitWire(w.fx.wire, "the sub-agent's first request", wireOf(w, 'subnested', 0), bound(60_000))
    check("the sub-agent's pool carries neither the Crewmate tool nor the Workflow tool", opened !== null && opened.hasAgentTool === false && opened.hasWorkflowTool === false, j(opened))
    await toolStarted(w, 'toolu_subnest_c', before)
    const line = send(w, LINE, 1)
    const result = await w.runner.waitFor("the nested turn's result", isOutcome, bound(90_000), before)
    handoverLaw(w, result, NESTED_TURN_ASK, 'agentnested', 1, ['subnested'], before)
    const requests = requestsOf(w.fx.wire)
    const refused = requests.find(wireOf(w, 'subnested', 2))
    check("the sub-agent's Crewmate call came back as an error, not a launch", refused !== undefined && refused.lastToolResult?.isError === true, j(refused?.lastToolResult))
    check('no deeper agent ever queried', requests.every(r => r.arm !== 'deeper') && carrying(requests, DEEPER_DONE).length === 0, j(requests.map(r => r.arm)))
    const carriers = await settled(w, [LINE], bound(10_000), drainedOnce([LINE]))
    lineLaw(w, line, ['subnested', 'deeper'], 'agentnested', 1, carriers)
    await closeWorld(w)
  }

  if (runs('A6')) {
  section('A6 a fork is refused at the Crewmate tool, and the line sent during the sub-agent that follows reaches the session\'s own model once, at the handover boundary')
    const w = await openWorld('fork', 5)
    const before = w.runner.frames.length
    void w.runner.prompt(FORK_TURN_ASK, UT)
    const afterFork = await waitWire(w.fx.wire, "the session's request after the fork call", wireOf(w, 'agentfork', 1), bound(60_000))
    check('the fork call came back as an error, not a launch', afterFork !== null && afterFork.lastToolResult?.isError === true, j(afterFork?.lastToolResult))
    check('the sub-agent that followed opened its own conversation', (await waitWire(w.fx.wire, "the sub-agent's first request", wireOf(w, 'subwork', 0), bound(60_000))) !== null)
    await toolStarted(w, 'toolu_sub_c', before)
    const line = send(w, LINE, 1)
    const result = await w.runner.waitFor("the fork turn's result", isOutcome, bound(90_000), before)
    handoverLaw(w, result, FORK_TURN_ASK, 'agentfork', 2, ['subwork'], before)
    const requests = requestsOf(w.fx.wire)
    check('no fork ever queried', requests.every(r => r.arm !== 'forkwork') && carrying(requests, FORK_DONE).length === 0, j(requests.map(r => r.arm)))
    const carriers = await settled(w, [LINE], bound(10_000), drainedOnce([LINE]))
    lineLaw(w, line, ['subwork', 'forkwork'], 'agentfork', 2, carriers)
    await closeWorld(w)
  }

  if (runs('A7')) {
  section("A7 a line sent while a workflow's agent runs waits for the session's own boundary")
    const w = await openWorld('workflow', 5, 0, {
      argv: ['--allowed-tools', WORKFLOW_ALLOW_RULE],
      seed: cwd => {
        mkdirSync(join(cwd, '.mercury', 'workflows'), { recursive: true })
        writeFileSync(join(cwd, '.mercury', 'workflows', `${WORKFLOW_NAME}.js`), `${WORKFLOW_SCRIPT}\n`)
      },
    })
    const before = w.runner.frames.length
    void w.runner.prompt(WORKFLOW_TURN_ASK, UT)
    const launched = await waitWire(w.fx.wire, "the session's request after the Workflow call", wireOf(w, 'agentworkflow', 1), bound(60_000))
    check('the named workflow launched in the background (the tool answered with a task id)', launched !== null && launched.lastToolResult?.isError === false && /launched in background/i.test(launched.lastToolResult?.text ?? ''), j(launched?.lastToolResult))
    const agent = await waitWire(w.fx.wire, "the workflow agent's first request", wireOf(w, 'wfwork', 0), bound(60_000))
    check("the workflow's agent opened its own conversation", agent !== null)
    await toolStarted(w, 'toolu_wfwait_c', before)
    const line = send(w, LINE, 1)
    const result = await w.runner.waitFor("the workflow turn's result", isOutcome, bound(120_000), before)
    check("the turn ended with the session's own final text", result !== null && String(result.answer ?? '').startsWith(doneText(WORKFLOW_TURN_ASK)), j(result?.answer))
    const requests = requestsOf(w.fx.wire)
    check("the workflow's agent crossed its own boundary while the line was queued", requests.some(wireOf(w, 'wfwork', 1)), j(requests.filter(r => r.arm === 'wfwork').map(r => [r.n, r.step])))
    check('the workflow agent finished on its own', carrying(requests.filter(r => r.arm === 'agentworkflow'), WORKFLOW_AGENT_DONE).length >= 0)
    const carriers = await settled(w, [LINE], bound(10_000), drainedOnce([LINE]))
    lineLaw(w, line, ['wfwork'], 'agentworkflow', 2, carriers)
    await closeWorld(w)
  }

  if (runs('A8')) {
  section("A8 two lines sent after the Crewmate tool's return, while the session's final request is held on the wire, each keep their own row and identity")
    const w = await openWorld('return', 4, 0, { hold: true })
    const before = w.runner.frames.length
    void w.runner.prompt(AGENT_TURN_ASK, UT)
    const mainNext = await waitWire(w.fx.wire, "the session's request after the Crewmate tool", wireOf(w, 'agent', 1), bound(60_000))
    const held = await waitWire(w.fx.wire, 'the fixture holding the final answer', x => x.kind === 'held', bound(10_000))
    check("the Crewmate tool had returned and the session's own final request was on the wire, held by the fixture, before either line was sent", mainNext !== null && held !== null, j(w.fx.wire().map(x => [x.kind, x.arm, x.step])))
    const atReturn = send(w, RETURN_LINE, 1)
    const afterReturn = send(w, AFTER_RETURN_LINE, 2)
    const queued = await queuedBoth(w, [RETURN_LINE, AFTER_RETURN_LINE], bound(20_000))
    check('the runner queued both lines while the final answer was held (two enqueue rows in its journal, nothing released yet)', queued && w.fx.wire().every(x => x.kind !== 'released'), j(queueJournal(projectsOf(w)).slice(-4)))
    writeFileSync(w.holdFile!, '')
    const result = await w.runner.waitFor("the agent turn's result", isOutcome, bound(90_000), before)
    check("the turn ended with the session's own final text", result !== null && String(result.answer ?? '').startsWith(doneText(AGENT_TURN_ASK)), j(result?.answer))
    const batchRequest = await waitWire(w.fx.wire, 'the queued batch reaching the model', x => x.kind === 'request' && x.arm !== 'subwork' && (x.counts?.[RETURN_LINE] ?? 0) > 0 && (x.counts?.[AFTER_RETURN_LINE] ?? 0) > 0, bound(60_000))
    check('the queued batch reached the model before its request body is inspected', batchRequest !== null)
    const both = (cs: WordCarrier[]): boolean => [RETURN_LINE, AFTER_RETURN_LINE].every(word => cs.some(c => c.word === word && inMainFile(c)))
    let carriers = await settled(w, [RETURN_LINE, AFTER_RETURN_LINE], bound(30_000), both)
    let extraTurns = 0
    while (!both(carriers) && extraTurns < 3) {
      const next = await w.runner.waitFor('a following turn', isOutcome, bound(30_000), w.runner.frames.length)
      if (next === null) break
      extraTurns++
      carriers = await settled(w, [RETURN_LINE, AFTER_RETURN_LINE], bound(10_000), both)
    }
    const requests = requestsOf(w.fx.wire)
    for (const sent of [atReturn, afterReturn]) {
      const subCarrying = carrying(requests.filter(r => r.arm === 'subwork'), sent.word)
      const mainCarrying = carrying(requests.filter(r => r.arm !== 'subwork'), sent.word)
      check(`no request of the sub-agent carried "${sent.word}"`, subCarrying.length === 0, j(subCarrying.map(r => [r.n, r.step])))
      check(`the session's own model read "${sent.word}" once, as the next turn after the send`, mainCarrying.length >= 1 && mainCarrying[0]!.counts?.[sent.word] === 1 && mainCarrying[0]!.at >= Date.parse(sent.sentAt) - 1000, describeRequests(requests, [sent.word]))
      const mine = carriers.filter(c => c.word === sent.word)
      const mainRows = mine.filter(inMainFile)
      check(`the session's transcript holds "${sent.word}" once, under the send's identity, and no sub-agent's transcript holds it`, mainRows.length === 1 && mine.length === 1 && (mainRows[0]!.sourceUuid === sent.uuid || mainRows[0]!.recordId === sent.uuid || mainRows[0]!.uuid === sent.uuid) && mainRows[0]!.file.endsWith(`${w.sessionId}.jsonl`), briefly(mine) + ' ' + j(mine.map(c => [c.kind, c.recordId.slice(0, 8), c.uuid.slice(0, 8), c.sourceUuid.slice(0, 8), c.occurredAt, c.sentAt])))
    }
    const returnRow = carriers.find(c => c.word === RETURN_LINE && inMainFile(c))
    const afterRow = carriers.find(c => c.word === AFTER_RETURN_LINE && inMainFile(c))
    check('the two lines are two rows of the transcript, the first before the second, and no row carries both', returnRow !== undefined && afterRow !== undefined && returnRow.recordId !== afterRow.recordId && Number(returnRow.ordinal) < Number(afterRow.ordinal), j([returnRow?.recordId.slice(0, 8), returnRow?.ordinal, afterRow?.recordId.slice(0, 8), afterRow?.ordinal]))
    const carrier = carrying(requests.filter(r => r.arm !== 'subwork'), RETURN_LINE)[0]
    check('the session read both lines in one request, in the order sent', carrier !== undefined && carrier.counts?.[AFTER_RETURN_LINE] === 1 && (carrier.firstAt?.[RETURN_LINE] ?? -1) >= 0 && (carrier.firstAt?.[RETURN_LINE] ?? 0) < (carrier.firstAt?.[AFTER_RETURN_LINE] ?? -1), j(carrier?.firstAt))
    const askItem = ((): Array<{ type?: string; text?: string }> => {
      try {
        const parsed = JSON.parse(carrier?.askItem ?? 'null') as unknown
        return Array.isArray(parsed) ? (parsed as Array<{ type?: string; text?: string }>) : []
      } catch {
        return []
      }
    })()
    check('the request body carries the two lines as ONE text block holding the newline-joined string, as the runner has always sent them, never a block per line', askItem.length === 1 && askItem[0]!.type === 'text' && askItem[0]!.text === `${RETURN_LINE}\n${AFTER_RETURN_LINE}`, j([carrier?.askShape, carrier?.askItem]))
    check(`the request body's user item is byte for byte what the runner sent when it joined the lines itself (sha ${BATCH_ITEM_SHA})`, carrier?.askSha === BATCH_ITEM_SHA, j([carrier?.askSha, carrier?.askItem]))
    const withdrawn = await Promise.all(
      [atReturn, afterReturn].map(async (sent, i) => {
        return w.runner.request('queue/withdraw', { id: sent.uuid }, bound(10_000)).then(
          answer => answer as { withdrawn?: boolean; reason?: string },
          (error: unknown) => {
            console.log(`  [wait] the withdraw answer for "${sent.word}" (${i}): ${error instanceof Error ? error.message : String(error)}`)
            return undefined
          },
        )
      }),
    )
    check('the recall by identity knows each line: the runner answers taken for both uuids, never unknown', withdrawn.every(r => r?.withdrawn === false && r?.reason === 'taken'), j(withdrawn))
    const clockHolds = (row: Carrier | undefined, sent: Sent): boolean =>
      row !== undefined && (row.kind === 'attachment/queued_command' ? row.occurredAt === sent.sentAt && row.sentAt === sent.sentAt : Math.abs(Date.parse(row.occurredAt) - Date.parse(sent.sentAt)) <= CLOCK_TOLERANCE_MS)
    check('each row carries a clock within the tolerance of the clock its line was sent at', clockHolds(returnRow, atReturn) && clockHolds(afterRow, afterReturn), j([returnRow?.kind, returnRow?.occurredAt, atReturn.sentAt, afterRow?.kind, afterRow?.occurredAt, afterReturn.sentAt]))
    await closeWorld(w)
  }

  if (runs('A9')) {
    section('A9 a later between-turns line attaches its mentioned file and passes its own context-adding prompt hook')
    const mention = 'and please read @notes.txt too'
    const body = 'THE-NOTES-BODY'
    const hookContext = 'BATCH-HOOK-CONTEXT'
    const w = await openWorld('batch-mentions', 1, 0, {
      hold: true,
      seed: cwd => {
        writeFileSync(join(cwd, 'notes.txt'), `${body}\n`)
        const hook = join(cwd, 'prompt-hook.cjs')
        writeFileSync(hook, [
          "const fs = require('node:fs')",
          "const input = JSON.parse(fs.readFileSync(0, 'utf8'))",
          `fs.appendFileSync(${JSON.stringify(join(cwd, 'hook-prompts.jsonl'))}, JSON.stringify(input.prompt) + '\\n')`,
          `if (input.prompt === ${JSON.stringify(mention)}) console.log(JSON.stringify({ context: ${JSON.stringify(hookContext)} }))`,
        ].join('\n'))
        writeFileSync(join(cwd, '..', 'settings.json'), JSON.stringify({ events: { hooks: { 'turn.start': [{ name: 'mention context', run: `${JSON.stringify(NODE)} ${JSON.stringify(hook)}` }] } } }))
      },
    })
    try {
      const before = w.runner.frames.length
      void w.runner.prompt(AGENT_TURN_ASK, UT)
      const held = await waitWire(w.fx.wire, 'the final answer held before the batch', x => x.kind === 'held', bound(60_000))
      const first = send(w, RETURN_LINE, 1)
      const second = send(w, mention, 2)
      const queued = await queuedBoth(w, [RETURN_LINE, mention], bound(20_000))
      check('both prompts wait after the last tool boundary, before the answer is released', held !== null && queued && w.fx.wire().every(x => x.kind !== 'released'))
      writeFileSync(w.holdFile!, '')
      const request = await waitWire(w.fx.wire, 'the batch request with the later mention', x => x.kind === 'request' && (x.counts?.[mention] ?? 0) > 0, bound(60_000))
      const result = await w.runner.waitFor('the batch answer', x => isOutcome(x) && String(x.answer ?? '').includes(mention), bound(60_000), before)
      check('the batch settles with one answer', result !== null && result.status === 'completed', j(result))
      check('the session reads both prompts once in one request and in send order', request?.counts?.[RETURN_LINE] === 1 && request?.counts?.[mention] === 1 && (request.firstAt?.[RETURN_LINE] ?? -1) < (request.firstAt?.[mention] ?? -1), j(request?.counts))
      check('the later mention supplies its file body to the real request', request?.counts?.[body] === 1, j(request?.counts))
      check('the later prompt supplies its hook context to the real request', request?.counts?.[hookContext] === 1, j(request?.counts))
      const hookPrompts = readFileSync(join(w.home, 'repo', 'hook-prompts.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as string)
      check('the prompt hook sees each batch line separately, once and in order', j(hookPrompts.filter(line => line.includes(RETURN_LINE) || line.includes(mention))) === j([RETURN_LINE, mention]), j(hookPrompts))
      const carriers = await settled(w, [RETURN_LINE, mention], bound(10_000), cs => [RETURN_LINE, mention].every(word => cs.some(row => row.word === word && inMainFile(row))))
      const firstRows = carriers.filter(row => row.word === RETURN_LINE && inMainFile(row))
      const secondRows = carriers.filter(row => row.word === mention && inMainFile(row))
      check('both prompts keep separate transcript rows, identities and send order', firstRows.length === 1 && secondRows.length === 1 && firstRows[0]?.uuid === first.uuid && secondRows[0]?.uuid === second.uuid && Number(firstRows[0]?.ordinal) < Number(secondRows[0]?.ordinal), briefly(carriers))
      exportWorld('batch-mentions', w.home, { 'hook-prompts.jsonl': hookPrompts.map(line => JSON.stringify(line)).join('\n') + '\n' })
    } finally {
      await closeWorld(w)
    }
  }

  if (runs('A10')) {
    section('A10 fold 46ag: a shrinkable compact at the head of a queued batch keeps its summary before the following prompt')
    const followUp = 'the follow-up after the compact'
    const w = await openWorld('compact-batch', 1, 0, { hold: true })
    try {
      const before = w.runner.frames.length
      void w.runner.prompt(AGENT_TURN_ASK, UT)
      const held = await waitWire(w.fx.wire, 'the final answer held before compact', x => x.kind === 'held', bound(60_000))
      send(w, '/compact', 1)
      const sent = send(w, followUp, 2)
      const queued = await queuedBoth(w, ['/compact', followUp], bound(20_000))
      check('compact and its follow-up are queued together before the held turn ends', held !== null && queued && w.fx.wire().every(x => x.kind !== 'released'))
      writeFileSync(w.holdFile!, '')
      const fold = await waitWire(w.fx.wire, 'the queued compact request', x => x.kind === 'fold', bound(60_000))
      check('the queued compact actually requests a summary', fold !== null)
      const postFold = await waitWire(w.fx.wire, 'the first request after compact', x => x.kind === 'request' && fold !== null && Number(x.n) > Number(fold.n), bound(60_000))
      check('the first request after compact carries the summary and follow-up once each', postFold?.counts?.[FOLD_SUMMARY_MARK] === 1 && postFold?.counts?.[followUp] === 1, describeRequests(requestsOf(w.fx.wire), [FOLD_SUMMARY_MARK, followUp]))
      check('the summary precedes the follow-up on the wire', (postFold?.firstAt?.[FOLD_SUMMARY_MARK] ?? -1) >= 0 && (postFold?.firstAt?.[followUp] ?? -1) > (postFold?.firstAt?.[FOLD_SUMMARY_MARK] ?? -1), j(postFold?.firstAt))
      const result = await w.runner.waitFor('the compact batch answer', x => isOutcome(x) && !String(x.answer ?? '').startsWith(doneText(AGENT_TURN_ASK)), bound(60_000), before)
      check('the compact batch settles without an error', result !== null && result.status === 'completed', j(result))
      const carriers = await settled(w, [FOLD_SUMMARY_MARK, followUp], bound(10_000), cs => [FOLD_SUMMARY_MARK, followUp].every(word => cs.some(row => row.word === word && inMainFile(row))))
      const summary = carriers.find(row => row.word === FOLD_SUMMARY_MARK && inMainFile(row))
      const followUps = carriers.filter(row => row.word === followUp && inMainFile(row))
      check('the saved follow-up keeps its identity after the compact summary', summary !== undefined && followUps.length === 1 && followUps[0]?.uuid === sent.uuid && Number(followUps[0]?.ordinal) > Number(summary.ordinal), briefly(carriers))
    } finally {
      await closeWorld(w)
    }
  }
}

finish()
