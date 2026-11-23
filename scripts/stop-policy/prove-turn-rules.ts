#!/usr/bin/env bun
import * as t from '../core-runtime/turnScenarios.ts'

const { NO_TOOL_RULES, readReply, replyStands } = await import('../../src/engine/loop/turn/noToolReply.ts')
const { createAssistantAPIErrorMessage } = await import('../../src/engine/messages/messages.ts')

const f = t.fixtures
type Row = Record<string, unknown>
type Events = Array<Row & { kind: string }>
type Plan = Parameters<typeof t.plantReply>[0]
type Change = Parameters<typeof t.plantReply>[1]

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  const turnRuleHint = 'the rule this section names is its entry in NO_TOOL_RULES in src/engine/loop/turn/noToolReply.ts: change the decide of that rule there, or the planted reply in this section if the new behaviour is meant'
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${detail ? `${detail} · ` : ''}${turnRuleHint}` : ''}`)
}
const section = (title: string): void => console.log('\n' + '─'.repeat(76) + '\n' + title)
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the turn rules exceeded 180s; a rule in NO_TOOL_RULES (src/engine/loop/turn/noToolReply.ts) or the test rig in scripts/core-runtime/turnScenarios.ts is waiting on a planted reply that never completes')
  process.exit(1)
}, 180_000)
guard.unref?.()

const kinds = (events: Events): string => events.map(event => event.kind).join(',')
const j = (value: unknown): string => JSON.stringify(value)
const said = (decision: unknown): string => t.reasonOf(decision)

async function decide(name: string, plan: Plan, change: Change = {}) {
  const entry = NO_TOOL_RULES.find(rule => rule.name === name)
  if (entry === undefined) throw new Error(`no rule named ${name} in NO_TOOL_RULES`)
  const planted = await t.plantReply(plan, change)
  const out = await t.drain(entry.decide(planted.run as never, planted.iter as never, readReply(planted.iter as never)))
  planted.close()
  const decision = out.decision as (Row & { kind: string; next?: Row; terminal?: Row }) | undefined
  return { events: out.events, decision, next: decision?.next, terminal: decision?.terminal, planted, notices: t.noticesOf(out.events) }
}
const quiet = (out: { events: Events; decision: unknown }): boolean => out.decision === undefined && out.events.length === 0
const plain = (): Plan => ({ script: [f.yields(f.says('done.'))] })

console.log('============================================================')
console.log(' the rules of the reply that asks for no tool, each called alone with a planted reply')
console.log('============================================================')

section('overflow_recovery')
{
  const folds = await decide('overflow_recovery', { seed: f.history(), script: [f.yields(f.overflowed(f.providerOverflow()))] })
  check('a reply stamped as an overflow, with history to fold, hands over to fold and says so', said(folds.decision) === 'hand_over overflow_recovery' && j(folds.next?.transition) === j({ reason: 'overflow_recovery', rung: 'fold', source: 'provider' }) && (folds.next?.pendingOverflow as Row | undefined)?.rung === 'fold' && (folds.next?.overflowEpisode as Row | undefined)?.folded === true && folds.notices.some(text => text.includes('folding the conversation')), `${said(folds.decision)} · ${j(folds.notices)}`)
  const refused = await decide('overflow_recovery', { script: [f.yields(f.overflowed(f.providerOverflow()))] })
  check('the same reply with nothing to fold ends the run prompt_too_long with the refusal as an error row', said(refused.decision) === 'end prompt_too_long' && kinds(refused.events) === 'notice', `${said(refused.decision)} · ${kinds(refused.events)}`)
  const unarmed = await decide('overflow_recovery', { querySource: 'side_question', script: [f.yields(f.overflowed(f.providerOverflow()))] })
  check('on a run that owns no turn the rule stays out', quiet(unarmed), `${said(unarmed.decision)} · ${kinds(unarmed.events)}`)
  check('a reply with no overflow stamp is not this rule\'s', quiet(await decide('overflow_recovery', plain())))
}

