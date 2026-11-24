#!/usr/bin/env bun
import * as t from './turnScenarios.ts'

const queue = await import('../../src/daemon/runner/messageQueueManager.ts')

const f = t.fixtures
type Row = Record<string, unknown>
type Plan = Parameters<typeof t.runScripted>[0]

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  const hint = 'change the hand-over the label names in src/engine/loop/turn/ (noToolReply.ts for the recoveries and nudges, afterTools.ts for next_turn, makeRequest.ts for overflow_recovery); the transition names are listed in src/engine/turn-entry/transitions.ts'
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${detail ? `${detail}; ` : ''}${hint}` : ''}`)
}
const section = (title: string): void => console.log('\n' + '─'.repeat(76) + '\n' + title)
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the turn hand-overs exceeded 180s; a scripted run never reached its terminal, so look for the hand-over that loops or waits in src/engine/loop/turn/ and the last check printed above')
  process.exit(1)
}, 180_000)
guard.unref?.()

const j = (value: unknown): string => JSON.stringify(value)
const rowsOf = (request: { messages: unknown[] } | undefined): Row[] => (request?.messages ?? []) as Row[]
const shape = (rows: Row[]): string => rows.map(row => (row.type === 'user' && row.isMeta === true ? 'meta' : String(row.type))).join(',')
const textOf = (row: Row | undefined): string => j((row?.message as Row | undefined)?.content ?? row?.attachment ?? '')
const added = (run: Awaited<ReturnType<typeof t.runScripted>>): Row[] => rowsOf(run.requests[1]).slice(rowsOf(run.requests[0]).length)

async function handed(reason: string, plan: Plan) {
  const run = await t.runScripted(plan)
  return { run, reached: run.transitions[0] === reason && run.requests.length >= 2, rows: added(run), said: `${j(run.transitions)} · ${run.requests.length} model calls · added ${shape(added(run))}` }
}

console.log('============================================================')
console.log(' what one iteration of a turn hands to the next: the rows of the next request, and what is counted across')
console.log('============================================================')

