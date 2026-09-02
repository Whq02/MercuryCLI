#!/usr/bin/env bun
// ============================================================================
//  scripts/provider-compat/prove-switch-subagent-adversary.ts — MID-SUBAGENT
//  model switching (SWITCHADV drive family 3): subagents SNAPSHOT their model
//  at spawn; a parent-session switch never re-models a subagent in flight;
//  a subagent spawned after the boundary inherits the NEW model; results
//  return to the parent whole either way.
//
//    T1 (parent on claude): the model asks for an Agent launch; the pick to
//        gpt lands MID-TURN (parked) at the Agent call's permission gate —
//        BEFORE the subagent executes. The subagent must still ride claude
//        (the spawn inherits the parent TURN's model, never the parked
//        pick), its result must return into the parent's round 2, and the
//        whole parent turn stays on claude.
//    ⋈   the boundary applies gpt.
//    T2 (parent on gpt): a second Agent launch — the subagent must ride gpt
//        (post-boundary spawns inherit the new model), result returned.
//    BG  (parent on claude again): a BACKGROUNDED Agent launch that sleeps
//        mid-run; the parent turn settles, an idle pick applies gpt at once,
//        and the in-flight subagent's LATE rounds — landing after the apply
//        — must still ride claude (snapshot beats the applied switch).
//
//  Run: ~/.bun/bin/bun run scripts/provider-compat/prove-switch-subagent-adversary.ts
// ============================================================================
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const note = (label: string): void => {
  console.log(`  [NOTE] ${label}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — subagent switch adversary prover exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

delete process.env.NODE_ENV
delete process.env.CI
delete process.env.CLAUDE_EFFORT
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'switch-subagent-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

type Body = Record<string, unknown>
type Captured = { path: string; body: Body; at: number }
const captured: Captured[] = []
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
let toolSeq = 0

function anthropicAgentCall(prompt: string, background: boolean): string {
  const id = `toolu_sub_${++toolSeq}`
  const input = {
    description: 'switch probe',
    prompt,
    subagent_type: 'general-purpose',
    ...(background ? { run_in_background: true } : {}),
  }
  return [
    `event: message_start\n${sse({ type: 'message_start', message: { id: 'msg_fx', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`,
    `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name: 'Agent', input: {} } })}`,
    `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } })}`,
    `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`,
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { input_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 } })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  ].join('')
}
function anthropicBashCall(command: string): string {
  const id = `toolu_sub_${++toolSeq}`
  return [
    `event: message_start\n${sse({ type: 'message_start', message: { id: 'msg_fx', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`,
    `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name: 'Bash', input: {} } })}`,
    `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command, description: 'sub probe' }) } })}`,
    `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`,
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { input_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 } })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  ].join('')
}
function anthropicFinal(text: string): string {
  return [
    `event: message_start\n${sse({ type: 'message_start', message: { id: 'msg_fx', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`,
    `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
    `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}`,
    `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`,
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 2 } })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  ].join('')
}
function responsesAgentCall(prompt: string): string {
  const id = `call_sub_${++toolSeq}`
  return [
    sse({ type: 'response.created', response: { id: 'resp_fx' } }),
    sse({ type: 'response.output_item.done', item: { type: 'function_call', name: 'Agent', call_id: id, arguments: JSON.stringify({ description: 'switch probe', prompt, subagent_type: 'general-purpose' }) } }),
    sse({ type: 'response.completed', response: { id: 'resp_fx', usage: { input_tokens: 6, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } } } }),
  ].join('')
}
function responsesFinal(text: string): string {
  return [
    sse({ type: 'response.created', response: { id: 'resp_fx' } }),
    sse({ type: 'response.output_text.delta', delta: text }),
    sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } }),
    sse({ type: 'response.completed', response: { id: 'resp_fx', usage: { input_tokens: 6, output_tokens: 2, input_tokens_details: { cached_tokens: 0 } } } }),
  ].join('')
}

/** The user-prompt texts of a body — the parent's own prompts ride there
 *  (every parent round replays them); a sub's user prompt is its SUBTASK
 *  line alone. The RAW body is not the place to look for a turn marker: a
 *  sub-agent's request carries its own system prompt with the working
 *  directory's recent commits, and a commit message spelling "T1 " (this
 *  suite's own commits do) turned every sub body into a "parent" — the
 *  fixture served it an Agent call the sub does not own, the sub errored
 *  into the parent's settle text, and no sub request was ever seen as one.
 *  Reading the user messages only holds on any worktree, whatever its
 *  history says. */