section('pause_turn_continuation')
{
  const goes = await decide('pause_turn_continuation', { tools: [], script: [f.yields(f.pauses('Searching…'))] })
  check('a paused reply is sent back as it stands: one turn more, one continuation counted, no row added after the reply', said(goes.decision) === 'hand_over pause_turn_continuation' && goes.next?.turnCount === 2 && goes.next.pauseTurnContinuations === 1 && (goes.next.messages as Row[]).length === 2 && (goes.next.messages as Row[]).at(-1)?.type === 'assistant', `${said(goes.decision)} · ${j({ turn: goes.next?.turnCount, rows: (goes.next?.messages as unknown[] | undefined)?.length })}`)
  const ninth = await decide('pause_turn_continuation', { tools: [], script: [f.yields(f.pauses('Searching…'))] }, { state: { pauseTurnContinuations: 8 } })
  check('after eight continuations the rule says the reply stands and decides nothing', ninth.decision === undefined && ninth.notices.length === 1 && ninth.notices[0]!.includes('8 times in a row'), `${said(ninth.decision)} · ${j(ninth.notices)}`)
  const capped = await decide('pause_turn_continuation', { tools: [], maxTurns: 1, script: [f.yields(f.pauses('Searching…'))] })
  check('a continuation counts as a turn: past the turn budget the run ends max_turns', said(capped.decision) === 'end max_turns' && capped.terminal?.turnCount === 2, j(capped.decision))
  check('a reply that was not paused is not this rule\'s', quiet(await decide('pause_turn_continuation', plain())))
}

section('reasoning_only_recovery')
{
  const nudged = await decide('reasoning_only_recovery', { script: [f.yields(f.thinks('end_turn'))] })
  const rows = (nudged.next?.messages as Row[] | undefined) ?? []
  check('a reply of thinking only is asked once for its words: the thinking kept above a nudge the model alone reads', said(nudged.decision) === 'hand_over reasoning_only_recovery' && nudged.next?.reasoningOnlyRecoveryCount === 1 && rows.at(-1)?.isMeta === true && rows.at(-2)?.type === 'assistant' && nudged.notices.length === 1, `${said(nudged.decision)} · ${j(nudged.notices)}`)
  const again = await decide('reasoning_only_recovery', { script: [f.yields(f.thinks('end_turn'))] }, { state: { reasoningOnlyRecoveryCount: 1 } })
  check('a second such reply is let stand with one line and no decision', again.decision === undefined && again.notices.length === 1 && again.notices[0]!.includes('the turn ends here'), `${said(again.decision)} · ${j(again.notices)}`)
  const cut = await decide('reasoning_only_recovery', { script: [f.yields(f.thinks('max_tokens'), f.outputCut())] }, { state: { reasoningOnlyRecoveryCount: 2 } })
  check('thinking cut by the output limit a third time surfaces the held-back limit row', cut.decision === undefined && kinds(cut.events) === 'notice,withheld_surfaced', `${said(cut.decision)} · ${kinds(cut.events)}`)
  check('a reply with words is not this rule\'s', quiet(await decide('reasoning_only_recovery', plain())))
}

section('max_output_tokens_recovery')
{
  const WORDS = 'part one of the long reply with its own words. '
  const goes = await decide('max_output_tokens_recovery', { script: [f.yields(f.says(WORDS, 'max_tokens'), f.outputCut())] })
  check('a reply cut at the output ceiling that added words is asked to carry on, and what it said is remembered', said(goes.decision) === 'hand_over max_output_tokens_recovery' && goes.next?.maxOutputTokensRecoveryCount === 1 && goes.next.lastOutputLimitReply === WORDS && goes.events.length === 0, `${said(goes.decision)} · ${kinds(goes.events)}`)
  const repeat = await decide('max_output_tokens_recovery', { script: [f.yields(f.says(WORDS, 'max_tokens'), f.outputCut())] }, { state: { lastOutputLimitReply: WORDS } })
  check('a continuation that repeats what stood is not asked again: one line, the held-back row surfaced, no decision', repeat.decision === undefined && kinds(repeat.events) === 'notice,withheld_surfaced' && repeat.notices[0]!.includes('repeated what already stood'), `${said(repeat.decision)} · ${j(repeat.notices)}`)
  const spent = await decide('max_output_tokens_recovery', {
    before: rig => {
      ;(rig.ctx.options as Row).maxBudgetUsd = 0
    },
    script: [f.yields(f.says(WORDS, 'max_tokens'), f.outputCut())],
  })
  check("with the run's budget spent the rule stops at the cut and names the budget", spent.decision === undefined && spent.notices.some(text => text.includes("the run's budget is spent")), `${said(spent.decision)} · ${j(spent.notices)}`)
  check('a reply that was not cut is not this rule\'s', quiet(await decide('max_output_tokens_recovery', plain())))
}

