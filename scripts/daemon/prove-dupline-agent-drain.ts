#!/usr/bin/env bun
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { AGENT_TURN_ASK, bootRunner, bound, briefly, carrying, childEnv, describeRequests, DIST, exportWorld, inMainFile, isDrainedMainRow, isSession, isOutcome, j, LINE, makeTally, removeWorld, requestsOf, SCRATCH_ROOT, seedHome, settledCarriers, startFixture, waitWire } from './dupline-world.ts'

const { check, section, finish, failed } = makeTally('prove-dupline-agent-drain')

section('S the drain scope reads the agent id before the query source (the tool boundary, called)')
{
  const t = await import('../core-runtime/turnScenarios.ts')
  const { runToolCalls } = await import('../../src/engine/loop/turn/runToolCalls.ts')
  const { afterTools } = await import('../../src/engine/loop/turn/afterTools.ts')
  const queue = await import('../../src/daemon/runner/messageQueueManager.ts')
  const SENT = '30000000-0000-4000-8000-000000000001'
  const boundary = async (who: { agentId?: string; querySource: string }): Promise<{ drained: unknown[]; consumed: string[]; left: unknown[] }> => {
    const planted = await t.plantReply({
      ...who,
      before: () => {
        queue.enqueue({ value: LINE, mode: 'prompt', uuid: SENT } as never)
      },
      script: [t.fixtures.yields(t.fixtures.calls('tu_1', 'EchoTool', { text: 'x' }))],
    })
    await t.drain(runToolCalls(planted.run as never, planted.iter as never))
    const out = await t.drain(afterTools(planted.run as never, planted.iter as never))
    const left = queue.getCommandQueue().map(command => command.uuid)
    planted.close()
    return { drained: out.events.filter(event => event.kind === 'followup_drained').map(event => event.uuid), consumed: [...planted.consumed], left }
  }
  const agentLabelledSdk = await boundary({ agentId: t.fixtures.agent(), querySource: 'sdk' })
  const agentLabelledMain = await boundary({ agentId: t.fixtures.agent(), querySource: 'main_thread' })
  const mainThread = await boundary({ querySource: 'sdk' })
  const leftAlone = (seen: { drained: unknown[]; consumed: string[]; left: unknown[] }): boolean => seen.drained.length === 0 && seen.consumed.length === 0 && j(seen.left) === j([SENT])
  check(
    "a query that runs under an agent id is never the main thread's drain, whatever its source label",
    leftAlone(agentLabelledSdk) && leftAlone(agentLabelledMain) && j(mainThread.drained) === j([SENT]) && j(mainThread.consumed) === j([SENT]) && mainThread.left.length === 0,
    `the operator's line queued at a tool boundary — under an agent id labelled sdk: ${j(agentLabelledSdk)}; under an agent id labelled main_thread: ${j(agentLabelledMain)}; the main thread itself: ${j(mainThread)} — selectDrainableCommands of src/engine/loop/attachment-drain.ts gives the main thread's queue only to a scope with no agent id, and the drain of src/engine/loop/turn/afterTools.ts hands it the agent id of the run's context`,
  )
}