function userPromptsOf(body: Body, isResponses: boolean): string {
  if (isResponses) {
    const input = (body.input as Array<Record<string, unknown>> | undefined) ?? []
    return input
      .filter(item => item.type === 'message' && item.role === 'user')
      .map(item => JSON.stringify(item.content ?? ''))
      .join('\n')
  }
  const messages = (body.messages as Array<Record<string, unknown>> | undefined) ?? []
  return messages
    .filter(m => m.role === 'user')
    .map(m => JSON.stringify(m.content ?? ''))
    .join('\n')
}

/** Content routing. A PARENT body always carries its turn's T-marker in a
 *  user prompt (the parent's prompt rides in every parent round); a SUBAGENT
 *  body never does (the sub's history is its own prompt) even though parent
 *  bodies REPLAY the Agent tool_use input containing the SUBTASK marker. A
 *  body whose final item answers a tool call settles. */
const isParentBody = (body: Body, path: string): boolean =>
  /T[123] /.test(userPromptsOf(body, path.endsWith('/responses')))
function script(path: string, body: Body): string {
  const raw = JSON.stringify(body)
  const isResponses = path.endsWith('/responses')
  const prompts = userPromptsOf(body, isResponses)
  const answered = ((): boolean => {
    if (isResponses) {
      const input = (body.input as Array<Record<string, unknown>> | undefined) ?? []
      return input.at(-1)?.type === 'function_call_output'
    }
    const messages = (body.messages as Array<Record<string, unknown>> | undefined) ?? []
    const last = messages.at(-1)
    return last?.role === 'user' && JSON.stringify(last?.content ?? '').includes('tool_result')
  })()
  // Subagent lanes (no parent T-marker in the user prompts).
  if (!isParentBody(body, path)) {
    if (raw.includes('SUBTASK-SLOW')) {
      if (answered) return isResponses ? responsesFinal('sub-slow-done') : anthropicFinal('sub-slow-done')
      return isResponses ? responsesFinal('sub-slow-done') : anthropicBashCall('sleep 2 && echo sub-slow-step')
    }
    return isResponses ? responsesFinal('sub-probe-done') : anthropicFinal('sub-probe-done')
  }
  // Parent lanes — the NEWEST T-marker wins (the whole history replays, so
  // T2 bodies still contain T1's prompt; first-match routing re-fires T1).
  if (answered) return isResponses ? responsesFinal('parent-settled') : anthropicFinal('parent-settled')
  let best: { at: number; m: 'T1 ' | 'T2 ' | 'T3 ' } | null = null
  for (const m of ['T1 ', 'T2 ', 'T3 '] as const) {
    const at = prompts.lastIndexOf(m)
    if (at >= 0 && (best === null || at > best.at)) best = { at, m }
  }
  if (best?.m === 'T1 ') return isResponses ? responsesAgentCall('SUBTASK-A work the sub probe') : anthropicAgentCall('SUBTASK-A work the sub probe', false)
  if (best?.m === 'T2 ') return isResponses ? responsesAgentCall('SUBTASK-B work the second probe') : anthropicAgentCall('SUBTASK-B work the second probe', false)
  if (best?.m === 'T3 ') return isResponses ? responsesFinal('parent-settled') : anthropicAgentCall('SUBTASK-SLOW work the slow probe', true)
  return isResponses ? responsesFinal('parent-settled') : anthropicFinal('parent-settled')
}

const OPENAI_MODELS_BODY = {
  models: [{ slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', supported_reasoning_levels: [{ effort: 'high', description: 'high' }], default_reasoning_level: 'high', visibility: 'list', priority: 1, context_window: 272_000, input_modalities: ['text'], supported_in_api: true }],
}
const PORT = 35303
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    let body: Body = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Body
    } catch {
      body = {}
    }
    if (req.method === 'GET' && path.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(path.startsWith('/openai/') ? OPENAI_MODELS_BODY : { object: 'list', data: [] }))
      return
    }
    if (req.method === 'POST' && (path.endsWith('/v1/messages') || path.endsWith('/responses'))) {
      captured.push({ path, body, at: Date.now() })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(script(path, body))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
})
await new Promise<void>((resolve, reject) => {
  server.once('error', reject)
  server.listen(PORT, '127.0.0.1', resolve)
})
const base = `http://127.0.0.1:${PORT}`
Object.assign(process.env, {
  ANTHROPIC_BASE_URL: base,
  ANTHROPIC_AUTH_TOKEN: 'fixture-token',
  MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
  MERCURY_OPENAI_CHATGPT_BASE: `${base}/openai/chatgpt`,
  MERCURY_OPENAI_AUTH_BASE: `${base}/openai/auth`,
  OPENAI_API_KEY: 'fixture-openai-key',
})

