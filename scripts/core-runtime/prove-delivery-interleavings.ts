#!/usr/bin/env bun
// ============================================================================
//  scripts/core-runtime/prove-delivery-interleavings.ts — ADVERSARIAL
//  interleavings of the delivery law (delivery-verifier lane).
//
//  prove-delivery-exactly-once pins the single-command shapes (D1 teardown
//  consume, D2 normal, D3 mid-round, D4 pre-drain teardown). These legs
//  attack the interleavings between those pins:
//
//    A1  PARTIAL-SUBSET TEARDOWN — TWO commands queued; the turn tears down
//        after the FIRST attachment yield. The yielded command is consumed,
//        the un-yielded one stays queued, and the NEXT turn delivers it
//        exactly once — neither loss nor double across the pair.
//    A2  RAPID DOUBLE-SUBMIT — two commands with IDENTICAL text and
//        distinct uuids both fold into the next boundary, one attachment
//        each, both consumed — identical words never dedup-swallow a
//        genuine second send.
//    A3  THE BREAKER-STOP RACE — words enqueued during the repetition
//        breaker's refused round: the stop terminal fires BEFORE the drain
//        point, so the words survive QUEUED (never lost into the stopped
//        turn, never consumed undelivered) and the next turn delivers them
//        exactly once.
//    A4  THE INTERRUPT RACE — words enqueued at a tool settle, then the
//        turn aborts: the aborted_tools terminal precedes the drain, the
//        words stay queued, the next turn delivers exactly once.
//    A5  MULTI-BOUNDARY CENSUS — one command over THREE tool rounds:
//        exactly ONE queued_command attachment ever yields, and each later
//        model call carries the words exactly once (history, never a
//        re-attachment).
//    A6  THROWN TEARDOWN — gen.throw() at the attachment yield consumes
//        like D1's .return() (the finally covers both teardown shapes).
//    A7  THE NOTICE-LEVEL CENSUS — every system notice the turn machine
//        emits carries 'warning' or 'error': an info-level stop notice
//        would silently stay un-recorded (QueryEngine records only
//        warning/error — the stop-notice law's level gate).
//
//  Run: ~/.bun/bin/bun run scripts/core-runtime/prove-delivery-interleavings.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

// ── hermetic env (BEFORE any src import) ────────────────────────────────────
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'delivery-adv-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'delivery-adv-daemon-'))
process.env.MERCURY_TEAMS_DIR = mkdtempSync(join(tmpdir(), 'delivery-adv-teams-'))
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
const guard = await import('../../src/services/tools/identicalFailureGuard.ts')

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
  console.log('\nTIMEOUT — delivery-interleavings prover exceeded 120s')
  process.exit(1)
}, 120_000)
watchdog.unref?.()

// ── rig (the runloop-contract shape, prove-delivery-exactly-once's sibling) ─
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
      const text = String(input?.text ?? '')
      if (text.startsWith('fail:')) throw new Error(`rig failure: ${text}`)
      return { data: `echo:${text}` }
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
  abortController: AbortController
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
  return { gen, calls, abortController: rig.abortController }
}

const isQueuedCommandAttachment = (m: AnyMsg): boolean =>
  m.type === 'attachment' &&
  ((m as { attachment?: { type?: string } }).attachment?.type === 'queued_command')

function enqueueSteer(text: string, uuid: string): void {
  queueStore.enqueue({ value: text, mode: 'prompt', uuid } as never)
}
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 25))

async function runWhole(gen: AsyncGenerator<AnyMsg, Record<string, unknown>>, onYield?: (m: AnyMsg, yields: AnyMsg[]) => void | Promise<void>): Promise<AnyMsg[]> {
  const yields: AnyMsg[] = []
  let r = await gen.next()
  while (!r.done) {
    yields.push(r.value)
    await onYield?.(r.value, yields)
    r = await gen.next()
  }
  return yields
}

const countIn = (haystack: string, needle: string): number => haystack.split(needle).length - 1