section('(1) the rows the next request carries, hand-over by hand-over')
{
  const next = await handed('next_turn', { script: [f.yields(f.calls('tu_1', 'EchoTool', { text: 'x' })), f.yields(f.says('after tools.'))] })
  check('next_turn: the reply that called the tool, then its result', next.reached && shape(next.rows) === 'assistant,user' && textOf(next.rows[1]).includes('tu_1'), next.said)

  const refused = await handed('tool_call_refusal_recovery', { tools: [{ name: 'Bash' }], script: [f.yields(f.refused(f.refusal())), f.yields(f.says('fixed.'))] })
  check('tool_call_refusal_recovery: the refused reply, then the correction as a row the model alone reads', refused.reached && shape(refused.rows) === 'assistant,meta' && textOf(refused.rows[1]).includes('call_bad'), refused.said)

  const paused = await handed('pause_turn_continuation', { tools: [], script: [f.yields(f.pauses('Searching…')), f.yields(f.says('The figure is 42.'))] })
  check('pause_turn_continuation: the paused reply as it stands and no row after it', paused.reached && shape(paused.rows) === 'assistant' && textOf(paused.rows[0]).includes('server_tool_use'), paused.said)

  const thought = await handed('reasoning_only_recovery', { script: [f.yields(f.thinks('end_turn')), f.yields(f.says('the reply, said.'))] })
  check('reasoning_only_recovery: the thinking-only reply, then the nudge', thought.reached && shape(thought.rows) === 'assistant,meta' && textOf(thought.rows[0]).includes('thinking'), thought.said)

  const cut = await handed('max_output_tokens_recovery', { script: [f.yields(f.says('part one of the long reply with its own words. ', 'max_tokens'), f.outputCut()), f.yields(f.says('the end.'))] })
  check('max_output_tokens_recovery: the cut reply, then the word to carry on from where it stopped', cut.reached && shape(cut.rows.filter(row => row.isApiErrorMessage !== true)) === 'assistant,meta' && textOf(cut.rows.at(-1)).includes('Carry on from exactly where it stopped'), cut.said)

  const faulted = await handed('stream_fault_recovery', { script: [f.yields(f.says('the first half of the answer', 'stop_sequence'), f.faulted()), f.yields(f.says('and the second half.'))] })
  check('stream_fault_recovery: the part that arrived, then the nudge; the fault row itself is not sent back', faulted.reached && shape(faulted.rows) === 'assistant,meta' && !faulted.rows.some(row => row.isApiErrorMessage === true), faulted.said)

  const empty = await handed('empty_reply_retry', { script: [f.yields(f.empty('empty')), f.yields(f.says('the answer.'))] })
  check('empty_reply_retry: the nudge alone; the empty note is not sent back', empty.reached && shape(empty.rows) === 'meta', empty.said)

  const chant = await handed('chant_recovery', { script: [f.yields(f.says(f.chant())), f.yields(f.says('an honest reply.'))] })
  check('chant_recovery: the reply cut to its first stretch, then the loop notice', chant.reached && shape(chant.rows) === 'assistant,meta' && textOf(chant.rows[0]).length < f.chant().length / 2, `${chant.said} · ${textOf(chant.rows[0]).length} characters of ${f.chant().length}`)

  const announced = await handed('announced_step_nudge', { script: [f.yields(f.says("I'll start by reading the config:")), f.yields(f.says('The config holds two keys.'))] })
  check('announced_step_nudge: the reply, then the ask to take the step or give the final answer', announced.reached && shape(announced.rows) === 'assistant,meta' && textOf(announced.rows[1]).includes('announcing a next step'), announced.said)

  let judged = 0
  const held = await handed('stop_hook_blocking', {
    before: f.stopGuard('rig-handover-block', async () => (judged++ === 0 ? { hold: true, words: 'RIG-KEEP-WORKING: not done yet' } : { hold: false })),
    script: [f.yields(f.says('first answer')), f.yields(f.says('second answer'))],
  })
  check("stop_hook_blocking: the reply, then the guard's words", held.reached && held.rows[0]?.type === 'assistant' && textOf(held.rows.at(-1)).includes('RIG-KEEP-WORKING'), held.said)

  const guarded = await handed('checkpoint_settle_guard', { tools: [{ name: 'Checkpoint' }], seed: f.liveCheckpoint(), script: [f.yields(f.says('the store lives in sessionStorage.')), f.yields(f.says('settled.'))] })
  check('checkpoint_settle_guard: the reply, then the warning that a checkpoint is still open', guarded.reached && guarded.rows[0]?.type === 'assistant' && textOf(guarded.rows.at(-1)).includes('checkpoint is still active'), guarded.said)

  const queued = await handed('queued_message', { agentId: f.agent(), querySource: 'agent:custom', appState: f.crewTask(['read the contract and conform to it']), script: [f.yields(f.says('the note is written.')), f.yields(f.says('it conforms now.'))] })
  check('queued_message: the reply, then the message that waited in the queue', queued.reached && queued.rows[0]?.type === 'assistant' && j(queued.rows.slice(1)).includes('read the contract and conform to it'), queued.said)

  const again = await handed('cut_tool_call_recovery', { model: 'deepseek-v4-pro', tools: [{ name: 'Bash' }], script: [f.yields(...f.cutCall(4_096)), f.yields(f.says('done.'))] })
  check('cut_tool_call_recovery: the same rows again, nothing of the cut reply, and room for twice the output', again.reached && again.rows.length === 0 && again.run.requests[0]?.options.maxOutputTokensOverride === undefined && again.run.requests[1]?.options.maxOutputTokensOverride === 8_192, `${again.said} · room ${j(again.run.requests[1]?.options.maxOutputTokensOverride)}`)

  const folded = await t.runScripted({ seed: f.history(), autocompact: [{ wasFolded: false }, f.folded()], script: [f.yields(f.overflowed(f.providerOverflow())), f.yields(f.says('after the fold'))] })
  const afterFold = rowsOf(folded.requests[1])
  check('overflow_recovery: the next request is the folded conversation with the operator\'s last line carried behind it', folded.transitions[0] === 'overflow_recovery' && afterFold.length === 3 && afterFold[0]?.type === 'system' && afterFold[0]?.subtype === 'compact_boundary' && textOf(afterFold[1]).includes('RIG SUMMARY') && textOf(afterFold[2]).includes('hello there rig'), `${j(folded.transitions)} · ${afterFold.map(textOf).join(' | ').slice(0, 200)}`)
}