section('stream_fault_recovery')
{
  const goes = await decide('stream_fault_recovery', { script: [f.yields(f.says('the first half of the answer', 'stop_sequence'), f.faulted())] })
  check('a stream that broke after part of a reply is continued once, with a row that counts it', said(goes.decision) === 'hand_over stream_fault_recovery' && goes.next?.streamFaultRecoveryCount === 1 && kinds(goes.events) === 'notice' && j(goes.next.transition) === j({ reason: 'stream_fault_recovery', attempt: 1 }), `${said(goes.decision)} · ${kinds(goes.events)}`)
  const again = await decide('stream_fault_recovery', { script: [f.yields(f.says('more of it', 'stop_sequence'), f.faulted())] }, { state: { streamFaultRecoveryCount: 1 } })
  check('a second break is not continued: one line says the reply so far stands', again.decision === undefined && again.notices.length === 1 && again.notices[0]!.includes('stopped after 1 continuation'), `${said(again.decision)} · ${j(again.notices)}`)
  check('a reply whose stream held is not this rule\'s', quiet(await decide('stream_fault_recovery', plain())))
}

section('empty_reply_retry')
{
  const goes = await decide('empty_reply_retry', { script: [f.yields(f.empty('empty'))] })
  check('an empty reply is asked once for its answer: the nudge is the last row and the empty note is left out', said(goes.decision) === 'hand_over empty_reply_retry' && goes.next?.emptyReplyRecoveryCount === 1 && (goes.next.messages as Row[]).length === 2 && (goes.next.messages as Row[]).at(-1)?.isMeta === true, `${said(goes.decision)} · ${j((goes.next?.messages as unknown[] | undefined)?.length)}`)
  const again = await decide('empty_reply_retry', { script: [f.yields(f.empty('empty'))] }, { state: { emptyReplyRecoveryCount: 1 } })
  check('a second empty reply is not asked again: one line, no decision', again.decision === undefined && again.notices.length === 1, `${said(again.decision)} · ${j(again.notices)}`)
  const screen = await decide('empty_reply_retry', { sessionKind: 'oculus', script: [f.yields(f.empty('silence'))] })
  check('a reply that ended in silence where someone is at the screen stands, with one quiet line', screen.decision === undefined && screen.notices.length === 1 && (screen.events[0]?.message as Row | undefined)?.level === 'info', `${said(screen.decision)} · ${j(screen.events[0]?.message)}`.slice(0, 300))
  const alone = await decide('empty_reply_retry', { script: [f.yields(f.says(''))] })
  check('a wordless reply on a run nobody watches is asked for its answer', said(alone.decision) === 'hand_over empty_reply_retry', said(alone.decision))
  check('a reply that hit the output cap with nothing said is left to the cap\'s own road', quiet(await decide('empty_reply_retry', { script: [f.yields(f.empty('cap'))] })))
}

section('tool_call_refusal_recovery')
{
  const goes = await decide('tool_call_refusal_recovery', { tools: [{ name: 'Bash' }], script: [f.yields(f.refused(f.refusal()))] })
  check('a tool call refused before it ran is sent back with a correction, counted', said(goes.decision) === 'hand_over tool_call_refusal_recovery' && goes.next?.toolCallRefusalRecoveryCount === 1 && (goes.next.messages as Row[]).at(-1)?.isMeta === true && goes.notices[0]!.includes('(1/3)'), `${said(goes.decision)} · ${j(goes.notices)}`)
  const spent = await decide('tool_call_refusal_recovery', { tools: [{ name: 'Bash' }], script: [f.yields(f.refused(f.refusal()))] }, { state: { toolCallRefusalRecoveryCount: 3 } })
  check('after three corrections the run ends tool_calls_refused, naming the tool and the corrections spent', said(spent.decision) === 'end tool_calls_refused' && j(spent.terminal?.tools) === j(['Bash']) && spent.terminal?.corrections === 3, j(spent.decision))
  const lost = await decide('tool_call_refusal_recovery', { script: [f.yields(f.refused(f.refusal({ id: 'r1', name: 'Retain', argumentsRaw: '{"fact":' })))] }, { state: { toolCallRefusalRecoveryCount: 3 } })
  check('a refused memory write that was never made is said as lost before that end', said(lost.decision) === 'end tool_calls_refused' && lost.events.filter(event => event.kind === 'notice').length === 2 && (lost.events[1]?.message as Row | undefined)?.level === 'error', `${kinds(lost.events)} · ${j(lost.notices)}`.slice(0, 400))
  check('a reply with no refused call is not this rule\'s', quiet(await decide('tool_call_refusal_recovery', plain())))
}