// ── A1 — partial-subset teardown: yielded consumed, un-yielded rides ────────
section('A1 — two commands, teardown after the FIRST attachment yield')
{
  queueStore.resetCommandQueue()
  const U1 = '11111111-aaaa-4aaa-8aaa-000000000001'
  const U2 = '11111111-aaaa-4aaa-8aaa-000000000002'
  enqueueSteer('subset words ONE', U1)
  enqueueSteer('subset words TWO', U2)
  const { gen } = makeGen(i => (i === 0 ? toolTurn('EchoTool', { text: 'round one' }) : textTurn('done')))
  let torn = false
  for (;;) {
    const r = await gen.next()
    if (r.done) break
    if (isQueuedCommandAttachment(r.value)) {
      torn = true
      await gen.return({} as never)
      break
    }
  }
  await settle()
  check('the teardown landed at the first attachment yield', torn)
  const left = queueStore.getCommandQueue()
  check('the YIELDED command is consumed', !left.some(c => c.uuid === U1), JSON.stringify(left.map(c => c.value)))
  check(
    'the UN-YIELDED command stays queued (it rides — a subset teardown must not sweep it)',
    left.length === 1 && left[0]?.uuid === U2,
    `queue holds ${left.length}: ${JSON.stringify(left.map(c => c.value))}`,
  )
  // The next turn delivers the survivor exactly once.
  const second = makeGen(i => (i === 0 ? toolTurn('EchoTool', { text: 'round one' }) : textTurn('done')))
  const yields = await runWhole(second.gen)
  const drained = yields.filter(isQueuedCommandAttachment)
  check('the next turn delivers the survivor exactly once', drained.length === 1, String(drained.length))
  const body = JSON.stringify(second.calls[1]?.messages ?? [])
  check('…and its words reach the next model call', body.includes('subset words TWO'))
  check('…while the consumed first never re-delivers', !body.includes('subset words ONE'))
  check('the queue is empty after the second turn', queueStore.getCommandQueue().length === 0)
}

// ── A2 — rapid double-submit with identical words ───────────────────────────
section('A2 — two identical-text sends are two deliveries, never deduped')
{
  queueStore.resetCommandQueue()
  const U1 = '22222222-bbbb-4bbb-8bbb-000000000001'
  const U2 = '22222222-bbbb-4bbb-8bbb-000000000002'
  enqueueSteer('the same words twice', U1)
  enqueueSteer('the same words twice', U2)
  const { gen, calls } = makeGen(i => (i === 0 ? toolTurn('EchoTool', { text: 'round one' }) : textTurn('done')))
  const yields = await runWhole(gen)
  const drained = yields.filter(isQueuedCommandAttachment)
  check('BOTH sends yield attachments (identical text never swallows the second)', drained.length === 2, String(drained.length))
  const uuids = drained.map(a => (a as { attachment?: { source_uuid?: string } }).attachment?.source_uuid)
  check('each attachment carries its own identity', uuids.includes(U1) && uuids.includes(U2), JSON.stringify(uuids))
  const body = JSON.stringify(calls[1]?.messages ?? [])
  check('the next call carries the words TWICE (two rows — one per send)', countIn(body, 'the same words twice') === 2, String(countIn(body, 'the same words twice')))
  check('the queue is empty after the turn', queueStore.getCommandQueue().length === 0)
}

// ── A3 — the breaker-stop race ──────────────────────────────────────────────
section("A3 — words enqueued during the breaker's refused round ride to the next turn")
{
  queueStore.resetCommandQueue()
  const U = '33333333-cccc-4ccc-8ccc-000000000001'
  const stopAt = guard.IDENTICAL_FAILURES_TO_STOP + 1
  const rig = makeGen(() => toolTurn('EchoTool', { text: 'fail:always the same' }))
  let enqueued = false
  const yields: AnyMsg[] = []
  let terminal: Record<string, unknown> | undefined
  for (;;) {
    const r = await rig.gen.next()
    if (r.done) {
      terminal = r.value
      break
    }
    yields.push(r.value)
    if (!enqueued && rig.calls.length === stopAt) {
      // The refused round's call went out — this iteration ends at the
      // breaker terminal, BEFORE the drain point.
      enqueued = true
      enqueueSteer('words racing the breaker stop', U)
    }
  }
  await settle()
  check('the stop fired (terminal repetition_breaker)', (terminal as { reason?: string } | undefined)?.reason === 'repetition_breaker', JSON.stringify(terminal))
  check('the racing words were enqueued during the refused round', enqueued)
  const drained = yields.filter(isQueuedCommandAttachment)
  check('the stopped turn yielded NO queued_command attachment (the stop precedes the drain)', drained.length === 0, String(drained.length))
  const left = queueStore.getCommandQueue()
  check('the words SURVIVE queued — never lost into the stopped turn', left.length === 1 && left[0]?.uuid === U, JSON.stringify(left.map(c => c.value)))
  // The next turn delivers them exactly once.
  const second = makeGen(i => (i === 0 ? toolTurn('EchoTool', { text: 'round one' }) : textTurn('done')))
  const yields2 = await runWhole(second.gen)
  const drained2 = yields2.filter(isQueuedCommandAttachment)
  check('the next turn delivers exactly once', drained2.length === 1, String(drained2.length))
  check('…into its next model call', JSON.stringify(second.calls[1]?.messages ?? []).includes('words racing the breaker stop'))
  check('the queue is empty after', queueStore.getCommandQueue().length === 0)
}

