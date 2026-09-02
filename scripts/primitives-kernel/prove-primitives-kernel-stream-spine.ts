#!/usr/bin/env bun
// ============================================================================
//  scripts/primitives-kernel/prove-primitives-kernel-stream-spine.ts — slice-11 laws, deterministic
//  fixtures only (zero paid calls, zero request-construction changes):
//
//    · a full Anthropic SSE fixture stream (message_start → text/thinking/
//      tool blocks → usage → stop) projects onto the canonical vocabulary
//      in order, with tool ids resolved across block indices;
//    · unknown/raw-only event types project to nothing (forward-compatible;
//      citations/signature deltas stay raw-stream concerns);
//    · error events project response.failed;
//    · model turn = execution: the turn observer's seam registers one
//      record per turn (plane generation = turn sequence), settles by
//      outcome (succeeded / failed / cancelled), and a stale live record
//      from an abnormal exit settles indeterminate — never silently
//      replaced.
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    pass++
    console.log(`  PASS ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const P = await import('../../src/services/primitives/index.ts')

console.log('SSE → canonical projection (fixture stream)')
{
  const state = P.newAnthropicProjectionState()
  const fixture = [
    { type: 'message_start', message: { model: 'claude-fable-5', usage: { input_tokens: 900 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'hello ' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'world' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tu_9', name: 'Edit' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"file' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '_path":"x"}' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 42 } },
    { type: 'message_stop' },
    { type: 'some_future_event_type' },
  ]
  const events = fixture.flatMap(e => P.projectAnthropicStreamEvent(e as never, state))
  const types = events.map(e => e.type)
  check('event order is canonical', JSON.stringify(types) === JSON.stringify([
    'response.started', 'usage.updated',
    'reasoning.delta',
    'text.delta', 'text.delta',
    'tool.started', 'tool.delta', 'tool.delta', 'tool.completed',
    'usage.updated', 'response.completed',
  ]), types.join(','))
  check('model identity carried', events[0]?.type === 'response.started' && events[0].model === 'claude-fable-5')
  const toolEvents = events.filter(e => 'toolUseId' in e)
  check('tool ids resolve across block indices',
    toolEvents.every(e => (e as { toolUseId: string }).toolUseId === 'tu_9'))
  const completed = events.find(e => e.type === 'response.completed')
  check('stop reason carried', completed?.type === 'response.completed' && completed.stopReason === 'tool_use')
  const usage = events.filter(e => e.type === 'usage.updated')
  check('usage accounting projected from both ends',
    usage.length === 2 &&
      (usage[0] as { inputTokens?: number }).inputTokens === 900 &&
      (usage[1] as { outputTokens?: number }).outputTokens === 42)
  check('unknown event types project to nothing (forward-compatible)',
    !types.includes(undefined as never) && events.length === 11)
  check('signature/citations deltas stay raw-stream concerns',
    types.filter(t => t === 'reasoning.delta').length === 1)

  const err = P.projectAnthropicStreamEvent(
    { type: 'error', error: { message: 'overloaded' } } as never,
    state,
  )
  check('error projects response.failed', err[0]?.type === 'response.failed' && err[0].error === 'overloaded')
}

console.log('model turn = execution (the turn-observer seam)')
{
  const owner = P.makeOwnerKey({ workspace: '/axiom-turn', sessionId: 'turn', lane: P.MAIN_LANE })
  P.beginModelTurnExecution(owner, 'first request')
  const rec1 = P.getExecution(owner, 'model-turn')
  check('turn registers a running model-turn execution',
    rec1?.state === 'running' && rec1.spec.kind === 'model-turn' && rec1.generation === 1)

  P.settleModelTurnExecution(owner, { aborted: false, reason: 'completed' })
  check('turn settles succeeded', P.getExecution(owner, 'model-turn')?.state === 'succeeded')

  P.beginModelTurnExecution(owner, 'second request')
  check('plane generation is the turn sequence',
    P.getExecution(owner, 'model-turn')?.generation === 2)
  P.settleModelTurnExecution(owner, { aborted: true, reason: 'user interrupt' })
  check('aborted turn settles cancelled', P.getExecution(owner, 'model-turn')?.state === 'cancelled')

  P.beginModelTurnExecution(owner, 'third request')
  P.settleModelTurnExecution(owner, { aborted: false, reason: 'api error (529)' })
  check('error-shaped reason settles failed', P.getExecution(owner, 'model-turn')?.state === 'failed')

  // Abnormal exit: a live record still present at the next turn start.
  P.beginModelTurnExecution(owner, 'fourth request')
  const events: string[] = []
  const unsub = P.subscribeExecutionEvents(e => {
    if (e.owner === owner && e.event.type === 'transition') events.push(e.event.to)
  })
  P.beginModelTurnExecution(owner, 'fifth request — after abnormal exit')
  unsub()
  check('a stale live turn settles indeterminate, never silently replaced',
    events.includes('indeterminate') && P.getExecution(owner, 'model-turn')?.generation === 5)
}

console.log('capability contract shape')
{
  const caps: P.ModelRuntimeCapabilities = {
    reasoning: true,
    toolUse: true,
    usageAccounting: true,
    extensions: ['anthropic.citations'],
  }
  check('typed capability extensions carry model-family extras',
    caps.extensions.includes('anthropic.citations'))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