section('chant_recovery')
{
  const once = await decide('chant_recovery', { script: [f.yields(f.says(f.chant()))] })
  check('a reply that repeats itself is cut to its first stretch and continued once', said(once.decision) === 'hand_over chant_recovery' && once.next?.chantRecoveryCount === 1 && kinds(once.events) === 'assistant_retracted,assistant_settled,notice', `${said(once.decision)} · ${kinds(once.events)}`)
  const alone = await decide('chant_recovery', { script: [f.yields(f.says(f.chant()))] }, { state: { chantRecoveryCount: 1 } })
  check('a second chant on a run nobody watches ends the run loop_stopped for the reply', said(alone.decision) === 'end loop_stopped' && j(alone.terminal?.cycle) === j(['reply']) && alone.notices.some(text => text.includes('nobody is at this run')), `${said(alone.decision)} · ${j(alone.notices)}`.slice(0, 400))
  const screen = await decide('chant_recovery', { sessionKind: 'oculus', script: [f.yields(f.says(f.chant()))] }, { state: { chantRecoveryCount: 1 } })
  check('with someone at the screen and the key off the second chant stands, with a line that claims no end', screen.decision === undefined && screen.notices.some(text => text.includes('the reply stands')), `${said(screen.decision)} · ${j(screen.notices)}`.slice(0, 400))
  const keyed = await decide('chant_recovery', { sessionKind: 'oculus', loopGuard: true, script: [f.yields(f.says(f.chant()))] }, { state: { chantRecoveryCount: 1 } })
  check('with the key on the second chant ends the run there too', said(keyed.decision) === 'end loop_stopped' && keyed.notices.some(text => text.includes('turns.loopGuard')), `${said(keyed.decision)} · ${j(keyed.notices)}`.slice(0, 400))
  check('a reply that does not repeat itself is not this rule\'s', quiet(await decide('chant_recovery', plain())))
}

section('max_turns')
{
  const closing = await decide('max_turns', { maxTurns: 1, script: [f.yields(f.says('closing words'))] }, { state: { turnCount: 2 } })
  check('the closing turn\'s reply ends the run max_turns with the budget row', said(closing.decision) === 'end max_turns' && closing.terminal?.turnCount === 2 && kinds(closing.events) === 'attachment', `${said(closing.decision)} · ${kinds(closing.events)}`)
  check('a reply within the turn budget is not this rule\'s', quiet(await decide('max_turns', { maxTurns: 2, script: [f.yields(f.says('done.'))] })))
}

section('api_error')
{
  const failed = await decide('api_error', { script: [f.yields(createAssistantAPIErrorMessage({ content: 'API Error: 500 upstream' }))] })
  check('a reply that is an API error ends the run completed without asking the stop gate', said(failed.decision) === 'end completed' && failed.events.length === 0, `${said(failed.decision)} · ${kinds(failed.events)}`)
  check('a reply of words is not this rule\'s', quiet(await decide('api_error', plain())))
}

section('announced_step_nudge')
{
  const announce = (): Plan => ({ script: [f.yields(f.says("I'll start by reading the config:"))] })
  const nudged = await decide('announced_step_nudge', announce())
  check('a reply that announces a step and stops, on a run nobody watches, is asked once to take the step', said(nudged.decision) === 'hand_over announced_step_nudge' && j(nudged.next?.transition) === j({ reason: 'announced_step_nudge', attempt: 1 }) && nudged.planted.run.announcedStepNudges === 1 && nudged.notices.length === 1, `${said(nudged.decision)} · ${j(nudged.notices)}`)
  const again = await decide('announced_step_nudge', announce(), { run: { announcedStepNudges: 1 } })
  check('a second announcement in the same run is not asked again: one line, no decision', again.decision === undefined && again.notices.length === 1 && again.notices[0]!.includes('again'), `${said(again.decision)} · ${j(again.notices)}`)
  check('where someone is at the screen the rule stays out', quiet(await decide('announced_step_nudge', { ...announce(), sessionKind: 'oculus' })))
  check('a reply that announces nothing is not this rule\'s', quiet(await decide('announced_step_nudge', plain())))
}

section('stop_hooks')
{
  const held = await decide('stop_hooks', { ...plain(), before: f.stopGuard('rig-stop-rule', async () => ({ hold: true, words: 'RIG-KEEP-WORKING: not done yet' })) })
  check('a guard that holds the turn hands over with its words as the next row, the stop gate marked active', said(held.decision) === 'hand_over stop_hook_blocking' && held.next?.stopHookActive === true && j((held.next.messages as unknown[]).at(-1)).includes('RIG-KEEP-WORKING') && held.events.some(event => event.kind === 'hook_gate' && event.outcome === 'blocking'), `${said(held.decision)} · ${kinds(held.events)}`)
  const stopped = await decide('stop_hooks', { ...plain(), before: f.hooks({ 'turn.answer': [{ name: 'rig halt', run: `echo '{"stop": "rig halt"}'` }] }) })
  check('a hook that says stop ends the run stop_hook_prevented', said(stopped.decision) === 'end stop_hook_prevented' && stopped.events.some(event => event.kind === 'hook_gate' && event.outcome === 'prevented'), `${said(stopped.decision)} · ${kinds(stopped.events)}`)
  const passed = await decide('stop_hooks', plain())
  check('with nothing to say the gate passes and the rule decides nothing', passed.decision === undefined && kinds(passed.events) === 'hook_gate' && passed.events[0]?.outcome === 'passed', `${said(passed.decision)} · ${kinds(passed.events)}`)
}