if (!existsSync(DIST)) {
  console.log(`\nFAIL ${DIST} missing — run \`bun run build.ts\` first (the drive boots the BUILT product)`)
  check('the built bundle is present', false, DIST)
} else {
  section("R the built runner, headless: the line sent while the model's sub-agent runs reaches the session's own model, once")
  const RUN_HOME = join(SCRATCH_ROOT, `mercury-dupline-runner-${process.pid}`)
  const CWD = join(RUN_HOME, 'repo')
  seedHome(RUN_HOME, CWD)
  const fx = await startFixture(join(RUN_HOME, 'wire.jsonl'), 10)
  const runner = bootRunner({ cwd: CWD, env: childEnv(RUN_HOME, fx.port) })
  const U0 = '00000000-0000-4000-8000-000000000000'
  const UT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const U1 = '11111111-1111-4111-8111-111111111111'

  void runner.prompt('hello there', U0)
  const init = await runner.waitFor('the session row', isSession, bound(40_000))
  const first = await runner.waitFor('the first turn', isOutcome, bound(40_000))
  check('the runner is up and the first turn answered', init !== null && first !== null, runner.stderr().split('\n').slice(-5).join(' | '))
  const sessionId = String(init?.session_id ?? '')
  const beforeAgent = runner.frames.length
  void runner.prompt(AGENT_TURN_ASK, UT)
  const mainOpen = await waitWire(fx.wire, "the main thread's opening request", w => w.kind === 'request' && w.arm === 'agent' && w.step === 0, bound(30_000))
  check("the session's model was asked and answered with the Crewmate tool", mainOpen !== null)
  const subOpen = await waitWire(fx.wire, "the sub-agent's first request", w => w.kind === 'request' && w.arm === 'subwork' && w.step === 0, bound(40_000))
  check('the sub-agent opened its own conversation (its tool runs for ten seconds)', subOpen !== null)
  const T1 = new Date().toISOString()
  void runner.prompt(LINE, U1, T1)
  const agentResult = await runner.waitFor("the agent turn's result", isOutcome, bound(90_000), beforeAgent)
  const requests = requestsOf(fx.wire)
  {
    const boundary = requests.find(w => w.arm === 'agent' && w.step === 1)
    const subLast = requests.filter(w => w.arm === 'subwork').map(w => w.at).sort((a, b) => b - a)[0] ?? 0
    const notices = requests.filter(w => w.arm === 'plain' && String(w.ask ?? '').startsWith('<task-notification>'))
    const frames = runner.frames.slice(beforeAgent)
    const spoken = frames.filter(f => f.type === 'text' && f.turn !== undefined && String(f.text ?? '').startsWith(`done: ${AGENT_TURN_ASK}`))
    const parked = frames.findIndex(f => f.type === 'turn' && f.state === 'waiting' && Number(f.agents) >= 1)
    const ended = frames.reduce((last, f, i) => (f.type === 'task' && f.state === 'ended' ? i : last), -1)
    const outcomes = frames.filter(isOutcome)
    check("the line handed the sub-agent to the background: the Crewmate tool returned with the handover receipt and the session's model answered with its own text at that boundary, once", boundary !== undefined && boundary.lastToolResult?.isError === false && /launched in the background/i.test(boundary.lastToolResult?.text ?? '') && spoken.length === 1, j([boundary?.n, boundary?.lastToolResult, spoken.map(f => f.text)]))
    check("the turn then parked on the handed-over sub-agent, which ran on to its own end; its completion notice reached the session's own model once and the cycle settled with one outcome after it", boundary !== undefined && subLast > boundary.at && notices.length === 1 && parked >= 0 && ended > parked && outcomes.length === 1 && frames.indexOf(outcomes[0]!) > ended && agentResult !== null && agentResult.status === 'completed', j({ boundaryAt: boundary?.at, subLast, notices: notices.map(w => w.n), parked, ended, outcomes: outcomes.map(f => [frames.indexOf(f), f.status, f.answer]) }))
  }
  const subCarrying = carrying(requests.filter(w => w.arm === 'subwork'), LINE)
  const mainCarrying = carrying(requests.filter(w => w.arm === 'agent'), LINE)
  check("no request of the sub-agent's conversation carried the line", subCarrying.length === 0, j(subCarrying.map(w => [w.n, w.step])))
  check("the session's own next request after the Crewmate tool carried the line, once", mainCarrying.length >= 1 && mainCarrying[0]!.step === 1 && mainCarrying[0]!.counts?.[LINE] === 1, describeRequests(requests, [LINE]))
  const carriers = await settledCarriers(join(RUN_HOME, 'projects'), LINE, bound(10_000))
  const mainRows = carriers.filter(isDrainedMainRow)
  const agentRows = carriers.filter(c => !inMainFile(c))
  check("the session's transcript holds the line once, as the drained row under the send's identity and clock", mainRows.length === 1 && mainRows[0]!.sourceUuid === U1 && mainRows[0]!.occurredAt === T1 && mainRows[0]!.file.endsWith(`${sessionId}.jsonl`), briefly(carriers))
  check("no sub-agent's transcript holds the line", agentRows.length === 0, briefly(agentRows))
  await runner.stop(bound(8_000))
  fx.kill()
  exportWorld('runner', RUN_HOME, { 'frames.jsonl': runner.frames.map(l => JSON.stringify(l)).join('\n') + '\n', 'stderr.txt': runner.stderr() })
  if (failed() === 0) await removeWorld(RUN_HOME)
  else console.log(`  [forensics] runner world kept: ${RUN_HOME}\n${runner.stderr().split('\n').slice(-12).join('\n')}`)
}

finish()
