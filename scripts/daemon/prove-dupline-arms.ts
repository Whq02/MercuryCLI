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
import {
  argAfter,
  bootRunner,
  bound,
  briefly,
  carriersOf,
  carrying,
  childEnv,
  CLOCK_TOLERANCE_MS,
  describeRequests,
  DIST,
  exportWorld,
  inMainFile,
  isDrainedMainRow,
  isInit,
  isResult,
  j,
  makeTally,
  queueJournal,
  removeWorld,
  REPO,
  requestsOf,
  SCRATCH_ROOT,
  seedHome,
  settledCarriers,
  sleep,
  startFixture,
  user,
  waitWire,
  type Carrier,
  type Fixture,
  type Runner,
  type Wire,
} from './dupline-world.ts'

const { check, section, finish, failed } = makeTally('prove-dupline-arms')
const src = (rel: string): string => readFileSync(join(REPO, 'src', ...rel.split('/')), 'utf8')
const only = new Set((argAfter('--only') ?? '').split(',').map(a => a.trim()).filter(a => a !== ''))
const runs = (arm: string): boolean => only.size === 0 || only.has(arm)

section('S the doors a sub-agent could nest or fork through are shut at their owners (the source)')
{
  const tools = src('constants/tools.ts')
  const denySet = tools.slice(tools.indexOf('export const ALL_AGENT_DISALLOWED_TOOLS'), tools.indexOf('export const CUSTOM_AGENT_DISALLOWED_TOOLS'))
  check('every sub-agent loses the Agent tool and the Workflow tool (the one deny set)', denySet.includes('AGENT_TOOL_NAME,') && denySet.includes('WORKFLOW_TOOL_NAME,'))
  check('the fork road is shut: the gate answers false', src('tools/AgentTool/forkSubagent.ts').includes('export function isForkSubagentEnabled(): boolean {\n  return false\n}'))
  check('with the gate shut a launch that names no type takes the default type, never the fork', src('utils/swarm/agentLaunchPlan.ts').includes("requestedType ?? (i.forkGateOn ? undefined : i.defaultAgentType)"))
  const hooks = src('tools/WorkflowTool/agentHooks.ts')
  check("a workflow's agent queries under its own source label and its own agent id", hooks.includes('querySource: getQuerySourceForAgent(') && hooks.includes('agentId: args.agentId,'))
}