// ── A4 — the interrupt race ─────────────────────────────────────────────────
section('A4 — words enqueued at a tool settle, then the turn aborts')
{
  queueStore.resetCommandQueue()
  const U = '44444444-dddd-4ddd-8ddd-000000000001'
  const rig = makeGen(i => (i === 0 ? toolTurn('EchoTool', { text: 'round one' }) : textTurn('done')))
  let acted = false
  const yields = await runWhole(rig.gen, async m => {
    if (!acted && m.type === 'user') {
      acted = true
      enqueueSteer('words racing the interrupt', U)
      rig.abortController.abort()
    }
  })
  await settle()
  check('the abort landed after the enqueue', acted)
  const drained = yields.filter(isQueuedCommandAttachment)
  check('the aborted turn yielded NO queued_command attachment', drained.length === 0, String(drained.length))
  const left = queueStore.getCommandQueue()
  check('the words survive queued across the abort', left.length === 1 && left[0]?.uuid === U, JSON.stringify(left.map(c => c.value)))
  const second = makeGen(i => (i === 0 ? toolTurn('EchoTool', { text: 'round one' }) : textTurn('done')))
  const yields2 = await runWhole(second.gen)
  check('the next turn delivers exactly once', yields2.filter(isQueuedCommandAttachment).length === 1)
  check('…into its next model call', JSON.stringify(second.calls[1]?.messages ?? []).includes('words racing the interrupt'))
  check('the queue is empty after', queueStore.getCommandQueue().length === 0)
}

// ── A5 — multi-boundary census ──────────────────────────────────────────────
section('A5 — one command over three boundaries: one attachment, once per call body')
{
  queueStore.resetCommandQueue()
  const U = '55555555-eeee-4eee-8eee-000000000001'
  enqueueSteer('census words ride once', U)
  const { gen, calls } = makeGen(i =>
    i === 0
      ? toolTurn('EchoTool', { text: 'round one' })
      : i === 1
        ? toolTurn('EchoTool', { text: 'round two' })
        : i === 2
          ? toolTurn('EchoTool', { text: 'round three' })
          : textTurn('done'),
  )
  const yields = await runWhole(gen)
  const drained = yields.filter(isQueuedCommandAttachment)
  check('exactly ONE queued_command attachment across the whole turn', drained.length === 1, String(drained.length))
  check('four model calls ran', calls.length === 4, String(calls.length))
  for (let i = 1; i < calls.length; i++) {
    const body = JSON.stringify(calls[i]?.messages ?? [])
    check(`call ${i + 1} carries the words exactly once (history, never re-attached)`, countIn(body, 'census words ride once') === 1, String(countIn(body, 'census words ride once')))
  }
  check('the queue is empty after the turn', queueStore.getCommandQueue().length === 0)
}

// ── A6 — thrown teardown consumes like .return() ────────────────────────────
section('A6 — gen.throw() at the attachment yield still consumes the yielded command')
{
  queueStore.resetCommandQueue()
  const U = '66666666-ffff-4fff-8fff-000000000001'
  enqueueSteer('thrown teardown words', U)
  const { gen } = makeGen(i => (i === 0 ? toolTurn('EchoTool', { text: 'round one' }) : textTurn('done')))
  let threw = false
  try {
    for (;;) {
      const r = await gen.next()
      if (r.done) break
      if (isQueuedCommandAttachment(r.value)) {
        threw = true
        await gen.throw(new Error('rig teardown throw'))
        break
      }
    }
  } catch {
    /* the thrown teardown propagates — expected */
  }
  await settle()
  check('the throw landed at the attachment yield', threw)
  const left = queueStore.getCommandQueue()
  check(
    'the yielded command is CONSUMED despite the thrown teardown (both teardown shapes share the finally)',
    left.length === 0,
    `queue still holds ${left.length}: ${JSON.stringify(left.map(c => c.value))}`,
  )
  queueStore.resetCommandQueue()
}

// ── A7 — the notice-level census ────────────────────────────────────────────
section("A7 — every turn-machine notice is 'warning' or 'error' (the record gate)")
{
  const src = readFileSync(join(import.meta.dir, '..', '..', 'src/run-core/turn-machine.ts'), 'utf8')
  const parts = src.split('createSystemMessage(')
  check('the turn machine emits system notices', parts.length > 1, String(parts.length - 1))
  for (let i = 1; i < parts.length; i++) {
    const window = parts[i]!.slice(0, 300)
    const line = src.slice(0, src.indexOf('createSystemMessage(') + parts.slice(1, i).join('createSystemMessage(').length).split('\n').length
    check(
      `notice #${i} carries an operator-visible level (an info-level stop notice would never persist)`,
      /'(warning|error)'/.test(window),
      `near line ${line}: ${window.slice(0, 80).replace(/\n/g, ' ')}`,
    )
  }
}

// ── verdict ─────────────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(76))
if (failures > 0) {
  console.log(`DELIVERY-INTERLEAVINGS: ${failures} of ${checks} checks FAILED`)
  process.exit(1)
}
console.log(`DELIVERY-INTERLEAVINGS: all ${checks} checks passed`)
process.exit(0)
