#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

const homeRoot = process.env.MERCURY_CONFIG_DIR ?? tmpdir()
mkdirSync(homeRoot, { recursive: true })
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(homeRoot, 'early-read-declined-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'early-read-declined-daemon-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
for (const key of ['MERCURY_BARE', 'MERCURY_EFFORT_LEVEL', 'MERCURY_MAX_OUTPUT_TOKENS', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'MERCURY_SCRIPTED_STREAM', 'NODE_ENV']) delete process.env[key]

const { query } = await import('../../src/query.ts')
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/utils/messages/factories.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { createPermissionContext } = await import('../../src/hooks/toolPermission/PermissionContext.ts')
const { CANCEL_MESSAGE, REJECT_MESSAGE, REJECT_MESSAGE_WITH_REASON_PREFIX } = await import('../../src/utils/messages/rejectionText.ts')
const { INTERRUPT_MESSAGE, INTERRUPT_MESSAGE_FOR_TOOL_USE, isInterruptedResultText } = await import('../../src/utils/messages/turnCut.ts')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
  if (!cond) failures++
}
function section(title: string): void {
  console.log(`\n${'─'.repeat(76)}\n${title}`)
}
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — prove-early-read-declined exceeded 120s')
  process.exit(1)
}, 120_000)
watchdog.unref?.()

type AnyMessage = Record<string, unknown> & { type?: string }
const MODEL = 'claude-opus-4-8'

const ran: string[] = []
function makeTool(name: string, readOnly: boolean): never {
  return {
    name,
    async description() { return 'rig tool' },
    async prompt() { return 'rig tool' },
    inputSchema: z.object({}).catchall(z.unknown()),
    userFacingName: () => name,
    isEnabled: () => true,
    isConcurrencySafe: () => readOnly,
    isReadOnly: () => readOnly,
    getPath: (input: Record<string, unknown>) => (typeof input.file_path === 'string' ? input.file_path : undefined),
    isMcp: false,
    maxResultSizeChars: 50_000,
    needsPermissions: () => true,
    async validateInput() { return { result: true } },
    async call(_input: Record<string, unknown>, context: { toolUseId?: string }) {
      ran.push(context.toolUseId ?? '?')
      return { data: `${name} ran` }
    },
    mapToolResultToToolResultBlockParam: (data: unknown, toolUseID: string) => ({ type: 'tool_result', tool_use_id: toolUseID, content: String(data) }),
  } as never
}
const TOOLS = [makeTool('Read', true), makeTool('Edit', false)]

type Answer = 'allow' | 'decline' | 'decline with words'
interface Scene {
  calls: Array<{ name: string; input: Record<string, unknown>; answer: Answer }>
  answersAfterReply?: boolean
  interruptAfterAnswer?: boolean
}
interface Run {
  requests: number
  asked: string[]
  ran: string[]
  results: Map<string, string>
  texts: string[]
  turnAborted: boolean
  ids: string[]
}

