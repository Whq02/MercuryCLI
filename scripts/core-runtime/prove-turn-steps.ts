#!/usr/bin/env bun
import * as t from './turnScenarios.ts'

const { makeRequest, planContext, foldContext, holdBlockingLimit } = await import('../../src/engine/loop/turn/makeRequest.ts')
const { modelReply } = await import('../../src/engine/loop/turn/modelReply.ts')
const { noToolReply } = await import('../../src/engine/loop/turn/noToolReply.ts')
const { runToolCalls } = await import('../../src/engine/loop/turn/runToolCalls.ts')
const { afterTools, MAX_TURNS_CLOSING_TEXT } = await import('../../src/engine/loop/turn/afterTools.ts')
const queue = await import('../../src/daemon/runner/messageQueueManager.ts')

const f = t.fixtures
type Row = Record<string, unknown>
type Events = Array<Row & { kind: string }>

let failures = 0
let checks = 0
let currentSectionTitle = ''
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  const where = ` | change the step this section names, in src/engine/loop/turn (section: ${currentSectionTitle})`
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}${!cond ? where : ''}`)
}
const section = (title: string): void => {
  currentSectionTitle = title
  console.log('\n' + '─'.repeat(76) + '\n' + title)
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the turn steps exceeded 180s; a planted step never decided, last section: ' + currentSectionTitle + ' (steps live in src/engine/loop/turn)')
  process.exit(1)
}, 180_000)
guard.unref?.()

const kinds = (events: Events): string => events.map(event => event.kind).join(',')
const j = (value: unknown): string => JSON.stringify(value)
const said = (decision: unknown): string => t.reasonOf(decision)
const ESTIMATE = { source: 'estimate', family: 'anthropic', shape: 'prompt-too-long', actualTokens: 5_000, limitTokens: 100 }
const BLOCKED = { MERCURY_BLOCKING_LIMIT_OVERRIDE: '100', MERCURY_AUTO_COMPACT: '0' }
const fatHistory = (): unknown[] => [f.ask('an old question'), f.fat('an old fat answer', 5_000), f.ask('hello there rig')]

async function request(plan: Parameters<typeof t.plantRun>[0], state: Row = {}, ordinal = 1) {
  const planted = await t.plantRun(plan)
  Object.assign(planted.state, state)
  const out = await t.drain(makeRequest(planted.run as never, planted.state as never, ordinal))
  return { planted, events: out.events, decision: out.decision as Row & { kind: string; iter?: Row; next?: Row; terminal?: Row } }
}

async function reply(plan: Parameters<typeof t.plantRun>[0], state: Row = {}) {
  const made = await request(plan, state)
  if (made.decision.kind !== 'go_on') throw new Error(`the planted request did not go on: ${said(made.decision)}`)
  const iter = made.decision.iter!
  const out = await t.drain(modelReply(made.planted.run as never, iter as never))
  return { planted: made.planted, iter, events: out.events, decision: out.decision as Row & { kind: string; next?: Row; terminal?: Row } }
}

console.log('============================================================')
console.log(' the steps of a turn, each called with a planted state: what it yields and what it decides')
console.log('============================================================')

section('(1) making the request: src/engine/loop/turn/makeRequest.ts')
{
  const made = await request({ script: [] }, {}, 3)
  const iter = made.decision.iter
  check('a plain turn goes on with the iteration it built, numbered as the loop numbered it', made.decision.kind === 'go_on' && iter?.turnId === 't3' && made.events[0]?.kind === 'turn_started' && made.events[0].turnId === 't3' && made.events[0].n === 3, `${said(made.decision)} · ${kinds(made.events)}`)
  check('…the iteration holds the turn state it was handed, the request rows, and nothing of a reply yet', iter?.state === made.planted.state && (iter?.messagesForRequest as unknown[]).length === 1 && (iter?.assistantMessages as unknown[]).length === 0 && iter?.needsFollowUp === false && iter?.closingTurn === false, j({ rows: (iter?.messagesForRequest as unknown[] | undefined)?.length, closing: iter?.closingTurn }))
  check('…and no model call is made by this step', made.planted.requests.length === 0, String(made.planted.requests.length))
  made.planted.close()

  const closing = await request({ script: [], maxTurns: 1 }, { turnCount: 2 })
  check('a turn past the turn budget is marked as the closing turn', closing.decision.kind === 'go_on' && closing.decision.iter?.closingTurn === true, j(closing.decision.iter?.closingTurn))
  closing.planted.close()

  const failed = await request({ script: [], seed: f.history(), autocompact: [{ wasCompacted: false, refusal: 'the summary call failed' }] }, { pendingOverflow: { signal: f.providerOverflow(), rung: 'fold' }, overflowEpisode: { pruned: false, folded: true } })
  check("a fold forced by the provider's overflow that does not land ends the run prompt_too_long and says why", said(failed.decision) === 'end prompt_too_long' && t.noticesOf(failed.events).some(text => text.includes('the fold failed (the summary call failed)')), `${said(failed.decision)} · ${j(t.noticesOf(failed.events))}`)
  failed.planted.close()

  const estimated = await request({ script: [], seed: f.history(), autocompact: [{ wasCompacted: false }] }, { pendingOverflow: { signal: ESTIMATE, rung: 'fold' }, overflowEpisode: { pruned: false, folded: true } })
  check("a fold forced by Mercury's own estimate that does not land ends the run blocking_limit", said(estimated.decision) === 'end blocking_limit', said(estimated.decision))
  estimated.planted.close()

  const landed = await request({ script: [], seed: f.history(), autocompact: [f.folded()] }, { pendingOverflow: { signal: f.providerOverflow(), rung: 'fold' }, overflowEpisode: { pruned: false, folded: true } })
  const boundary = landed.events.find(event => event.kind === 'compaction_boundary')
  check('a forced fold that lands goes on with the folded rows and a boundary marked overflow', landed.decision.kind === 'go_on' && boundary?.trigger === 'overflow' && (landed.decision.iter?.tracking as Row | undefined)?.compacted === true && (landed.decision.iter?.overflowEpisode as Row | undefined)?.folded === true, `${said(landed.decision)} · ${kinds(landed.events)}`)
  landed.planted.close()

  const pruned = await request({ script: [], seed: f.history(), autocompact: [f.folded()] }, { pendingOverflow: { signal: f.providerOverflow(), rung: 'prune' }, overflowEpisode: { pruned: true, folded: true } })
  check('the prune rung asks for no fold: the summariser is not called and the turn goes on with a line naming the prune', pruned.decision.kind === 'go_on' && pruned.planted.counts.folds === 0 && t.noticesOf(pruned.events).some(text => text.includes('pruned')), `${said(pruned.decision)} · folds ${pruned.planted.counts.folds} · ${j(t.noticesOf(pruned.events))}`)
  pruned.planted.close()

  const armed = await request({ script: [], env: BLOCKED, seed: fatHistory() })
  check('a request over the blocking limit on a turn-owning run hands over to fold first (overflow_recovery, from the estimate)', said(armed.decision) === 'hand_over overflow_recovery' && j((armed.decision.next?.transition as Row)) === j({ reason: 'overflow_recovery', rung: 'fold', source: 'estimate' }) && (armed.decision.next?.pendingOverflow as Row | undefined)?.rung === 'fold', `${said(armed.decision)} · ${j(armed.decision.next?.transition)}`)
  check('…and the hand-over is not announced by the step: the loop yields turn_settled', !armed.events.some(event => event.kind === 'turn_settled'), kinds(armed.events))
  armed.planted.close()

  const unarmed = await request({ script: [], env: BLOCKED, querySource: 'side_question', seed: fatHistory() })
  check('the same request on a run that owns no turn ends blocking_limit with the prompt-too-long words, and no model call', said(unarmed.decision) === 'end blocking_limit' && unarmed.planted.requests.length === 0 && !unarmed.events.some(event => event.kind === 'run_terminal'), `${said(unarmed.decision)} · ${kinds(unarmed.events)}`)
  unarmed.planted.close()
}

section('(1b) the three parts of making the request, each called alone')
{
  const p = await t.plantRun({ script: [], seed: f.history() })
  const context = p.state.toolUseContext as never
  const planned = await t.drain(planContext(p.run as never, p.state as never, context))
  check('the context plan is made of the turn\'s rows, with nothing said when nothing was cut', planned.events.length === 0 && planned.decision.messagesForRequest.length === 3 && planned.decision.prunedTokensFreed === 0 && planned.decision.thinkingRecords.length === 0 && planned.decision.requestPlan.messages === planned.decision.messagesForRequest, `${kinds(planned.events)} · ${planned.decision.messagesForRequest.length} rows`)
  const opened = { tracking: undefined, overflowEpisode: p.state.overflowEpisode as never }
  const folded = await t.drain(foldContext(p.run as never, p.state as never, context, opened, planned.decision))
  const kept = folded.decision as Row & { kind: string }
  check('with no fold due the summariser is asked once and the rows go on as they were', kept.kind === 'go_on' && p.counts.folds === 1 && kept.messagesForRequest === planned.decision.messagesForRequest && kept.foldResult === undefined && folded.events.length === 0, `${said(folded.decision)} · folds ${p.counts.folds}`)
  const fitting = await t.drain(holdBlockingLimit(p.run as never, p.state as never, context, planned.decision, folded.decision as never))
  const fits = fitting.decision as Row & { kind: string; toolUseContext?: Row }
  check('a request under the blocking limit goes on, and the tools are handed the very rows the model will be sent', fits.kind === 'go_on' && fits.toolUseContext?.messages === planned.decision.messagesForRequest && fits.currentModel === t.MODEL && fitting.events.length === 0, `${said(fitting.decision)} · ${kinds(fitting.events)}`)
  p.close()

  const tight = await t.plantRun({ script: [], env: BLOCKED, querySource: 'side_question', seed: fatHistory() })
  const tightContext = tight.state.toolUseContext as never
  const tightPlan = await t.drain(planContext(tight.run as never, tight.state as never, tightContext))
  const tightFold = await t.drain(foldContext(tight.run as never, tight.state as never, tightContext, { tracking: undefined, overflowEpisode: tight.state.overflowEpisode as never }, tightPlan.decision))
  const refused = await t.drain(holdBlockingLimit(tight.run as never, tight.state as never, tightContext, tightPlan.decision, tightFold.decision as never))
  check('a request over the blocking limit is refused by the last part alone: the first two say nothing', said(refused.decision) === 'end blocking_limit' && tightPlan.events.length === 0 && tightFold.events.length === 0 && kinds(refused.events) === 'notice', `${said(refused.decision)} · ${kinds(refused.events)}`)
  tight.close()
}

section("(2) the model's reply: src/engine/loop/turn/modelReply.ts")
{
  const plain = await reply({ script: [f.yields(f.says('done.'))] })
  check('a reply of words goes on: one model call, the reply settled, no tool asked', plain.decision.kind === 'go_on' && plain.planted.requests.length === 1 && kinds(plain.events) === 'model_permit,model_call_started,assistant_settled' && (plain.iter.assistantMessages as unknown[]).length === 1 && plain.iter.needsFollowUp === false, `${said(plain.decision)} · ${kinds(plain.events)}`)
  plain.planted.close()

  const tool = await reply({ script: [f.yields(f.calls('tu_1', 'EchoTool', { text: 'x' }))] })
  check('a reply that calls a tool goes on with the call recorded for the tool step', tool.decision.kind === 'go_on' && tool.iter.needsFollowUp === true && j((tool.iter.toolUseBlocks as Row[]).map(block => block.id)) === j(['tu_1']), j(tool.iter.toolUseBlocks))
  tool.planted.close()

  const thrown = await reply({ script: [[...f.yields(f.calls('tu_err', 'EchoTool', { text: 'x' })), { kind: 'throw', error: new Error('rig boom') }]] })
  const settled = thrown.events.find(event => event.kind === 'tool_settled')
  check('a model call that throws ends the run model_error, with the announced tool call settled as an error first', said(thrown.decision) === 'end model_error' && settled?.synthetic === true && settled.outcome === 'error' && ((thrown.decision.terminal?.error as Error | undefined)?.message ?? '') === 'rig boom', `${said(thrown.decision)} · ${kinds(thrown.events)}`)
  thrown.planted.close()

  const cut = await reply({ tools: [{ name: 'Bash' }], script: [[...f.yields(f.calls('tu_ab', 'Bash', { command: 'sleep 30' })), { kind: 'do', fn: env => env.rig.abortController.abort() }]] })
  const stopped = cut.events.find(event => event.kind === 'interruption')
  check('an abort during the stream ends the run aborted_streaming: the call settled as aborted, then the interruption row', said(cut.decision) === 'end aborted_streaming' && stopped?.phase === 'stream' && stopped.steer === false && stopped.message !== null && cut.events.some(event => event.kind === 'tool_settled' && event.outcome === 'aborted'), `${said(cut.decision)} · ${kinds(cut.events)}`)
  cut.planted.close()

  const steer = await reply({ script: [[...f.yields(f.says('half an answer')), { kind: 'do', fn: env => env.rig.abortController.abort('interrupt') }]] })
  const steered = steer.events.find(event => event.kind === 'interruption')
  check("an abort whose reason is the operator's next line writes no interruption row (a steer)", said(steer.decision) === 'end aborted_streaming' && steered?.steer === true && steered.message === null, j({ steer: steered?.steer }))
  steer.planted.close()

  const cutCall = await reply({ model: 'deepseek-v4-pro', tools: [{ name: 'Bash' }], script: [f.yields(...f.cutCall(4_096))] })
  check('a tool call cut by the output limit hands over to ask again with twice the room, the reply taken back', said(cutCall.decision) === 'hand_over cut_tool_call_recovery' && cutCall.decision.next?.maxOutputTokensOverride === 8_192 && cutCall.decision.next.cutToolCallRecoveryCount === 1 && cutCall.decision.next.messages === cutCall.iter.messagesForRequest && cutCall.events.filter(event => event.kind === 'assistant_retracted').length === 2, `${said(cutCall.decision)} · ${j(cutCall.decision.next?.maxOutputTokensOverride)} · ${kinds(cutCall.events)}`)
  cutCall.planted.close()

  const spent = await reply({ model: 'deepseek-v4-pro', tools: [{ name: 'Bash' }], script: [f.yields(...f.cutCall(4_096))] }, { cutToolCallRecoveryCount: 2 })
  check('after two such re-asks the step goes on and leaves the refused call to the rules', spent.decision.kind === 'go_on' && (spent.iter.refusedToolCalls as unknown[]).length === 1 && (spent.iter.allRefusedToolCalls as unknown[]).length === 1 && !spent.events.some(event => event.kind === 'assistant_retracted'), `${said(spent.decision)} · ${kinds(spent.events)}`)
  spent.planted.close()
}

section('(3) the reply that asks for no tool: src/engine/loop/turn/noToolReply.ts')
{
  const tool = await t.plantReply({ script: [f.yields(f.calls('tu_1', 'EchoTool', { text: 'x' }))] })
  const passed = await t.drain(noToolReply(tool.run as never, tool.iter as never))
  check('a reply that asks for a tool passes through with no event', said(passed.decision) === 'go_on' && passed.events.length === 0, `${said(passed.decision)} · ${kinds(passed.events)}`)
  tool.close()

  const both = f.says(f.chant())
  ;(both as unknown as Row).refusedToolCalls = [f.refusal({ id: 'call_refused_1', name: 'Grpe', argumentsRaw: '{}', code: 'unknown-tool', reason: 'no tool of that name' })]
  const clash = await t.plantReply({ script: [f.yields(both)] })
  const first = await t.drain(noToolReply(clash.run as never, clash.iter as never))
  check('when two rules could decide, the one that stands first does: a chanting reply that carries a refused call is corrected, not cut', said(first.decision) === 'hand_over tool_call_refusal_recovery', said(first.decision))
  clash.close()

  const plain = await t.plantReply({ script: [f.yields(f.says('done.'))] })
  const ended = await t.drain(noToolReply(plain.run as never, plain.iter as never))
  check('when no rule decides, the reply stands and the run ends completed, after the stop gate passed', said(ended.decision) === 'end completed' && kinds(ended.events) === 'hook_gate' && ended.events[0]?.outcome === 'passed', `${said(ended.decision)} · ${kinds(ended.events)}`)
  plain.close()
}

section('(4) running the tools: src/engine/loop/turn/runToolCalls.ts')
{
  const ran = await t.plantReply({ script: [f.yields(f.calls('tu_1', 'EchoTool', { text: 'x' }))] })
  const out = await t.drain(runToolCalls(ran.run as never, ran.iter as never))
  check('a tool call runs and settles: started, settled ok, its result kept for the next request', said(out.decision) === 'go_on' && kinds(out.events) === 'tool_started,tool_settled' && out.events[1]?.outcome === 'ok' && (ran.iter.toolResults as unknown[]).length === 1 && ran.toolLane.length === 1, `${said(out.decision)} · ${kinds(out.events)}`)
  ran.close()

  const capped = await t.plantReply({ maxTurns: 1, script: [f.yields(f.calls('tu_b', 'EchoTool', { text: 'b' }))] }, { state: { turnCount: 2 } })
  const stopped = await t.drain(runToolCalls(capped.run as never, capped.iter as never))
  const cutCall = stopped.events.find(event => event.kind === 'tool_settled')
  check('on the closing turn a tool call never runs: it is settled as cut, the budget row is written and the run ends max_turns', said(stopped.decision) === 'end max_turns' && (stopped.decision as Row & { terminal: Row }).terminal.turnCount === 2 && cutCall?.synthetic === true && cutCall.outcome === 'aborted' && capped.toolLane.length === 0 && stopped.events.some(event => event.kind === 'attachment'), `${said(stopped.decision)} · ${kinds(stopped.events)} · ran ${capped.toolLane.length}`)
  capped.close()

  const mixed = await t.plantReply({ script: [f.yields(f.calls('tu_ok', 'EchoTool', { text: 'x' }), f.refused(f.refusal({ id: 'call_mixed_bad' })))] })
  const corrected = await t.drain(runToolCalls(mixed.run as never, mixed.iter as never))
  const correction = corrected.events.find(event => event.kind === 'hook_message')
  check('a refused call beside a call that ran is answered with one correction row, kept for the next request', said(corrected.decision) === 'go_on' && correction !== undefined && (mixed.iter.toolResults as unknown[]).at(-1) === correction.message && j(correction.message).includes('call_mixed_bad'), `${said(corrected.decision)} · ${kinds(corrected.events)}`)
  mixed.close()

  const hooked = await t.plantReply({ before: f.hooks({ 'tool.before': [{ name: 'rig tool halt', match: 'EchoTool', run: `echo '{"stop": "rig tool halt"}'` }] }), script: [f.yields(f.calls('tu_hs', 'EchoTool', { text: 'x' }))] })
  const halted = await t.drain(runToolCalls(hooked.run as never, hooked.iter as never))
  check('a hook that stops the run is noted on the iteration for the next step; the tool still settles', said(halted.decision) === 'go_on' && hooked.iter.shouldPreventContinuation === true && halted.events.some(event => event.kind === 'tool_settled'), `${said(halted.decision)} · prevent ${String(hooked.iter.shouldPreventContinuation)}`)
  hooked.close()

  const marked = await t.plantReply({ tools: [{ name: 'MarkTool', serial: true, marks: true }], script: [f.yields(f.calls('tu_m1', 'MarkTool', { text: 'one' }))] })
  await t.drain(runToolCalls(marked.run as never, marked.iter as never))
  check('a tool that changes the context hands the changed context to the next step', (marked.iter.updatedToolUseContext as Row).rigMark === 1 && (marked.iter.toolUseContext as Row).rigMark === undefined, j((marked.iter.updatedToolUseContext as Row).rigMark))
  marked.close()
}

section('(5) what follows the tools: src/engine/loop/turn/afterTools.ts')
{
  const round = async (plan: Parameters<typeof t.plantReply>[0], change: Parameters<typeof t.plantReply>[1] = {}) => {
    const planted = await t.plantReply(plan, change)
    const ran = await t.drain(runToolCalls(planted.run as never, planted.iter as never))
    return { planted, ran }
  }
  const call = (): ReturnType<typeof f.yields> => f.yields(f.calls('tu_1', 'EchoTool', { text: 'x' }))

  const plain = await round({ script: [call()] })
  const next = await t.drain(afterTools(plain.planted.run as never, plain.planted.iter as never))
  const handed = (next.decision as Row & { next?: Row }).next
  check('a settled tool round hands over to the next turn: one turn more, the reply and its result added to the rows, every recovery count back at zero', said(next.decision) === 'hand_over next_turn' && handed?.turnCount === 2 && (handed.messages as unknown[]).length === 3 && handed.maxOutputTokensRecoveryCount === 0 && handed.streamFaultRecoveryCount === 0 && handed.toolCallRefusalRecoveryCount === 0 && handed.pendingOverflow === undefined, `${said(next.decision)} · ${j({ turn: handed?.turnCount, rows: (handed?.messages as unknown[] | undefined)?.length })}`)
  check('…and the step does not announce it: the loop yields turn_settled', !next.events.some(event => event.kind === 'turn_settled'), kinds(next.events))
  plain.planted.close()

  const aborted = await round({ tools: [{ name: 'AbortTool', result: 'finished-during-abort', onCall: rig => rig.abortController.abort() }], script: [f.yields(f.calls('tu_mt', 'AbortTool', {}))] })
  const cut = await t.drain(afterTools(aborted.planted.run as never, aborted.planted.iter as never))
  check('an abort during the tools ends the run aborted_tools: the interruption row, then the line naming the tools', said(cut.decision) === 'end aborted_tools' && kinds(cut.events) === 'interruption,notice' && cut.events[0]?.phase === 'tools', `${said(cut.decision)} · ${kinds(cut.events)}`)
  aborted.planted.close()

  const hooked = await round({ script: [call()] })
  hooked.planted.iter.shouldPreventContinuation = true
  const halted = await t.drain(afterTools(hooked.planted.run as never, hooked.planted.iter as never))
  check('a hook stop noted by the tool step ends the run hook_stopped', said(halted.decision) === 'end hook_stopped', said(halted.decision))
  hooked.planted.close()

  const looped = await round({ script: [call()] })
  looped.planted.iter.loopStoppedCycle = ['Bash']
  const stopped = await t.drain(afterTools(looped.planted.run as never, looped.planted.iter as never))
  check('a loop stop noted by the tool step ends the run loop_stopped with its cycle', said(stopped.decision) === 'end loop_stopped' && j((stopped.decision as Row & { terminal: Row }).terminal.cycle) === j(['Bash']), j(stopped.decision))
  looped.planted.close()

  const capped = await round({ maxTurns: 1, script: [call()] })
  const closing = await t.drain(afterTools(capped.planted.run as never, capped.planted.iter as never))
  const last = (((closing.decision as Row & { next?: Row }).next?.messages as Row[] | undefined) ?? []).at(-1)
  check('when the next turn is past the turn budget the model is told so in a last row it alone reads', said(closing.decision) === 'hand_over next_turn' && last?.isMeta === true && j(last.message).includes(MAX_TURNS_CLOSING_TEXT), j(last?.message).slice(0, 160))
  capped.planted.close()

  const drained = await round({
    before: () => {
      queue.enqueue({ value: 'steer note one', mode: 'prompt', uuid: '11111111-1111-4111-8111-111111111111' } as never)
    },
    script: [call()],
  })
  const steered = await t.drain(afterTools(drained.planted.run as never, drained.planted.iter as never))
  check("a line the operator queued while the tools ran rides the next turn: its row, the drained mark, and its id on the caller's list", said(steered.decision) === 'hand_over next_turn' && steered.events.some(event => event.kind === 'attachment') && steered.events.some(event => event.kind === 'followup_drained' && event.uuid === '11111111-1111-4111-8111-111111111111') && j(drained.planted.consumed) === j(['11111111-1111-4111-8111-111111111111']) && ((steered.decision as Row & { next: Row }).next.messages as unknown[]).length === 4, `${kinds(steered.events)} · ${j(drained.planted.consumed)}`)
  drained.planted.close()

  const refreshed = await round({ refreshedTools: [{ name: 'LateTool' }], script: [call()] })
  const wider = await t.drain(afterTools(refreshed.planted.run as never, refreshed.planted.iter as never))
  const tools = ((((wider.decision as Row & { next: Row }).next.toolUseContext as Row).options as Row).tools as Row[]).map(tool => tool.name)
  check('the next turn is handed the tools as they stand now, not as they stood when the turn began', j(tools) === j(['EchoTool', 'LateTool']), j(tools))
  refreshed.planted.close()
}

section('(6) the loop of src/engine/loop/turn-machine.ts applies each decision')
{
  const run = await t.runScripted({ script: [f.yields(f.calls('tu_1', 'EchoTool', { text: 'x' })), f.yields(f.says('after tools.'))] })
  const order = kinds(run.events)
  const settledAt = run.events.findIndex(event => event.kind === 'turn_settled')
  check('a hand-over is announced once, by the loop, and the next turn starts on the state it was handed', run.events.filter(event => event.kind === 'turn_settled').length === 1 && run.events[settledAt + 1]?.kind === 'turn_started' && run.events[settledAt + 1]?.n === 2 && j(run.events[settledAt]?.transition) === j({ reason: 'next_turn' }) && (run.requests[1]?.messages.length ?? 0) === 3, order)
  const last = run.events.at(-1)
  check('the end is announced once, last, and is what the run returns', run.events.filter(event => event.kind === 'run_terminal').length === 1 && last?.kind === 'run_terminal' && j(last.terminal) === j(run.terminal) && run.terminal.reason === 'completed', order)
  check('the events are numbered one by one from the first to the last', run.events.every((event, at) => event.seq === at + 1), j(run.events.map(event => event.seq)))
}

console.log('')
console.log(failures === 0 ? `prove-turn-steps: ALL HOLD — ${checks} checks` : `prove-turn-steps: ${failures} FAILURE(S) of ${checks}`)
process.exit(failures === 0 ? 0 : 1)