const U0 = '00000000-0000-4000-8000-000000000000'
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
  runner.send(user('hello there', U0))
  const init = await runner.waitFor('the init frame', isInit, bound(90_000))
  const first = await runner.waitFor('the first turn', isResult, bound(90_000))
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
  w.runner.send(user(word, sent.uuid, sent.sentAt))
  return sent
}
const projectsOf = (w: World): string => join(w.home, 'projects')
const wireOf = (w: World, arm: string, step: number): ((x: Wire) => boolean) => x => x.kind === 'request' && x.arm === arm && x.step === step

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
  section("A1 two lines sent during one sub-agent's run reach the session's own model once each, in order")
    const w = await openWorld('two-lines', 10)
    const before = w.runner.frames.length
    w.runner.send(user(AGENT_TURN_ASK, UT))
    check('the sub-agent opened its own conversation', (await waitWire(w.fx.wire, "the sub-agent's first request", wireOf(w, 'subwork', 0), bound(60_000))) !== null)
    await sleep(1000)
    const first = send(w, FIRST_LINE, 1)
    await sleep(1500)
    const second = send(w, SECOND_LINE, 2)
    const result = await w.runner.waitFor("the agent turn's result", isResult, bound(90_000), before)
    check("the turn ended with the session's own final text", result !== null && String(result.result ?? '').startsWith(doneText(AGENT_TURN_ASK)), j(result?.result))
    const carriers = await settled(w, [FIRST_LINE, SECOND_LINE], bound(10_000), drainedOnce([FIRST_LINE, SECOND_LINE]))
    lineLaw(w, first, ['subwork'], 'agent', 1, carriers)
    lineLaw(w, second, ['subwork'], 'agent', 1, carriers)
    const carrier = carrying(requestsOf(w.fx.wire).filter(r => r.arm === 'agent'), FIRST_LINE)[0]
    check('the two lines arrived in the order sent', carrier !== undefined && (carrier.firstAt?.[FIRST_LINE] ?? -1) >= 0 && (carrier.firstAt?.[FIRST_LINE] ?? 0) < (carrier.firstAt?.[SECOND_LINE] ?? -1), j(carrier?.firstAt))
    const mainRows = carriers.filter(isDrainedMainRow)
    check('the two rows landed in the order sent', mainRows.length === 2 && mainRows[0]!.word === FIRST_LINE && mainRows[1]!.word === SECOND_LINE, briefly(mainRows))
    await closeWorld(w)
  }

  if (runs('A2')) {
  section("A2 a line sent while the sub-agent runs the Sleep tool waits past the sub-agent's Sleep boundary")
    const w = await openWorld('sleep-tool', 10)
    const before = w.runner.frames.length
    w.runner.send(user(SLEEP_TOOL_TURN_ASK, UT))
    const opened = await waitWire(w.fx.wire, "the sub-agent's first request", wireOf(w, 'subsleep', 0), bound(60_000))
    check('the sub-agent opened with the Sleep tool in its pool', opened !== null && opened.hasSleepTool === true, j(opened))
    await sleep(1500)
    const line = send(w, LINE, 1)
    const result = await w.runner.waitFor("the agent turn's result", isResult, bound(90_000), before)
    check("the turn ended with the session's own final text", result !== null && String(result.result ?? '').startsWith(doneText(SLEEP_TOOL_TURN_ASK)), j(result?.result))
    const afterSleep = requestsOf(w.fx.wire).find(wireOf(w, 'subsleep', 1))
    check('the sub-agent crossed its Sleep boundary (the tool ran, no error)', afterSleep !== undefined && afterSleep.lastToolResult?.isError === false, j(afterSleep?.lastToolResult))
    const carriers = await settled(w, [LINE], bound(10_000), drainedOnce([LINE]))
    lineLaw(w, line, ['subsleep'], 'agentsleep', 1, carriers)
    await closeWorld(w)
  }

  if (runs('A3')) {
  section("A3 a crew notice raised while a sub-agent runs reaches the session's own model once, at the Agent tool's return")
    const w = await openWorld('crew-notice', 10)
    const before = w.runner.frames.length
    w.runner.send(user(CREW_TURN_ASK, UT))
    const quick = await waitWire(w.fx.wire, 'the background agent', wireOf(w, 'quick', 0), bound(60_000))
    const fore = await waitWire(w.fx.wire, 'the foreground sub-agent', wireOf(w, 'subwork', 0), bound(60_000))
    check('both agents launched from the one block: the quick one in the background, the sleeping one in front', quick !== null && fore !== null)
    await sleep(2500)
    const line = send(w, LINE, 1)
    const result = await w.runner.waitFor("the crew turn's result", isResult, bound(90_000), before)
    check("the turn ended with the session's own final text", result !== null && String(result.result ?? '').startsWith(doneText(CREW_TURN_ASK)), j(result?.result))
    const carriers = await settled(w, [LINE, CREW_NOTICE], bound(10_000), drainedOnce([LINE, CREW_NOTICE]))
    lineLaw(w, line, ['subwork', 'quick'], 'crew', 1, carriers)
    const requests = requestsOf(w.fx.wire)
    check('no request of either agent carried the notice', carrying(requests.filter(r => r.arm === 'subwork' || r.arm === 'quick'), CREW_NOTICE).length === 0, describeRequests(requests, [CREW_NOTICE]))
    const noticeRequest = carrying(requests.filter(r => r.arm === 'crew'), CREW_NOTICE)[0]
    check("the session's own request after the Agent tool carried the notice, once", noticeRequest !== undefined && noticeRequest.step === 1 && noticeRequest.counts?.[CREW_NOTICE] === 1, describeRequests(requests, [CREW_NOTICE]))
    const noticeRows = carriers.filter(c => c.word === CREW_NOTICE)
    const noticeMain = noticeRows.filter(isDrainedMainRow)
    const lastSub = requests.filter(r => r.arm === 'subwork').map(r => r.at).sort((a, b) => b - a)[0] ?? 0
    check("the session's transcript holds the notice once, delivered between the sub-agent's last request and the session's own next one", noticeMain.length === 1 && noticeRows.filter(inMainFile).length === 1 && noticeRequest !== undefined && Date.parse(noticeMain[0]!.occurredAt) >= lastSub - 2000 && Date.parse(noticeMain[0]!.occurredAt) <= noticeRequest.at + 2000, briefly(noticeRows))
    check("no sub-agent's transcript holds the notice", noticeRows.every(inMainFile), briefly(noticeRows.filter(c => !inMainFile(c))))
    await closeWorld(w)
  }

  if (runs('A4')) {
  section("A4 a line sent during a sub-agent's compaction fold waits past the fold and the sub-agent's next boundary")
    const w = await openWorld('fold', 3, 800)
    const before = w.runner.frames.length
    w.runner.send(user(FOLD_TURN_ASK, UT))
    const fold = await waitWire(w.fx.wire, "the sub-agent's fold request", x => x.kind === 'fold' && x.arm === 'subfold', bound(60_000))
    check('the sub-agent folded its own conversation (the fold request carries its opening)', fold !== null, j(w.fx.wire().map(x => [x.kind, x.arm, x.step])))
    const line = send(w, FOLD_LINE, 1)
    const result = await w.runner.waitFor("the fold turn's result", isResult, bound(120_000), before)
    check("the turn ended with the session's own final text", result !== null && String(result.result ?? '').startsWith(doneText(FOLD_TURN_ASK)), j(result?.result))
    const wire = w.fx.wire()
    const landed = wire.find(x => x.kind === 'fold-landed')
    const postFold = wire.filter(x => x.kind === 'request' && x.arm === 'subfold' && x.folded === true)
    check('the fold landed and the sub-agent went on to another tool round on the folded record', landed !== undefined && postFold.some(x => x.step === 0) && postFold.some(x => x.step === 1), j(postFold.map(x => [x.n, x.step])))
    check('the line was sent while the fold streamed', landed !== undefined && Date.parse(line.sentAt) < landed.at, `sent ${line.sentAt}, landed ${landed === undefined ? '-' : new Date(landed.at).toISOString()}`)
    const carriers = await settled(w, [FOLD_LINE], bound(10_000), drainedOnce([FOLD_LINE]))
    lineLaw(w, line, ['subfold'], 'agentfold', 1, carriers)
    await closeWorld(w)
  }

  if (runs('A5')) {
  section('A5 a sub-agent cannot nest: its Agent call is refused, and the line sent during its run still waits')
    const w = await openWorld('nested', 5)
    const before = w.runner.frames.length
    w.runner.send(user(NESTED_TURN_ASK, UT))
    const opened = await waitWire(w.fx.wire, "the sub-agent's first request", wireOf(w, 'subnested', 0), bound(60_000))
    check("the sub-agent's pool carries neither the Agent tool nor the Workflow tool", opened !== null && opened.hasAgentTool === false && opened.hasWorkflowTool === false, j(opened))
    await sleep(1000)
    const line = send(w, LINE, 1)
    const result = await w.runner.waitFor("the nested turn's result", isResult, bound(90_000), before)
    check("the turn ended with the session's own final text", result !== null && String(result.result ?? '').startsWith(doneText(NESTED_TURN_ASK)), j(result?.result))
    const requests = requestsOf(w.fx.wire)
    const refused = requests.find(wireOf(w, 'subnested', 2))
    check("the sub-agent's Agent call came back as an error, not a launch", refused !== undefined && refused.lastToolResult?.isError === true, j(refused?.lastToolResult))
    check('no deeper agent ever queried', requests.every(r => r.arm !== 'deeper') && carrying(requests, DEEPER_DONE).length === 0, j(requests.map(r => r.arm)))
    const carriers = await settled(w, [LINE], bound(10_000), drainedOnce([LINE]))
    lineLaw(w, line, ['subnested', 'deeper'], 'agentnested', 1, carriers)
    await closeWorld(w)
  }

  if (runs('A6')) {
  section('A6 a fork is refused at the Agent tool, and the line sent during the sub-agent that follows still waits')
    const w = await openWorld('fork', 5)
    const before = w.runner.frames.length
    w.runner.send(user(FORK_TURN_ASK, UT))
    const afterFork = await waitWire(w.fx.wire, "the session's request after the fork call", wireOf(w, 'agentfork', 1), bound(60_000))
    check('the fork call came back as an error, not a launch', afterFork !== null && afterFork.lastToolResult?.isError === true, j(afterFork?.lastToolResult))
    check('the sub-agent that followed opened its own conversation', (await waitWire(w.fx.wire, "the sub-agent's first request", wireOf(w, 'subwork', 0), bound(60_000))) !== null)
    await sleep(1000)
    const line = send(w, LINE, 1)
    const result = await w.runner.waitFor("the fork turn's result", isResult, bound(90_000), before)
    check("the turn ended with the session's own final text", result !== null && String(result.result ?? '').startsWith(doneText(FORK_TURN_ASK)), j(result?.result))
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
    w.runner.send(user(WORKFLOW_TURN_ASK, UT))
    const launched = await waitWire(w.fx.wire, "the session's request after the Workflow call", wireOf(w, 'agentworkflow', 1), bound(60_000))
    check('the named workflow launched in the background (the tool answered with a task id)', launched !== null && launched.lastToolResult?.isError === false && /launched in background/i.test(launched.lastToolResult?.text ?? ''), j(launched?.lastToolResult))
    const agent = await waitWire(w.fx.wire, "the workflow agent's first request", wireOf(w, 'wfwork', 0), bound(60_000))
    check("the workflow's agent opened its own conversation", agent !== null)
    await sleep(500)
    const line = send(w, LINE, 1)
    const result = await w.runner.waitFor("the workflow turn's result", isResult, bound(120_000), before)
    check("the turn ended with the session's own final text", result !== null && String(result.result ?? '').startsWith(doneText(WORKFLOW_TURN_ASK)), j(result?.result))
    const requests = requestsOf(w.fx.wire)
    check("the workflow's agent crossed its own boundary while the line was queued", requests.some(wireOf(w, 'wfwork', 1)), j(requests.filter(r => r.arm === 'wfwork').map(r => [r.n, r.step])))
    check('the workflow agent finished on its own', carrying(requests.filter(r => r.arm === 'agentworkflow'), WORKFLOW_AGENT_DONE).length >= 0)
    const carriers = await settled(w, [LINE], bound(10_000), drainedOnce([LINE]))
    lineLaw(w, line, ['wfwork'], 'agentworkflow', 2, carriers)
    await closeWorld(w)
  }

  if (runs('A8')) {
  section("A8 two lines sent after the Agent tool's return, while the session's final request is held on the wire, each keep their own row and identity")
    const w = await openWorld('return', 4, 0, { hold: true })
    const before = w.runner.frames.length
    w.runner.send(user(AGENT_TURN_ASK, UT))
    const mainNext = await waitWire(w.fx.wire, "the session's request after the Agent tool", wireOf(w, 'agent', 1), bound(60_000))
    const held = await waitWire(w.fx.wire, 'the fixture holding the final answer', x => x.kind === 'held', bound(10_000))
    check("the Agent tool had returned and the session's own final request was on the wire, held by the fixture, before either line was sent", mainNext !== null && held !== null, j(w.fx.wire().map(x => [x.kind, x.arm, x.step])))
    const atReturn = send(w, RETURN_LINE, 1)
    const afterReturn = send(w, AFTER_RETURN_LINE, 2)
    const queued = await queuedBoth(w, [RETURN_LINE, AFTER_RETURN_LINE], bound(20_000))
    check('the runner queued both lines while the final answer was held (two enqueue rows in its journal, nothing released yet)', queued && w.fx.wire().every(x => x.kind !== 'released'), j(queueJournal(projectsOf(w)).slice(-4)))
    writeFileSync(w.holdFile!, '')
    const result = await w.runner.waitFor("the agent turn's result", isResult, bound(90_000), before)
    check("the turn ended with the session's own final text", result !== null && String(result.result ?? '').startsWith(doneText(AGENT_TURN_ASK)), j(result?.result))
    const both = (cs: WordCarrier[]): boolean => [RETURN_LINE, AFTER_RETURN_LINE].every(word => cs.some(c => c.word === word && inMainFile(c)))
    let carriers = await settled(w, [RETURN_LINE, AFTER_RETURN_LINE], bound(30_000), both)
    let extraTurns = 0
    while (!both(carriers) && extraTurns < 3) {
      const next = await w.runner.waitFor('a following turn', isResult, bound(30_000), w.runner.frames.length)
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
    const clockHolds = (row: Carrier | undefined, sent: Sent): boolean =>
      row !== undefined && (row.kind === 'attachment/queued_command' ? row.occurredAt === sent.sentAt && row.sentAt === sent.sentAt : Math.abs(Date.parse(row.occurredAt) - Date.parse(sent.sentAt)) <= CLOCK_TOLERANCE_MS)
    check('each row carries a clock within the tolerance of the clock its line was sent at', clockHolds(returnRow, atReturn) && clockHolds(afterRow, afterReturn), j([returnRow?.kind, returnRow?.occurredAt, atReturn.sentAt, afterRow?.kind, afterRow?.occurredAt, afterReturn.sentAt]))
    await closeWorld(w)
  }
}

finish()