section('checkpoint_settle_guard')
{
  const open = (): Plan => ({ tools: [{ name: 'Checkpoint' }], seed: f.liveCheckpoint(), script: [f.yields(f.says('the store lives in sessionStorage.'))] })
  const warned = await decide('checkpoint_settle_guard', open())
  check('a reply that would end the turn with a checkpoint still open is warned once and sent back', said(warned.decision) === 'hand_over checkpoint_settle_guard' && warned.planted.run.checkpointSettleWarned === true && kinds(warned.events) === 'attachment' && (warned.next?.messages as unknown[]).at(-1) === warned.events[0]?.message, `${said(warned.decision)} · ${kinds(warned.events)}`)
  check('once warned in a run the rule stays out', quiet(await decide('checkpoint_settle_guard', open(), { run: { checkpointSettleWarned: true } })))
  check('with no checkpoint open the rule stays out', quiet(await decide('checkpoint_settle_guard', plain())))
}

section('queued_message')
{
  const crew = (pending: string[]): Plan => ({ agentId: f.agent(), querySource: 'agent:custom', appState: f.crewTask(pending), script: [f.yields(f.says('the note is written.'))] })
  const queued = await decide('queued_message', crew(['read the contract', 'and conform to it']))
  check("a crewmate's queue is read at the natural end of its turn: every waiting message rides one new turn", said(queued.decision) === 'hand_over queued_message' && j(queued.next?.transition) === j({ reason: 'queued_message', count: 2 }) && queued.next?.turnCount === 2 && queued.events.filter(event => event.kind === 'attachment').length === 2, `${said(queued.decision)} · ${kinds(queued.events)}`)
  check('a crewmate with nothing queued ends its turn', quiet(await decide('queued_message', crew([]))))
  check("the main run never drains a crewmate's queue", quiet(await decide('queued_message', { appState: f.crewTask(['for the crewmate']), script: [f.yields(f.says('done.'))] })))
}

section('the reply stands (what the arm does when no rule decides)')
{
  const planted = await t.plantReply(plain())
  const ended = await t.drain(replyStands(planted.run as never, planted.iter as never))
  check('the run ends completed', said(ended.decision) === 'end completed' && ended.events.length === 0, `${said(ended.decision)} · ${kinds(ended.events)}`)
  planted.close()
  const holding = await t.plantReply(plain())
  ;(holding.run.pendingMemoryWrites as unknown[]).push(f.refusal({ id: 'r1', name: 'Retain', argumentsRaw: '{"fact":' }))
  const lost = await t.drain(replyStands(holding.run as never, holding.iter as never))
  check('a refused memory write still unmade at the end is said as lost, once', said(lost.decision) === 'end completed' && kinds(lost.events) === 'notice' && (holding.run.pendingMemoryWrites as unknown[]).length === 0, `${kinds(lost.events)} · ${j(t.noticesOf(lost.events))}`.slice(0, 300))
  holding.close()
}

section('every rule of the list is called here')
{
  const called = ['overflow_recovery', 'pause_turn_continuation', 'reasoning_only_recovery', 'max_output_tokens_recovery', 'stream_fault_recovery', 'empty_reply_retry', 'tool_call_refusal_recovery', 'chant_recovery', 'max_turns', 'api_error', 'announced_step_nudge', 'stop_hooks', 'checkpoint_settle_guard', 'queued_message']
  const uncalled = NO_TOOL_RULES.map(rule => rule.name).filter(name => !called.includes(name))
  check(`the ${NO_TOOL_RULES.length} rules of NO_TOOL_RULES each have a section above`, uncalled.length === 0, `${uncalled.join(', ')}: add a section to scripts/stop-policy/prove-turn-rules.ts that plants a reply the rule decides on and one it leaves alone`)
}

console.log('')
console.log(failures === 0 ? `prove-turn-rules: ALL HOLD — ${checks} checks` : `prove-turn-rules: ${failures} FAILURE(S) of ${checks}`)
process.exit(failures === 0 ? 0 : 1)
