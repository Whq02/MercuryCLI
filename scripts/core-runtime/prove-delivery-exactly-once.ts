#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'delivery-once-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'delivery-once-daemon-'))
for (const k of [
  'MERCURY_BARE',
  'MERCURY_EFFORT_LEVEL',
  'MERCURY_MAX_OUTPUT_TOKENS',
  'MERCURY_COMPACT',
  'MERCURY_AUTO_COMPACT',
  'NODE_ENV',
]) {
  delete process.env[k]
}

const { turnDoor } = await import('../../src/engine/turnDoor.ts')
const bootstrap = await import('../../src/boot/process-state/processState.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { createAssistantMessage, createUserMessage } = await import(
  '../../src/engine/message-shapes/factories.ts'
)
const { createFileStateCacheWithSizeLimit } = await import('../../src/platform/files/fileStateCache.ts')
const queueStore = await import('../../src/screen/composer/input-core/command-queue.ts')

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
  console.log('\nTIMEOUT — delivery-exactly-once prover exceeded 120s; a turn never finished, look at drainQueuedCommands in src/engine/loop/turn/afterTools.ts')
  process.exit(1)
}, 120_000)
watchdog.unref?.()

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
      engineModel: MODEL,
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
  const gen = turnDoor({
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
      await gen.return({} as never)
      break
    }
  }
  await new Promise(resolve => setTimeout(resolve, 25))
  check(
    'the drain yielded the queued_command attachment',
    sawAttachment,
    'no queued_command attachment came out after the tool round; check drainQueuedCommands in src/engine/loop/turn/afterTools.ts',
  )
  const left = queueStore.getCommandQueue()
  check(
    'the yielded command is CONSUMED despite the teardown (exactly-once — a re-drain would deliver it twice)',
    left.length === 0,
    `queue still holds ${left.length} command(s): ${JSON.stringify(left.map(c => c.value))}; drainQueuedCommands in src/engine/loop/turn/afterTools.ts must mark the command as draining (markDraining in src/screen/composer/input-core/command-queue.ts) so it is removed even when the generator is closed at the yield`,
  )
}

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
  check('exactly ONE queued_command attachment yielded', drained.length === 1, `${drained.length} attachments; drainQueuedCommands in src/engine/loop/turn/afterTools.ts must yield each queued command once`)
  check(
    'the queue is empty after the turn',
    queueStore.getCommandQueue().length === 0,
    'a drained command was left in the queue; check drainQueuedCommands in src/engine/loop/turn/afterTools.ts and markDraining in src/screen/composer/input-core/command-queue.ts',
  )
  const secondCall = JSON.stringify(calls[1]?.messages ?? [])
  check('the steered words are in the NEXT model call (the legal boundary)', secondCall.includes('steer words D2'), 'the drained words did not reach calls[1]; check drainQueuedCommands in src/engine/loop/turn/afterTools.ts')
  const firstCall = JSON.stringify(calls[0]?.messages ?? [])
  check('…and not in the first (they arrived mid-turn)', !firstCall.includes('steer words D2'), 'the words were already in the first model call; the queue was drained before the first tool round settled')
}

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
    if (!enqueued && r.value.type === 'user') {
      enqueued = true
      enqueueSteer('steer words D3')
    }
    r = await gen.next()
  }
  check('the mid-round words were enqueued', enqueued, 'no user message was yielded by the first tool round, so the test never enqueued; the rig turn did not run a tool')
  const secondCall = JSON.stringify(calls[1]?.messages ?? [])
  check(
    'the words are in the SECOND call (the next legal boundary — never later)',
    secondCall.includes('steer words D3'),
    'the drain missed the first boundary after the round settled; check drainQueuedCommands in src/engine/loop/turn/afterTools.ts',
  )
  check(
    'the queue is empty after the turn',
    queueStore.getCommandQueue().length === 0,
    'a drained command was left in the queue; check drainQueuedCommands in src/engine/loop/turn/afterTools.ts and markDraining in src/screen/composer/input-core/command-queue.ts',
  )
}

section('D4 — teardown before any drain: the words stay queued (nothing was delivered)')
{
  queueStore.resetCommandQueue()
  enqueueSteer('steer words D4')
  const { gen } = makeGen(i => (i === 0 ? toolTurn('EchoTool', { text: 'round one' }) : textTurn('done')))
  await gen.next()
  await gen.return({} as never)
  await new Promise(resolve => setTimeout(resolve, 25))
  const left = queueStore.getCommandQueue()
  check(
    'the undelivered command is STILL queued (it rides to the next boundary; consumed-without-delivery would lose it)',
    left.length === 1 && JSON.stringify(left[0]?.value ?? '').includes('steer words D4'),
    `queue holds ${left.length}; a command is removed from the queue before it is yielded, check drainQueuedCommands in src/engine/loop/turn/afterTools.ts and markDraining in src/screen/composer/input-core/command-queue.ts`,
  )
  queueStore.resetCommandQueue()
}

console.log('\n' + '='.repeat(76))
if (failures > 0) {
  console.log(`DELIVERY-EXACTLY-ONCE: ${failures} of ${checks} checks FAILED`)
  process.exit(1)
}
console.log(`DELIVERY-EXACTLY-ONCE: all ${checks} checks passed`)
process.exit(0)