section('(2) what is counted across a hand-over, and what starts again')
{
  const corrected = await t.runScripted({ maxTurns: 1, tools: [{ name: 'Bash' }], script: [f.yields(f.refused(f.refusal())), f.yields(f.says('fixed.'))] })
  check('a recovery spends no turn: with a budget of one turn a corrected reply still ends completed', j(corrected.transitions) === j(['tool_call_refusal_recovery']) && corrected.terminal.reason === 'completed', `${j(corrected.transitions)} · ${j(corrected.terminal)}`)

  const refusals = (ids: string[]) => ids.map(id => f.yields(f.refused(f.refusal({ id }))))
  const reset = await t.runScripted({ tools: [{ name: 'Bash' }, { name: 'EchoTool' }], script: [...refusals(['a1', 'a2', 'a3']), f.yields(f.calls('tu_ok', 'EchoTool', { text: 'x' })), ...refusals(['b1', 'b2', 'b3']), f.yields(f.says('done.'))] })
  check('a tool round starts the correction count again: three corrections, a tool round, three more, and the run still completes', j(reset.transitions) === j([...Array(3).fill('tool_call_refusal_recovery'), 'next_turn', ...Array(3).fill('tool_call_refusal_recovery')]) && reset.terminal.reason === 'completed', `${j(reset.transitions)} · ${j(reset.terminal)}`)

  const spent = await t.runScripted({ tools: [{ name: 'Bash' }], script: [...refusals(['c1', 'c2', 'c3', 'c4']), f.yields(f.says('never asked'))] })
  check('within one turn the count is kept: the fourth refusal in a row ends the run', j(spent.transitions) === j(Array(3).fill('tool_call_refusal_recovery')) && spent.terminal.reason === 'tool_calls_refused' && spent.requests.length === 4, `${j(spent.transitions)} · ${j(spent.terminal)}`)

  const twice = await t.runScripted({ script: [f.yields(f.says("I'll start by reading the config:")), f.yields(f.calls('tu_1', 'EchoTool', { text: 'x' })), f.yields(f.says('Next, I will add the subtract function.')), f.yields(f.says('never asked'))] })
  check('the ask after an announced step is counted for the whole run, not for a turn: after a tool round a second announcement is not asked again', j(twice.transitions) === j(['announced_step_nudge', 'next_turn']) && twice.terminal.reason === 'completed' && t.noticesOf(twice.events).some(text => text.includes('announced a next step again')), `${j(twice.transitions)} · ${j(t.noticesOf(twice.events))}`.slice(0, 400))

  const lost = await t.runScripted({ script: [f.yields(f.refused(f.refusal({ id: 'call_retain', name: 'Retain', argumentsRaw: '{"fact":' }))), f.yields(f.says('carrying on without it.'))] })
  const last = lost.events.filter(event => event.kind === 'notice').at(-1)
  check('a refused memory write is held across the hand-over and said as lost when the run ends without it', lost.terminal.reason === 'completed' && (last?.message as Row | undefined)?.level === 'error' && lost.events.at(-2) === last, j(t.noticesOf(lost.events)).slice(0, 300))

  const drained = await t.runScripted({
    before: () => {
      queue.enqueue({ value: 'steer note one', mode: 'prompt', uuid: '11111111-1111-4111-8111-111111111111' } as never)
    },
    script: [f.yields(f.calls('tu_dr', 'EchoTool', { text: 'x' })), f.yields(f.says('after drain'))],
  })
  const answer = drained.events.filter(event => event.kind === 'assistant_settled').at(-1)?.message as Row | undefined
  check('a line drained after the tools is answered by the next reply: the reply of the next iteration carries its mark', Array.isArray(answer?.inReplyTo) && (answer.inReplyTo as unknown[]).length === 1 && j(drained.consumed) === j(['11111111-1111-4111-8111-111111111111']), j(answer?.inReplyTo))

  const numbered = await t.runScripted({ script: [f.yields(f.calls('tu_1', 'EchoTool', { text: 'x' })), f.yields(f.says('after tools.'))] })
  const starts = numbered.events.filter(event => event.kind === 'turn_started')
  check('events are numbered across hand-overs without a gap, and each iteration is numbered in turn', numbered.events.every((event, at) => event.seq === at + 1) && j(starts.map(event => event.turnId)) === j(['t1', 't2']), j(numbered.events.map(event => event.seq)))
}

console.log('')
console.log(failures === 0 ? `prove-turn-handover: ALL HOLD — ${checks} checks` : `prove-turn-handover: ${failures} FAILURE(S) of ${checks}`)
process.exit(failures === 0 ? 0 : 1)
