#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'delivery-adv-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'delivery-adv-daemon-'))
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

const { query } = await import('../../src/engine/turnDoor.ts')
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
  const where = /notice|silence/.test(label)
    ? ''
    : '\n    fix: queued-command delivery: selectDrainableCommands and consumeDrainedCommands in src/engine/loop/attachment-drain.ts, the queue in src/screen/composer/input-core/command-queue.ts, and the turn in src/engine/loop/turn-machine.ts'
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}${!cond ? where : ''}`)
  if (!cond) failures++
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — delivery-interleavings prover exceeded 120s; a generator in the section printed last never finished, so look at query() in src/engine/turnDoor.ts and the turn in src/engine/loop/turn-machine.ts')
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
  const second = makeGen(i => (i === 0 ? toolTurn('EchoTool', { text: 'round one' }) : textTurn('done')))
  const yields = await runWhole(second.gen)
  const drained = yields.filter(isQueuedCommandAttachment)
  check('the next turn delivers the survivor exactly once', drained.length === 1, String(drained.length))
  const body = JSON.stringify(second.calls[1]?.messages ?? [])
  check('…and its words reach the next model call', body.includes('subset words TWO'))
  check('…while the consumed first never re-delivers', !body.includes('subset words ONE'))
  check('the queue is empty after the second turn', queueStore.getCommandQueue().length === 0)
}

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

section('A7 — silence stays detail-only; every other turn-machine notice is recorded')
{
  const t = await import('./turnScenarios.ts')
  const { makeRequest } = await import('../../src/engine/loop/turn/makeRequest.ts')
  const { modelReply } = await import('../../src/engine/loop/turn/modelReply.ts')
  const { NO_TOOL_RULES, readReply } = await import('../../src/engine/loop/turn/noToolReply.ts')
  const { createAssistantAPIErrorMessage } = await import('../../src/engine/messages/messages.ts')
  const { resolveAutoCompactWindow } = await import('../../src/engine/compaction/autoFold.ts')
  const { fitImagesToRequestCap } = await import('../../src/platform/images/imageResizer.ts')
  const { rosterOwnerFromToolUseContext } = await import('../../src/engine/run-owner/resolveOwner.ts')
  const f = t.fixtures
  type Spoken = { where: string; level: unknown; words: string }
  const systemNotices = (where: string, events: ReadonlyArray<Record<string, unknown> & { kind: string }>): Spoken[] =>
    events.flatMap(event => {
      const message = event.message as { type?: string; subtype?: string; level?: unknown; content?: unknown } | undefined
      return event.kind === 'notice' && message?.type === 'system' && message.subtype === 'informational' ? [{ where, level: message.level, words: String(message.content) }] : []
    })

  const spoken: Spoken[] = []
  for (const scenario of t.SCENARIOS) spoken.push(...systemNotices(scenario.name, (await t.runScripted(scenario.plan())).events))
  const NEAR_THE_WINDOW = 'a request that failed near the window'
  const nearTheWindow = Math.floor(resolveAutoCompactWindow(t.MODEL).window * 0.9)
  const failed = await t.runScripted({ seed: [f.ask('an old question'), f.fat('a long history', nearTheWindow), f.ask('hello there rig')], script: [f.yields(createAssistantAPIErrorMessage({ content: 'API Error: 500 upstream' }))] })
  spoken.push(...systemNotices(NEAR_THE_WINDOW, failed.events))
  const IMAGE_LEFT_OUT = 'a request that left an image out'
  const image = (data: string, kind: string): Record<string, unknown> => ({ type: 'image', source: { type: 'base64', media_type: `image/${kind}`, data } })
  const unreadable = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xfe, 0x00, 0x10]), Buffer.alloc(4096, 0x5a)]).toString('base64')
  const dot = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
  const manyImages = createUserMessage({ content: [image(unreadable, 'jpeg'), ...Array.from({ length: 20 }, () => image(dot, 'png')), { type: 'text', text: 'twenty-one images' }] as never })
  const sized = await t.plantRun({ script: [f.yields(f.says('twenty of them.'))] })
  await fitImagesToRequestCap([manyImages] as never, { model: t.MODEL, owner: String(rosterOwnerFromToolUseContext(sized.rig.ctx as never)) })
  const asked = await t.drain(makeRequest(sized.run as never, sized.state as never, 1))
  const answered = asked.decision.kind === 'go_on' ? await t.drain(modelReply(sized.run as never, asked.decision.iter as never)) : { events: [] }
  sized.close()
  spoken.push(...systemNotices(IMAGE_LEFT_OUT, [...asked.events, ...answered.events]))
  check(
    'the turn machine emits system notices',
    spoken.length > 0 && spoken.some(notice => notice.where === NEAR_THE_WINDOW) && spoken.some(notice => notice.where === IMAGE_LEFT_OUT),
    `the turn machine under src/engine/loop/turn/ must raise a system notice for a request that failed near the window and for one that left an image out; the counts show which is missing: ${spoken.length} system notice(s) over ${t.SCENARIOS.length} recorded scenarios and two planted requests; ${NEAR_THE_WINDOW}: ${spoken.filter(notice => notice.where === NEAR_THE_WINDOW).length}; ${IMAGE_LEFT_OUT}: ${spoken.filter(notice => notice.where === IMAGE_LEFT_OUT).length}`,
  )

  const silenceRule = NO_TOOL_RULES.find(entry => entry.name === 'empty_reply_retry')!
  const saidAfter = async (reply: unknown, plan: Partial<Parameters<typeof t.plantReply>[0]> = {}): Promise<Spoken[]> => {
    const planted = await t.plantReply({ ...plan, script: [f.yields(reply)] })
    const out = await t.drain(silenceRule.decide(planted.run as never, planted.iter as never, readReply(planted.iter as never)))
    planted.close()
    return systemNotices('the rule', out.events)
  }
  const afterSilence = await saidAfter(f.empty('silence'), { sessionKind: 'oculus' })
  const afterOtherReplies = [...(await saidAfter(f.empty('empty'))), ...(await saidAfter(f.empty('cap'))), ...(await saidAfter(f.says('an answer.')))]
  const silenceWords = afterSilence[0]?.words
  const detailOnly = spoken.filter(notice => notice.level === 'info')
  check(
    'exactly one silence notice is detail-only, guarded by the silence outcome',
    afterSilence.length === 1 && afterSilence[0]?.level === 'info' && afterOtherReplies.every(notice => notice.level !== 'info') && detailOnly.length > 0 && detailOnly.every(notice => notice.words === silenceWords),
    `a reply the provider ended with nothing said: ${JSON.stringify(afterSilence)}; an empty reply, a reply cut at the cap and a reply of words: ${JSON.stringify(afterOtherReplies.map(notice => notice.level))}; detail-only notices in the runs: ${JSON.stringify(detailOnly)} — the empty_reply_retry rule of src/engine/loop/turn/noToolReply.ts gives the silence note alone the level 'info'`,
  )
  const unheard = spoken.filter(notice => !(notice.level === 'info' && notice.words === silenceWords) && notice.level !== 'warning' && notice.level !== 'error' && notice.level !== 'suggestion')
  check(
    'every other system notice of those runs carries an operator-visible level: warning, error or suggestion',
    unheard.length === 0,
    `${unheard.length} of ${spoken.length - detailOnly.length}: ${unheard.map(notice => `${notice.where} raised [${String(notice.level)}] ${notice.words.slice(0, 80)}`).join(' · ')} — a notice of the turn machine is given 'warning', 'error' or 'suggestion' where it is made under src/engine/loop/turn/; 'info' reaches no operator`,
  )
}

console.log('\n' + '='.repeat(76))
if (failures > 0) {
  console.log(`DELIVERY-INTERLEAVINGS: ${failures} of ${checks} checks FAILED`)
  process.exit(1)
}
console.log(`DELIVERY-INTERLEAVINGS: all ${checks} checks passed`)
process.exit(0)
