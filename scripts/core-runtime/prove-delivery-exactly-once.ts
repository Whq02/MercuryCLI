#!/usr/bin/env bun
// ============================================================================
//  scripts/core-runtime/prove-delivery-exactly-once.ts — THE DELIVERY LAW:
//  a sent message reaches the model exactly once, at the next readable
//  moment (the next legal protocol boundary), whatever happens to the turn.
//
//  The operator ruling behind it: the operator-facing
//  holding pen is removed; delivery is instant and the engine reads at its
//  own boundaries. These pins are the ENGINE half of that law:
//
//    D1  TEARDOWN ATOMICITY — a queued command whose attachment WAS yielded
//        is consumed (removed from the queue, lifecycle-started) even when
//        the turn's generator is torn down at that exact yield. The old
//        shape ran consumeDrainedCommands several lines — and one await —
//        after the yield loop: a teardown in that window left the command
//        IN the queue with its words already persisted as an attachment
//        row, and the next turn re-drained it — the operator's words
//        reached the model twice (the "sent once, delivered twice" class).
//    D2  NORMAL DRAIN — one submit, one queued_command attachment, one
//        consumption, queue empty after the turn (the law's happy path,
//        unchanged from the old world).
//    D3  NEXT-BOUNDARY DELIVERY — words enqueued while a tool round runs
//        are in the VERY NEXT model call's request messages (after the
//        tool round settles, before the next call — the one legal mid-turn
//        boundary; a tool_result round cannot interleave user messages).
//    D4  PARTIAL-YIELD HONESTY — a teardown BEFORE any queued_command
//        attachment yields leaves the command queued (nothing was
//        delivered, so nothing is consumed — it rides to the next
//        boundary instead of vanishing).
//
//  Run: ~/.bun/bin/bun run scripts/core-runtime/prove-delivery-exactly-once.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

// ── hermetic env (BEFORE any src import) ────────────────────────────────────
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'delivery-once-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'delivery-once-daemon-'))
process.env.MERCURY_TEAMS_DIR = mkdtempSync(join(tmpdir(), 'delivery-once-teams-'))
for (const k of [
  'MERCURY_SIMPLE',
  'MERCURY_EFFORT_LEVEL',
  'MERCURY_MAX_OUTPUT_TOKENS',
  'DISABLE_COMPACT',
  'DISABLE_AUTO_COMPACT',
  'NODE_ENV',
]) {
  delete process.env[k]
}

const { query } = await import('../../src/query.ts')
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createAssistantMessage, createUserMessage } = await import(
  '../../src/utils/messages/factories.ts'
)
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const queueStore = await import('../../src/input-core/command-queue.ts')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — delivery-exactly-once prover exceeded 120s')
  process.exit(1)
}, 120_000)
watchdog.unref?.()

// ── rig (the runloop-contract shape, prove-hammer-breaker's sibling) ────────
type AnyMsg = Record<string, unknown> & { type?: string }
const MODEL = 'claude-opus-4-8'

function makeTool(name: string): never {
  return {
    name,
    async description() {
      return 'rig tool'
    },
    async prompt() {
      return 'rig tool'
    },
    inputSchema: z.object({ text: z.string().optional() }),
    userFacingName: () => name,
    isEnabled: () => true,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    isMcp: false,
    needsPermissions: () => false,
    async validateInput() {
      return { result: true }
    },
    async call(input: Record<string, unknown>) {
      return { data: `echo:${String(input?.text ?? '')}` }
    },
    mapToolResultToToolResultBlockParam: (data: unknown, toolUseId: string) => ({
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: String(data),
    }),
  } as never
}