async function run(scene: Scene, label: string): Promise<Run> {
  ran.length = 0
  const asked: string[] = []
  let appState: Record<string, unknown> = { ...(getDefaultAppState() as unknown as Record<string, unknown>), effortValue: 'high' }
  const abortController = new AbortController()
  const context: Record<string, unknown> = {
    abortController,
    options: { commands: [], tools: TOOLS, engineModel: MODEL, thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, debug: false, verbose: false, agentDefinitions: { activeAgents: [], allAgents: [] } },
    getAppState: () => appState,
    setAppState: (update: (previous: never) => never): void => { appState = update(appState as never) as unknown as Record<string, unknown> },
    messages: [],
    readFileState: createFileStateCacheWithSizeLimit(100),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  }
  const ids = scene.calls.map((_, index) => `tu_${label}_${index + 1}`)
  const answers = new Map(scene.calls.map((call, index) => [ids[index]!, call.answer]))
  let settledAsks = 0
  let wake: (() => void) | null = null
  let replyEnded = false
  const canUseTool = async (tool: never, input: Record<string, unknown>, toolUseContext: never, assistantMessage: never, toolUseID: string) => {
    asked.push(toolUseID)
    const answer = answers.get(toolUseID)
    if (scene.answersAfterReply) {
      const deadline = Date.now() + 1500
      while (!replyEnded && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
      await new Promise(resolve => setTimeout(resolve, 120))
    }
    const permission = createPermissionContext(tool, input, toolUseContext, assistantMessage, toolUseID, () => {})
    const decision = answer === 'allow' ? permission.buildAllow(input) : permission.cancelAndAbort(answer === 'decline with words' ? 'read the other file' : undefined, false)
    settledAsks++
    wake?.()
    return decision
  }
  let requests = 0
  async function* callModel(): AsyncGenerator<never, void> {
    requests++
    if (requests > 1) {
      const done = createAssistantMessage({ content: 'the model went on' })
      done.message.stop_reason = 'end_turn'
      yield done as never
      return
    }
    for (const [index, call] of scene.calls.entries()) {
      const block = createAssistantMessage({ content: [{ type: 'tool_use', id: ids[index], name: call.name, input: call.input }] as never })
      block.message.id = `msg_${label}`
      block.message.stop_reason = null
      yield block as never
    }
    const early = scene.answersAfterReply ? 0 : scene.calls.filter(call => call.name === 'Read').length
    const deadline = Date.now() + 1500
    while (settledAsks < Math.min(early, 1) && Date.now() < deadline) await new Promise<void>(resolve => { wake = resolve; setTimeout(resolve, 25) })
    await new Promise(resolve => setTimeout(resolve, 60))
    if (scene.interruptAfterAnswer) {
      abortController.abort()
      return
    }
    const tail = createAssistantMessage({ content: 'and that is the reply' })
    tail.message.id = `msg_${label}`
    tail.message.stop_reason = 'tool_use'
    yield tail as never
    replyEnded = true
  }
  const turn = query({
    messages: [createUserMessage({ content: 'please do the thing' })] as never,
    systemPrompt: ['rig system prompt'] as never,
    userContext: {},
    systemContext: {},
    canUseTool: canUseTool as never,
    toolUseContext: context as never,
    querySource: 'sdk' as never,
    deps: {
      callModel: callModel as never,
      autocompact: (async () => ({ wasCompacted: false })) as never,
      microcompact: (async (messages: unknown[]) => ({ messages })) as never,
      uuid: (() => { let n = 0; return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` })(),
    },
  }) as AsyncGenerator<AnyMessage, unknown>
  const results = new Map<string, string>()
  const texts: string[] = []
  for (let step = await turn.next(); !step.done; step = await turn.next()) {
    const message = step.value as { type?: string; message?: { content?: unknown } }
    if (message.type !== 'user' || !Array.isArray(message.message?.content)) continue
    for (const block of message.message.content as Array<Record<string, unknown>>) {
      if (block.type === 'tool_result') results.set(String(block.tool_use_id), typeof block.content === 'string' ? block.content : JSON.stringify(block.content))
      if (block.type === 'text') texts.push(String(block.text))
    }
  }
  return { requests, asked: [...asked], ran: [...ran], results, texts, turnAborted: abortController.signal.aborted, ids }
}

const brief = (r: Run): string => JSON.stringify({ requests: r.requests, asked: r.asked, ran: r.ran, results: [...r.results].map(([id, text]) => [id, text.slice(0, 80)]), texts: r.texts, turnAborted: r.turnAborted })

section('the settled road: a writing call the operator declines stops the turn')
const settled = await run({ calls: [{ name: 'Edit', input: { file_path: '/tmp/declined/a.txt' }, answer: 'decline' }] }, 'settled')
check('one request, nothing run, the turn stopped, the call answered by the declination and the turn closed for tool use', settled.requests === 1 && settled.ran.length === 0 && settled.turnAborted && (settled.results.get(settled.ids[0]!) ?? '').includes(REJECT_MESSAGE) && settled.texts.includes(INTERRUPT_MESSAGE_FOR_TOOL_USE), brief(settled))

section('a read that started while the reply was still arriving, declined: the same stop, the same words')
const early = await run({ calls: [{ name: 'Read', input: { file_path: '/tmp/declined/a.txt' }, answer: 'decline' }] }, 'early')
check('the model is sent no further request', early.requests === 1, brief(early))
check('the turn is stopped', early.turnAborted, brief(early))
check('the call is answered by the declination itself, which says it was not run', (early.results.get(early.ids[0]!) ?? '').includes(REJECT_MESSAGE) && early.ran.length === 0, brief(early))
check('the turn closes with the same line as on the settled road', early.texts.includes(INTERRUPT_MESSAGE_FOR_TOOL_USE), brief(early))

section('the same read declined after the whole reply has arrived, the card still standing: the same stop')
const late = await run({ calls: [{ name: 'Read', input: { file_path: '/tmp/declined/a.txt' }, answer: 'decline' }], answersAfterReply: true }, 'late')
check('no further request, the turn stopped, the declination as the answer, the settled road\'s closing line', late.requests === 1 && late.turnAborted && (late.results.get(late.ids[0]!) ?? '').includes(REJECT_MESSAGE) && late.ran.length === 0 && late.texts.includes(INTERRUPT_MESSAGE_FOR_TOOL_USE), brief(late))

section("the operator's interrupt after the No, the reply still arriving: the turn ends at once by the interrupt's own road")
const interrupted = await run({ calls: [{ name: 'Read', input: { file_path: '/tmp/declined/a.txt' }, answer: 'decline' }], interruptAfterAnswer: true }, 'interrupted')
check('the turn ends with the stream, sends no further request, and closes with the interrupt\'s line and the interrupted call\'s words', interrupted.requests === 1 && interrupted.turnAborted && interrupted.texts.includes(INTERRUPT_MESSAGE) && !interrupted.texts.includes(INTERRUPT_MESSAGE_FOR_TOOL_USE) && isInterruptedResultText(interrupted.results.get(interrupted.ids[0]!) ?? ''), brief(interrupted))

section('two reads in one reply, the first declined: the second is not put to the operator')
const pair = await run({ calls: [{ name: 'Read', input: { file_path: '/tmp/declined/a.txt' }, answer: 'decline' }, { name: 'Read', input: { file_path: '/tmp/declined/b.txt' }, answer: 'allow' }] }, 'pair')
check('one request and a stopped turn', pair.requests === 1 && pair.turnAborted, brief(pair))
check('neither read ran', pair.ran.length === 0, brief(pair))
check('the first is answered by the declination, the second by the line a stopped action gets', (pair.results.get(pair.ids[0]!) ?? '').includes(REJECT_MESSAGE) && (pair.results.get(pair.ids[1]!) ?? '').includes(CANCEL_MESSAGE), brief(pair))

section('a read declined with words for the model: the turn goes on with them, as on the settled road')
const worded = await run({ calls: [{ name: 'Read', input: { file_path: '/tmp/declined/a.txt' }, answer: 'decline with words' }] }, 'worded')
check('the model gets the operator\'s words and another request, and the turn is not stopped', worded.requests === 2 && !worded.turnAborted && (worded.results.get(worded.ids[0]!) ?? '').includes(`${REJECT_MESSAGE_WITH_REASON_PREFIX}read the other file`) && worded.ran.length === 0, brief(worded))

section('a read the operator allows runs and the turn goes on')
const allowed = await run({ calls: [{ name: 'Read', input: { file_path: '/tmp/declined/a.txt' }, answer: 'allow' }] }, 'allowed')
check('the read runs once, its result reaches the next request, nothing is stopped', allowed.requests === 2 && !allowed.turnAborted && allowed.ran.length === 1 && (allowed.results.get(allowed.ids[0]!) ?? '').includes('Read ran'), brief(allowed))

console.log(`\nprove-early-read-declined: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
