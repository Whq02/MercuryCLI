#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

const homeRoot = process.env.MERCURY_CONFIG_DIR ?? tmpdir()
mkdirSync(homeRoot, { recursive: true })
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(homeRoot, 'early-read-ask-kept-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'early-read-ask-kept-daemon-'))
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
const { REJECT_MESSAGE, REJECT_MESSAGE_WITH_REASON_PREFIX } = await import('../../src/utils/messages/rejectionText.ts')
const { INTERRUPT_MESSAGE_FOR_TOOL_USE } = await import('../../src/utils/messages/turnCut.ts')

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
  console.log('\nTIMEOUT — prove-early-read-ask-kept exceeded 120s')
  process.exit(1)
}, 120_000)
watchdog.unref?.()

type AnyMessage = Record<string, unknown> & { type?: string }
const MODEL = 'claude-opus-4-8'
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
async function until(holds: () => boolean, ms = 1500): Promise<void> {
  const deadline = Date.now() + ms
  while (!holds() && Date.now() < deadline) await pause(10)
}

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
      return { data: `${name} ran for ${context.toolUseId}` }
    },
    mapToolResultToToolResultBlockParam: (data: unknown, toolUseID: string) => ({ type: 'tool_result', tool_use_id: toolUseID, content: String(data) }),
  } as never
}
const TOOLS = [makeTool('Read', true), makeTool('Bash', false)]

type Call = { name: string; input: Record<string, unknown> }
type Answer = 'allow' | 'decline' | 'decline with words'
interface Scene {
  first: Call
  answerFirst: Answer
  when: 'before the cut' | 'after the retried reply'
  retried: Call[]
  answerRest?: Answer
}
interface Run {
  requests: number
  asked: string[]
  withdrawn: string[]
  ran: string[]
  results: Map<string, string>
  texts: string[]
  turnAborted: boolean
}
const READ_A: Call = { name: 'Read', input: { file_path: '/tmp/kept/a.txt', limit: 20 } }
const READ_A_REORDERED: Call = { name: 'Read', input: { limit: 20, file_path: '/tmp/kept/a.txt' } }
const READ_B: Call = { name: 'Read', input: { file_path: '/tmp/kept/b.txt' } }
const SHELL: Call = { name: 'Bash', input: { command: 'true' } }
const OLD = 'tu_withdrawn'
const idOf = (index: number): string => `tu_retried_${index + 1}`