function makeCtx(tools: unknown[]): { ctx: Record<string, unknown>; abortController: AbortController } {
  let appState: Record<string, unknown> = {
    ...(getDefaultAppState() as unknown as Record<string, unknown>),
    effortValue: 'high',
  }
  const abortController = new AbortController()
  const ctx: Record<string, unknown> = {
    abortController,
    options: {
      commands: [],
      tools,
      mainLoopModel: MODEL,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      debug: false,
      verbose: false,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    getAppState: () => appState,
    setAppState: (f: (prev: never) => never): void => {
      appState = f(appState as never) as unknown as Record<string, unknown>
    },
    messages: [],
    readFileState: createFileStateCacheWithSizeLimit(100),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    agentId: undefined,
  }
  return { ctx, abortController }
}

type CallRecord = { messages: unknown[] }

function makeModel(turnFor: (index: number) => unknown[] | undefined): { calls: CallRecord[]; callModel: unknown } {
  const calls: CallRecord[] = []
  async function* callModel(req: { messages: unknown[] }): AsyncGenerator<never, void> {
    const idx = calls.length
    calls.push({ messages: [...req.messages] })
    const turn = turnFor(idx)
    if (!turn) throw new Error(`model script exhausted at call ${idx}`)
    for (const m of turn) yield m as never
  }
  return { calls, callModel }
}

const allowAll = async (_tool: unknown, input: Record<string, unknown>) =>
  ({ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'rig' } }) as never

let idSeq = 0
function toolTurn(name: string, input: Record<string, unknown>): unknown[] {
  const m = createAssistantMessage({
    content: [{ type: 'tool_use', id: `tu_${++idSeq}`, name, input }] as never,
  })
  m.message.stop_reason = 'tool_use'
  return [m]
}
function textTurn(text: string): unknown[] {
  const m = createAssistantMessage({ content: text })
  m.message.stop_reason = 'end_turn'
  return [m]
}

function makeGen(turnFor: (index: number) => unknown[] | undefined): {
  gen: AsyncGenerator<AnyMsg, Record<string, unknown>>
  calls: CallRecord[]
} {
  const rig = makeCtx([makeTool('EchoTool')])
  const { calls, callModel } = makeModel(turnFor)
  const gen = query({
    messages: [createUserMessage({ content: 'please do the thing' })] as never,
    systemPrompt: ['rig system prompt'] as never,
    userContext: {},
    systemContext: {},
    canUseTool: allowAll as never,
    toolUseContext: rig.ctx as never,
    querySource: 'sdk' as never,
    deps: {
      callModel: callModel as never,
      autocompact: (async () => ({ wasCompacted: false })) as never,
      microcompact: (async (messages: unknown[]) => ({ messages })) as never,
      uuid: (() => {
        let n = 0
        return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
      })(),
    },
  }) as AsyncGenerator<AnyMsg, Record<string, unknown>>
  return { gen, calls }
}

const isQueuedCommandAttachment = (m: AnyMsg): boolean =>
  m.type === 'attachment' &&
  ((m as { attachment?: { type?: string } }).attachment?.type === 'queued_command')

const STEER_UUID = '11111111-2222-4333-8444-555555555555'
function enqueueSteer(text: string): void {
  queueStore.enqueue({
    value: text,
    mode: 'prompt',
    uuid: STEER_UUID,
  } as never)
}

// ── D1 — teardown at the attachment yield still consumes ────────────────────
section('D1 — teardown at the queued_command yield: consumed, never re-drained')
{
  queueStore.resetCommandQueue()
  enqueueSteer('steer words D1')
  const { gen } = makeGen(i => (i === 0 ? toolTurn('EchoTool', { text: 'round one' }) : textTurn('done')))
  let sawAttachment = false
  for (;;) {
    const r = await gen.next()
    if (r.done) break
    if (isQueuedCommandAttachment(r.value)) {
      sawAttachment = true
      // The teardown window: the attachment row is out (persisted by any
      // real consumer) — tear the turn down at this exact moment.
      await gen.return({} as never)
      break
    }
  }
  await new Promise(resolve => setTimeout(resolve, 25))
  check('the drain yielded the queued_command attachment', sawAttachment)
  const left = queueStore.getCommandQueue()
  check(
    'the yielded command is CONSUMED despite the teardown (exactly-once — a re-drain would deliver it twice)',
    left.length === 0,
    `queue still holds ${left.length} command(s): ${JSON.stringify(left.map(c => c.value))}`,
  )
}