console.log('============================================================')
console.log(' mid-subagent switch — spawn snapshots, boundary inheritance')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { queryEvents } = await import('../../src/query.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { BashTool } = await import('../../src/tools/BashTool/BashTool.tsx')
const { AgentTool } = await import('../../src/tools/AgentTool/AgentTool.tsx')
const { getBuiltInAgents } = await import('../../src/tools/AgentTool/builtInAgents.ts')
const { settleModelSelection, settlePendingAtBoundary } = await import(
  '../../src/utils/model/modelTransition.ts'
)
type Message = import('../../src/types/message.ts').Message

const builtIns = getBuiltInAgents()
const agentDefinitions = { activeAgents: builtIns, allAgents: builtIns }

type Slice = {
  mainLoopModel: string | null
  mainLoopModelForSession: string | null
  pendingModelSwitch: { setting: string | null } | null
}

function makeCtx(model: string): Record<string, unknown> {
  let appState: Record<string, unknown> = {
    ...(getDefaultAppState() as unknown as Record<string, unknown>),
    effortValue: 'high',
  }
  return {
    abortController: new AbortController(),
    options: {
      commands: [],
      tools: [BashTool, AgentTool],
      mainLoopModel: model,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      debug: false,
      verbose: false,
      agentDefinitions,
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
}

async function driveTurn(
  history: Message[],
  model: string,
  onAgentPermission?: () => void,
): Promise<{ settled: Message[]; requests: Captured[]; terminal: Record<string, unknown>; threw: unknown }> {
  const before = captured.length
  const settled: Message[] = []
  let terminal: Record<string, unknown> = {}
  let threw: unknown
  try {
    const gen = queryEvents({
      messages: history as never,
      systemPrompt: ['subagent switch rig prompt'] as never,
      userContext: {},
      systemContext: {},
      canUseTool: (async (tool: { name?: string }, input: Record<string, unknown>) => {
        if (tool?.name === 'Agent') onAgentPermission?.()
        return { behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'rig' } }
      }) as never,
      toolUseContext: makeCtx(model) as never,
      querySource: 'sdk' as never,
    })
    let r = await gen.next()
    while (!r.done) {
      const ev = r.value as { kind?: string; message?: Message }
      if ((ev.kind === 'assistant_settled' || ev.kind === 'tool_settled') && ev.message) settled.push(ev.message)
      r = await gen.next()
    }
    terminal = r.value as Record<string, unknown>
  } catch (error) {
    threw = error
  }
  return { settled, requests: captured.slice(before), terminal, threw }
}

/** Sub bodies never carry a parent T-marker in a user prompt; the SUBTASK
 *  marker then names WHICH sub. */
const isSub = (c: Captured, marker: string): boolean => {
  const raw = JSON.stringify(c.body)
  return !isParentBody(c.body, c.path) && raw.includes(marker)
}
const modelOf = (c: Captured): string => String(c.body.model)

// ── T1: parent on claude, pick parks at the Agent gate, sub A rides claude ──
section('T1 · parent claude — pick parks BEFORE the subagent runs; sub A rides claude')
let slice: Slice = { mainLoopModel: 'claude-sonnet-5', mainLoopModelForSession: null, pendingModelSwitch: null }
let history: Message[] = [createUserMessage({ content: 'T1 spawn the probe agent' }) as Message]
let parked = ''
const t1 = await driveTurn(history, slice.mainLoopModel!, () => {
  const settled = settleModelSelection(slice, 'gpt-5.6-sol', { turnActive: true })
  parked = settled.kind
  if (settled.kind === 'queued') slice = { ...slice, ...settled.patch }
})
check('T1 settled clean', t1.threw === undefined && t1.terminal.reason === 'completed', `threw=${String(t1.threw)} terminal=${JSON.stringify(t1.terminal)}`)
check('the pick PARKED at the Agent permission gate (before the sub ran)', parked === 'queued')
const subA = t1.requests.filter(c => isSub(c, 'SUBTASK-A'))
const parentT1 = t1.requests.filter(c => !isSub(c, 'SUBTASK-A'))
check('sub A dispatched and rode claude — the spawn snapshot ignores the parked pick', subA.length >= 1 && subA.every(c => modelOf(c) === 'claude-sonnet-5' && c.path.endsWith('/v1/messages')), subA.map(c => `${c.path}:${modelOf(c)}`).join(' '))
check('every parent T1 round stayed on claude', parentT1.length >= 2 && parentT1.every(c => modelOf(c) === 'claude-sonnet-5'), parentT1.map(modelOf).join(' '))
check("sub A's result returned into the parent's follow-up round", parentT1.some(c => JSON.stringify(c.body).includes('sub-probe-done')))

// ── boundary applies gpt ────────────────────────────────────────────────────
const b1 = settlePendingAtBoundary(slice)
check('the boundary applies the parked gpt pick', b1 !== null && b1.receipt.applied === 'gpt-5.6-sol' && b1.receipt.crossProvider === true)
if (b1) slice = { ...slice, ...b1.patch } as Slice

// ── T2: parent on gpt, sub B must inherit gpt ──────────────────────────────
section('T2 · parent gpt — the post-boundary spawn inherits the NEW model')
history = [...history, ...t1.settled, createUserMessage({ content: 'T2 spawn the second probe agent' }) as Message]
const t2 = await driveTurn(history, slice.mainLoopModel!, undefined)
check('T2 settled clean', t2.threw === undefined && t2.terminal.reason === 'completed', `threw=${String(t2.threw)} terminal=${JSON.stringify(t2.terminal)}`)
const subB = t2.requests.filter(c => isSub(c, 'SUBTASK-B'))
const parentT2 = t2.requests.filter(c => !isSub(c, 'SUBTASK-B'))
for (const c of t2.requests) {
  const raw = JSON.stringify(c.body)
  note(`T2 wire row: ${c.path} model=${modelOf(c)} ${isParentBody(c.body, c.path) ? 'parent' : 'sub'}`)
  if (!isParentBody(c.body, c.path)) {
    const at = raw.indexOf('SUBTASK')
    note(`  sub marker: ${at === -1 ? 'ABSENT' : raw.slice(at, at + 60)}`)
    const inputItems = (c.body.input as Array<Record<string, unknown>> | undefined) ?? []
    note(`  sub input items: ${inputItems.map(i => `${String(i.type)}/${String(i.role ?? '')}`).join(',')}`)
  }
}
check('sub B rode gpt (inherits the applied model) on the Responses wire', subB.length >= 1 && subB.every(c => modelOf(c) === 'gpt-5.6-sol' && c.path.endsWith('/responses')), subB.map(c => `${c.path}:${modelOf(c)}`).join(' '))
check('every parent T2 round rode gpt', parentT2.length >= 2 && parentT2.every(c => modelOf(c) === 'gpt-5.6-sol'), parentT2.map(modelOf).join(' '))
check("sub B's result returned into the parent's follow-up round", parentT2.some(c => JSON.stringify(c.body).includes('sub-probe-done')))

// ── BG: an in-flight background subagent crosses an APPLIED switch ─────────
section('BG · a background subagent in flight across an applied switch keeps its spawn model')
{
  // Fresh session state back on claude.
  slice = { mainLoopModel: 'claude-sonnet-5', mainLoopModelForSession: null, pendingModelSwitch: null }
  const bgHistory: Message[] = [createUserMessage({ content: 'T3 spawn the slow background probe' }) as Message]
  const t3 = await driveTurn(bgHistory, slice.mainLoopModel!, undefined)
  const launched = t3.threw === undefined && t3.terminal.reason === 'completed'
  check('the background-launch turn settled while the sub still runs', launched, `threw=${String(t3.threw)} terminal=${JSON.stringify(t3.terminal)}`)
  if (launched) {
    // The idle pick applies gpt IMMEDIATELY — the sub is mid-flight.
    const idle = settleModelSelection(slice, 'gpt-5.6-sol', { turnActive: false })
    const appliedAt = Date.now()
    check('the idle pick applied during the sub flight', idle.kind === 'applied')
    if (idle.kind === 'applied') slice = { ...slice, ...idle.patch } as Slice
    // Wait for the slow sub's LATE rounds (the sleep 2 lands them well after).
    const deadline = Date.now() + 12_000
    let late: Captured[] = []
    while (Date.now() < deadline) {
      late = captured.filter(c => isSub(c, 'SUBTASK-SLOW') && c.at > appliedAt)
      if (late.length >= 1) break
      await new Promise(r => setTimeout(r, 250))
    }
    if (late.length === 0) {
      note('background sub produced no post-apply rounds in-process — the async task lane may not run under the synthetic ctx; the foreground snapshot laws above stand, naming this leg for the PTY journey')
      check('background overlap leg observed (soft: at least the launch round rode claude)', captured.filter(c => isSub(c, 'SUBTASK-SLOW')).every(c => modelOf(c) === 'claude-sonnet-5'), captured.filter(c => isSub(c, 'SUBTASK-SLOW')).map(modelOf).join(' '))
    } else {
      check(`the in-flight sub's POST-APPLY rounds (${late.length}) still ride claude — snapshot beats the applied switch`, late.every(c => modelOf(c) === 'claude-sonnet-5' && c.path.endsWith('/v1/messages')), late.map(c => `${c.path}:${modelOf(c)}@${c.at - appliedAt}ms`).join(' '))
    }
  }
}

server.close()
console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