async function run(scene: Scene): Promise<Run> {
  ran.length = 0
  const asked: string[] = []
  const withdrawn: string[] = []
  const cards = new Map<string, (answer: Answer) => void>()
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
  const canUseTool = (tool: never, input: Record<string, unknown>, toolUseContext: { abortController: AbortController }, assistantMessage: never, toolUseID: string) => new Promise(resolve => {
    asked.push(toolUseID)
    const permission = createPermissionContext(tool, input, toolUseContext as never, assistantMessage, toolUseID, () => {})
    const signal = toolUseContext.abortController.signal
    const onAbort = (): void => {
      withdrawn.push(toolUseID)
      cards.delete(toolUseID)
      resolve(permission.cancelAndAbort(undefined, true))
    }
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    const answer = (given: Answer): void => {
      signal.removeEventListener('abort', onAbort)
      cards.delete(toolUseID)
      resolve(given === 'allow' ? permission.buildAllow(input) : permission.cancelAndAbort(given === 'decline with words' ? 'read the other file' : undefined, false))
    }
    cards.set(toolUseID, answer)
    if (toolUseID !== OLD) answer(scene.answerRest ?? 'allow')
  })
  let requests = 0
  async function* callModel(request: { options: { onStreamingFallback?: () => void } }): AsyncGenerator<never, void> {
    requests++
    if (requests > 1) {
      const done = createAssistantMessage({ content: 'the model went on' })
      done.message.stop_reason = 'end_turn'
      yield done as never
      return
    }
    const withdrawnReply = createAssistantMessage({ content: [{ type: 'tool_use', id: OLD, name: scene.first.name, input: scene.first.input }] as never })
    withdrawnReply.message.id = 'msg_withdrawn'
    withdrawnReply.message.stop_reason = null
    yield withdrawnReply as never
    await until(() => cards.has(OLD))
    if (scene.when === 'before the cut') {
      cards.get(OLD)?.(scene.answerFirst)
      await until(() => scene.answerFirst !== 'allow' || ran.includes(OLD))
      await pause(40)
    }
    request.options.onStreamingFallback?.()
    for (const [index, call] of scene.retried.entries()) {
      const block = createAssistantMessage({ content: [{ type: 'tool_use', id: idOf(index), name: call.name, input: call.input }] as never })
      block.message.id = 'msg_retried'
      block.message.stop_reason = null
      yield block as never
    }
    const tail = createAssistantMessage({ content: 'and that is the retried reply' })
    tail.message.id = 'msg_retried'
    tail.message.stop_reason = scene.retried.length > 0 ? 'tool_use' : 'end_turn'
    yield tail as never
    if (scene.when === 'after the retried reply') setTimeout(() => cards.get(OLD)?.(scene.answerFirst), 150)
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
  await pause(250)
  return { requests, asked: [...asked], withdrawn: [...withdrawn], ran: [...ran], results, texts, turnAborted: abortController.signal.aborted }
}

const brief = (r: Run): string => JSON.stringify({ requests: r.requests, asked: r.asked, withdrawn: r.withdrawn, ran: r.ran, results: [...r.results].map(([id, text]) => [id, text.slice(0, 70)]), texts: r.texts, turnAborted: r.turnAborted })
const B = idOf(0)

section('the operator had answered when the reply was cut: the retried reply asks for the same read and is not put to the operator again')
{
  const kept = await run({ first: READ_A, answerFirst: 'allow', when: 'before the cut', retried: [READ_A] })
  check('one card for the one act', kept.asked.length === 1 && kept.asked[0] === OLD, brief(kept))
  check("the read runs for the retried reply's own call and its result carries that call's id", kept.ran.includes(B) && (kept.results.get(B) ?? '').includes(`Read ran for ${B}`), brief(kept))
  check('no result row names the call of the reply that was withdrawn', !kept.results.has(OLD), brief(kept))
  check('the turn goes on to its next request', kept.requests === 2 && !kept.turnAborted, brief(kept))
  const reordered = await run({ first: READ_A, answerFirst: 'allow', when: 'before the cut', retried: [READ_A_REORDERED] })
  check('the same call with its input keys in another order is the same act', reordered.asked.length === 1 && reordered.ran.includes(B), brief(reordered))
}

section('the operator was still deciding when the reply was cut: the card stands through the retry and answers the retried call')
{
  const open = await run({ first: READ_A, answerFirst: 'allow', when: 'after the retried reply', retried: [READ_A] })
  check('one card, never withdrawn', open.asked.length === 1 && open.withdrawn.length === 0, brief(open))
  check('the read runs once, for the retried call, after the answer', open.ran.length === 1 && open.ran[0] === B && (open.results.get(B) ?? '').includes(`Read ran for ${B}`) && !open.results.has(OLD), brief(open))
  const declined = await run({ first: READ_A, answerFirst: 'decline', when: 'after the retried reply', retried: [READ_A] })
  check('a No on that card declines the retried call and stops the turn', declined.asked.length === 1 && declined.ran.length === 0 && declined.requests === 1 && declined.turnAborted && (declined.results.get(B) ?? '').includes(REJECT_MESSAGE) && declined.texts.includes(INTERRUPT_MESSAGE_FOR_TOOL_USE), brief(declined))
  const worded = await run({ first: READ_A, answerFirst: 'decline with words', when: 'before the cut', retried: [READ_A] })
  check("a declination with words is kept with its words: the retried call gets them and the turn goes on", worded.asked.length === 1 && worded.ran.length === 0 && worded.requests === 2 && !worded.turnAborted && (worded.results.get(B) ?? '').includes(`${REJECT_MESSAGE_WITH_REASON_PREFIX}read the other file`), brief(worded))
}

section('a kept answer is for the same act only, once')
{
  const other = await run({ first: READ_A, answerFirst: 'allow', when: 'before the cut', retried: [READ_B] })
  check('another read in the retried reply is put to the operator on its own', other.asked.length === 2 && other.asked.includes(B) && other.ran.includes(B), brief(other))
  const twice = await run({ first: READ_A, answerFirst: 'allow', when: 'before the cut', retried: [READ_A, READ_A] })
  check('the same read twice in the retried reply: the first takes the kept answer, the second is asked', twice.asked.length === 2 && twice.asked.includes(idOf(1)) && !twice.asked.includes(B) && twice.ran.includes(B) && twice.ran.includes(idOf(1)), brief(twice))
  const openOther = await run({ first: READ_A, answerFirst: 'allow', when: 'after the retried reply', retried: [READ_B] })
  check('a card still open for a read the retried reply no longer asks is withdrawn when the tool round opens, and that read never runs', openOther.withdrawn.includes(OLD) && !openOther.ran.includes(OLD) && openOther.ran.includes(B) && !openOther.results.has(OLD), brief(openOther))
  const none = await run({ first: READ_A, answerFirst: 'allow', when: 'after the retried reply', retried: [] })
  check('a card still open when the retried reply asks for nothing is withdrawn with the turn, and nothing runs', none.withdrawn.includes(OLD) && none.ran.length === 0 && none.requests === 1, brief(none))
}

section('the retried reply puts a shell command before the same read, so the read waits for the tool round: still one card')
{
  const settled = await run({ first: READ_A, answerFirst: 'allow', when: 'before the cut', retried: [SHELL, READ_A] })
  check('the read is not asked again on the settled road either', settled.asked.filter(id => id === idOf(1)).length === 0 && settled.asked.includes(B) && settled.ran.includes(idOf(1)) && (settled.results.get(idOf(1)) ?? '').includes(`Read ran for ${idOf(1)}`), brief(settled))
}

console.log(`\nprove-early-read-ask-kept: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