// ── D2 — the normal drain: once, exactly ────────────────────────────────────
section('D2 — the normal drain consumes once and the words fold in once')
{
  queueStore.resetCommandQueue()
  enqueueSteer('steer words D2')
  const { gen, calls } = makeGen(i => (i === 0 ? toolTurn('EchoTool', { text: 'round one' }) : textTurn('done')))
  const yields: AnyMsg[] = []
  let r = await gen.next()
  while (!r.done) {
    yields.push(r.value)
    r = await gen.next()
  }
  const drained = yields.filter(isQueuedCommandAttachment)
  check('exactly ONE queued_command attachment yielded', drained.length === 1, String(drained.length))
  check('the queue is empty after the turn', queueStore.getCommandQueue().length === 0)
  const secondCall = JSON.stringify(calls[1]?.messages ?? [])
  check('the steered words are in the NEXT model call (the legal boundary)', secondCall.includes('steer words D2'))
  const firstCall = JSON.stringify(calls[0]?.messages ?? [])
  check('…and not in the first (they arrived mid-turn)', !firstCall.includes('steer words D2'))
}

// ── D3 — enqueue DURING the tool round lands at the next boundary ───────────
section('D3 — words sent mid-tool-round reach the very next model call')
{
  queueStore.resetCommandQueue()
  let enqueued = false
  const { gen, calls } = makeGen(i =>
    i === 0 ? toolTurn('EchoTool', { text: 'round one' }) : i === 1 ? toolTurn('EchoTool', { text: 'round two' }) : textTurn('done'),
  )
  const yields: AnyMsg[] = []
  let r = await gen.next()
  while (!r.done) {
    yields.push(r.value)
    // The first settled tool_result of round one: the operator's words land
    // NOW, while the round is still settling — before the next model call.
    if (!enqueued && r.value.type === 'user') {
      enqueued = true
      enqueueSteer('steer words D3')
    }
    r = await gen.next()
  }
  check('the mid-round words were enqueued', enqueued)
  const secondCall = JSON.stringify(calls[1]?.messages ?? [])
  check(
    'the words are in the SECOND call (the next legal boundary — never later)',
    secondCall.includes('steer words D3'),
    'the drain missed the first boundary after the round settled',
  )
  check('the queue is empty after the turn', queueStore.getCommandQueue().length === 0)
}

// ── D4 — teardown BEFORE the drain leaves the words queued ──────────────────
section('D4 — teardown before any drain: the words stay queued (nothing was delivered)')
{
  queueStore.resetCommandQueue()
  enqueueSteer('steer words D4')
  const { gen } = makeGen(i => (i === 0 ? toolTurn('EchoTool', { text: 'round one' }) : textTurn('done')))
  // Tear down at the FIRST yield — long before the tool round settles and
  // the drain runs.
  await gen.next()
  await gen.return({} as never)
  await new Promise(resolve => setTimeout(resolve, 25))
  const left = queueStore.getCommandQueue()
  check(
    'the undelivered command is STILL queued (it rides to the next boundary; consumed-without-delivery would lose it)',
    left.length === 1 && JSON.stringify(left[0]?.value ?? '').includes('steer words D4'),
    `queue holds ${left.length}`,
  )
  queueStore.resetCommandQueue()
}

// ── verdict ─────────────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(76))
if (failures > 0) {
  console.log(`DELIVERY-EXACTLY-ONCE: ${failures} of ${checks} checks FAILED`)
  process.exit(1)
}
console.log(`DELIVERY-EXACTLY-ONCE: all ${checks} checks passed`)
process.exit(0)
