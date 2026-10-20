import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join, resolve } from 'node:path'
import { z } from 'zod/v4'

const root = resolve(process.env.LLMHOST_PROOF_ROOT ?? join(import.meta.dir, '../..'))
if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
const home = mkdtempSync(join(process.env.MERCURY_CONFIG_DIR, 'llmhost-slots-'))
delete process.env.MERCURY_HOME
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.BROWSER = '/usr/bin/true'
delete process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS
delete process.env.MERCURY_SILENT_AFTER_HEADERS_MS
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import(`${root}/src/services/providers/credentialEnvSpellings.ts`)
for (const key of [...ALL_PROVIDER_CREDENTIAL_ENV_VARS, 'MERCURY_COMPAT_BASE_URL', 'MERCURY_COMPAT_MODELS', 'MERCURY_COMPAT_LABEL', 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC']) delete process.env[key]
for (const key of Object.keys(process.env)) if (/^MERCURY_COMPAT_.*_API_KEY$/.test(key)) delete process.env[key]

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail: unknown = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail === '' ? '' : ` — ${String(detail)}`}`)
}

const captures: Array<{ path: string; body: any; affinity: string | null }> = []
const state = {
  dialect: 'llamacpp',
  window: 131_072,
  totalSlots: 4,
  propsAvailable: true,
  propsRequests: 0,
  slotsRequests: 0,
  processingSlot: -1,
  firstTokenDelayMs: 0,
  mode: 'reply' as 'reply' | 'tools' | '5xx-once' | 'delayed-first-token' | 'slow-tool-stream',
}
const model = 'Fixture/GLM-5.3-Flash-GGUF'

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(Buffer.from(chunk)))
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
    req.on('error', rejectBody)
  })
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const payload = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) })
  res.end(payload)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname
  if (path === '/v1/models') {
    sendJson(res, 200, { data: [{ id: model, owned_by: state.dialect }] })
    return
  }
  if (path === '/props') {
    state.propsRequests++
    if (!state.propsAvailable) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('props unavailable')
      return
    }
    sendJson(res, 200, {
      total_slots: state.totalSlots,
      default_generation_settings: { n_ctx: state.window },
    })
    return
  }
  if (path === '/slots' || path === '/health') {
    state.slotsRequests++
    const slots = Array.from({ length: state.totalSlots }, (_, id) => ({
      id,
      is_processing: state.processingSlot === id,
    }))
    if (path === '/health') {
      sendJson(res, 200, { status: 'ok', slots_processing: state.processingSlot >= 0 ? 1 : 0, slots })
      return
    }
    sendJson(res, 200, slots)
    return
  }
  if (path !== '/v1/chat/completions') {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
    return
  }
  const rawBody = await readRequestBody(req)
  const body = JSON.parse(rawBody) as any
  const affinityHeader = req.headers['x-session-id']
  captures.push({ path, body, affinity: typeof affinityHeader === 'string' ? affinityHeader : null })
  if (state.mode === '5xx-once') {
    state.mode = 'reply'
    sendJson(res, 503, { error: { message: 'slot table reloaded' } })
    return
  }
  const chunk = (delta: unknown, finish: string | null = null, usage?: unknown) =>
    `data: ${JSON.stringify({ model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`
  const usage = { prompt_tokens: 20, completion_tokens: 6, prompt_tokens_details: { cached_tokens: 10 } }
  const count = body.messages.filter((row: any) => row.role === 'tool').length
  if (state.mode === 'slow-tool-stream' && count === 0) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    res.flushHeaders()
    res.write(chunk({ reasoning_content: 'planning long tool call' }))
    let tick = 0
    const totalTicks = 14
    const interval = setInterval(() => {
      if (res.writableEnded || res.destroyed) {
        clearInterval(interval)
        return
      }
      if (tick === 0) {
        res.write(
          chunk({
            tool_calls: [
              {
                index: 0,
                id: 'slow-call-0',
                type: 'function',
                function: { name: 'FixtureEcho', arguments: '{"text":"' },
              },
            ],
          }),
        )
      } else if (tick < totalTicks) {
        res.write(
          chunk({
            tool_calls: [
              {
                index: 0,
                function: { arguments: tick === totalTicks - 1 ? 'end"}' : `part-${tick}-` },
              },
            ],
          }),
        )
      } else {
        clearInterval(interval)
        res.end(chunk({}, 'tool_calls', usage) + 'data: [DONE]\n\n')
        return
      }
      tick++
    }, 250)
    res.on('close', () => clearInterval(interval))
    return
  }
  const tools = state.mode === 'tools' && count < 2
  const payload =
    chunk({ reasoning_content: `reasoning-${count}` }) +
    (tools
      ? chunk({
          tool_calls: [
            {
              index: 0,
              id: `fixture-call-${count}`,
              type: 'function',
              function: { name: 'FixtureEcho', arguments: '{"text":"hello"}' },
            },
          ],
        }) + chunk({}, 'tool_calls', usage)
      : chunk({ content: 'LLMHOST-READY' }) + chunk({}, 'stop', usage)) +
    'data: [DONE]\n\n'
  if (state.mode === 'delayed-first-token' && state.firstTokenDelayMs > 0) {
    const delayMs = state.firstTokenDelayMs
    const slot = typeof body.id_slot === 'number' ? body.id_slot : 0
    state.processingSlot = slot
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    res.flushHeaders()
    const timer = setTimeout(() => {
      state.processingSlot = -1
      if (!res.writableEnded && !res.destroyed) res.end(payload)
    }, delayMs)
    res.on('close', () => {
      state.processingSlot = -1
      clearTimeout(timer)
    })
    return
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end(payload)
})

const port = await new Promise<number>((resolvePort, rejectPort) => {
  server.once('error', rejectPort)
  server.listen(0, '127.0.0.1', () => {
    const addr = server.address()
    resolvePort(typeof addr === 'object' && addr !== null ? addr.port : 0)
  })
})

const baseUrl = `http://127.0.0.1:${port}/v1`
try {
  const { enableConfigs } = await import(`${root}/src/utils/config.ts`)
  enableConfigs()
  const { resetSettingsCache } = await import(`${root}/src/utils/settings/settingsCache.ts`)
  const { SettingsSchema } = await import(`${root}/src/utils/settings/types.ts`)
  const { routedCallModel } = await import(`${root}/src/services/providers/callModelRouter.ts`)
  const { createUserMessage } = await import(`${root}/src/utils/messages.ts`)
  const { asSystemPrompt } = await import(`${root}/src/utils/systemPromptType.ts`)
  const { processOwnerForLane } = await import(`${root}/src/services/run/resolveOwner.ts`)
  const idle = (await import(`${root}/src/services/providers/streamIdleBudget.ts`)) as Record<string, any>
  const { HOST_RECIPES } = await import(`${root}/src/services/host/recipes.ts`)

  const tool = {
    name: 'FixtureEcho',
    description: async () => 'Echo fixture',
    prompt: async () => 'Echo fixture',
    inputSchema: z.object({ text: z.string() }),
    userFacingName: () => 'FixtureEcho',
    isEnabled: () => true,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    isMcp: false,
    needsPermissions: () => false,
    async call(input: { text: string }) {
      return { data: `echoed:${input.text}` }
    },
    mapToolResultToToolResultBlockParam(result: unknown, toolUseId: string) {
      return { type: 'tool_result', tool_use_id: toolUseId, content: JSON.stringify(result) }
    },
  } as never

  function writeSettings(settings: Record<string, unknown>): void {
    assert.ok(SettingsSchema().safeParse(settings).success, 'settings must validate')
    writeFileSync(join(home, 'settings.json'), JSON.stringify(settings))
    resetSettingsCache()
  }

  async function runTurn(
    modelId: string,
    messages: any[],
    extraOptions: Record<string, unknown> = {},
    signal = new AbortController().signal,
  ): Promise<any[]> {
    const out: any[] = []
    for await (const event of routedCallModel({
      messages,
      tools: [tool],
      systemPrompt: asSystemPrompt(['Fixture system']),
      thinkingConfig: { type: 'enabled', budgetTokens: 1024 },
      signal,
      options: {
        model: modelId,
        effortValue: 'max',
        querySource: 'main_thread',
        isNonInteractiveSession: true,
        getToolPermissionContext: async () => ({}),
        agents: [],
        hasAppendSystemPrompt: false,
        mcpTools: [],
        ...extraOptions,
      },
    } as never)) {
      if (event.type === 'assistant') out.push(event)
    }
    return out
  }

  function expectedSlotFor(conversationKey: string, totalSlots: number): number {
    return createHash('sha256').update(conversationKey).digest().readUInt32BE(0) % totalSlots
  }

  const llamaId = `compat/llmhost/${model}`
  writeSettings({
    compatProvider: {
      llmhost: { baseUrl, dialect: 'llamacpp' },
      hosted: { baseUrl, dialect: 'chat-completions' },
      sglanghost: { baseUrl, dialect: 'sglang', sessionAffinityHeader: 'x-session-id' },
    },
  })

  state.mode = 'tools'
  const firstUserA = createUserMessage({ content: 'conversation A turn 0' })
  const convAKey = `${String(processOwnerForLane(null))}|${firstUserA.uuid}|${llamaId}`
  const expectedSlotA = expectedSlotFor(convAKey, 4)
  const messagesA: any[] = [firstUserA]
  const seenSlotsA: unknown[] = []
  const seenCachePromptsA: unknown[] = []
  for (let turn = 0; turn < 3; turn++) {
    const replies = await runTurn(llamaId, messagesA)
    assert.ok(replies.length > 0 && replies.every(row => !row.isApiErrorMessage), `conv A turn ${turn} settles`)
    const body = captures.at(-1)!.body
    seenSlotsA.push(body.id_slot)
    seenCachePromptsA.push(body.cache_prompt)
    if (turn > 0) {
      check(
        `llamacpp tool turn ${turn} replays prior reasoning_content`,
        body.messages.some((row: any) => row.role === 'assistant' && row.reasoning_content?.includes('reasoning-0')),
      )
    }
    messagesA.push(...replies)
    if (turn < 2) {
      messagesA.push(createUserMessage({ content: [{ type: 'tool_result', tool_use_id: `fixture-call-${turn}`, content: 'ok' }] }))
    }
  }
  check(
    'same conversation carries the same deterministic id_slot across all 3 turns',
    seenSlotsA.every(slot => slot === expectedSlotA),
    `seen=${JSON.stringify(seenSlotsA)} expected=${expectedSlotA}`,
  )
  check(
    'same conversation sends cache_prompt: true on every turn',
    seenCachePromptsA.every(flag => flag === true),
    `seen=${JSON.stringify(seenCachePromptsA)}`,
  )
  check(
    'GET /props was read once and cached for the endpoint across all 3 turns',
    state.propsRequests === 1,
    `propsRequests=${state.propsRequests}`,
  )

  state.mode = 'reply'
  const otherSlots = new Set<number>([expectedSlotA])
  let allMatchRule = true
  for (let i = 0; i < 8; i++) {
    const userB = createUserMessage({ content: `other conversation ${i}` })
    const agentId = `agent-${i}`
    const convBKey = `${String(processOwnerForLane(agentId))}|${userB.uuid}|${llamaId}`
    const expectedB = expectedSlotFor(convBKey, 4)
    const replies = await runTurn(llamaId, [userB], { agentId })
    assert.ok(replies.every(row => !row.isApiErrorMessage))
    const body = captures.at(-1)!.body
    if (body.id_slot !== expectedB || body.cache_prompt !== true) allMatchRule = false
    if (typeof body.id_slot === 'number') otherSlots.add(body.id_slot)
  }
  check(
    'different conversations derive id_slot deterministically by the same rule and span multiple slots',
    allMatchRule && otherSlots.size > 1,
    `allMatchRule=${allMatchRule} distinctSlots=${JSON.stringify([...otherSlots])}`,
  )
  check(
    'GET /props stayed cached across the other conversations on the same endpoint',
    state.propsRequests === 1,
    `propsRequests=${state.propsRequests}`,
  )

  state.totalSlots = 7
  state.mode = '5xx-once'
  const userAfter5xx = createUserMessage({ content: 'after 5xx reload' })
  const keyAfter5xx = `${String(processOwnerForLane('agent-5xx'))}|${userAfter5xx.uuid}|${llamaId}`
  const expectedSlot7 = expectedSlotFor(keyAfter5xx, 7)
  const repliesAfter5xx = await runTurn(llamaId, [userAfter5xx], { agentId: 'agent-5xx' })
  check(
    'a 5xx response invalidates the cached slot count, re-reads GET /props, and applies the new total_slots on retry',
    repliesAfter5xx.some(row => !row.isApiErrorMessage) &&
      state.propsRequests === 2 &&
      captures.at(-1)!.body.id_slot === expectedSlot7 &&
      captures.at(-1)!.body.cache_prompt === true,
    `propsRequests=${state.propsRequests} id_slot=${captures.at(-1)!.body.id_slot} expected=${expectedSlot7}`,
  )

  state.propsAvailable = false
  state.mode = '5xx-once'
  const userNoProps = createUserMessage({ content: 'props unavailable turn' })
  const repliesNoProps = await runTurn(llamaId, [userNoProps], { agentId: 'agent-no-props' })
  const noPropsBody = captures.at(-1)!.body
  check(
    '/props unavailable sends neither id_slot nor cache_prompt',
    repliesNoProps.some(row => !row.isApiErrorMessage) &&
      noPropsBody.id_slot === undefined &&
      noPropsBody.cache_prompt === undefined,
    `id_slot=${noPropsBody.id_slot} cache_prompt=${noPropsBody.cache_prompt}`,
  )
  state.propsAvailable = true
  state.totalSlots = 4
  state.mode = '5xx-once'
  await runTurn(llamaId, [createUserMessage({ content: 'restore props cache' })])

  process.env.MERCURY_SILENT_AFTER_HEADERS_MS = '300'
  try {
    state.mode = 'delayed-first-token'
    state.firstTokenDelayMs = 450
    const warmHistory = [
      createUserMessage({ content: 'turn 1' }),
      ...repliesAfter5xx.map(row => ({ ...row, message: { ...row.message, model: llamaId } })),
      createUserMessage({ content: 'turn 2 with 85k prefill' }),
    ]
    const survived = await runTurn(llamaId, warmHistory, { querySource: 'overload_probe' })
    check(
      'llamacpp survives a 45 s (scaled) prefill silence after headers while hosted routes carry the 30 s fence',
      survived.length > 0 &&
        survived.every(row => !row.isApiErrorMessage) &&
        idle.silentAfterHeadersMsForRoute('openai-compat', 'llamacpp') === null,
      `errors=${JSON.stringify(survived.filter(r => r.isApiErrorMessage).map(r => r.message?.content))}`,
    )

    const hostedId = `compat/hosted/${model}`
    const warmHostedHistory = [
      createUserMessage({ content: 'hosted turn 1' }),
      ...repliesAfter5xx.map(row => ({ ...row, message: { ...row.message, model: hostedId } })),
      createUserMessage({ content: 'hosted turn 2 silent after headers' }),
    ]
    const cutHosted = await runTurn(hostedId, warmHostedHistory, { querySource: 'overload_probe' })
    check(
      'hosted-vendor compat route keeps the 30 s (scaled) silent-after-headers fence',
      cutHosted.some(row => row.isApiErrorMessage && row.errorDetails === 'silent-after-headers') &&
        idle.silentAfterHeadersMsForRoute('openai-compat', 'chat-completions') === 300,
      `hosted=${JSON.stringify(cutHosted.map(r => ({ err: r.isApiErrorMessage, details: r.errorDetails })))}`,
    )
  } finally {
    delete process.env.MERCURY_SILENT_AFTER_HEADERS_MS
  }

  writeSettings({
    patience: { streamIdleSeconds: 1800, quietStreamIdleSeconds: 900 },
    compatProvider: {
      llmhost: { baseUrl, dialect: 'llamacpp' },
      hosted: { baseUrl, dialect: 'chat-completions' },
      sglanghost: { baseUrl, dialect: 'sglang', sessionAffinityHeader: 'x-session-id' },
    },
  })
  check(
    'self-hosted compat dialect budget is never shorter than streamIdleMs',
    idle.streamIdleTimeoutMsForRoute('openai-compat', 'llamacpp') === 1_800_000,
    `idleMs=${idle.streamIdleTimeoutMsForRoute('openai-compat', 'llamacpp')}`,
  )

  writeSettings({
    patience: { streamIdleSeconds: 1, quietStreamIdleSeconds: 3 },
    compatProvider: {
      llmhost: { baseUrl, dialect: 'llamacpp' },
      hosted: { baseUrl, dialect: 'chat-completions' },
      sglanghost: { baseUrl, dialect: 'sglang', sessionAffinityHeader: 'x-session-id' },
    },
  })
  state.mode = 'delayed-first-token'
  state.firstTokenDelayMs = 1_400
  const quietReplies = await runTurn(llamaId, [createUserMessage({ content: 'prefill past streaming idle budget' })], {
    querySource: 'overload_probe',
  })
  check(
    'first token arriving after streaming idle budget (1 s) but inside quiet-road budget (3 s) is not cut off on llamacpp',
    quietReplies.length > 0 &&
      quietReplies.every(row => !row.isApiErrorMessage) &&
      idle.streamIdleTimeoutMsForRoute('openai-compat', 'llamacpp') === 3_000,
    `idleMs=${idle.streamIdleTimeoutMsForRoute('openai-compat', 'llamacpp')} replies=${JSON.stringify(quietReplies.map(r => r.isApiErrorMessage))}`,
  )

  process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS = '1000'
  try {
    const slotsBefore = state.slotsRequests
    state.mode = 'delayed-first-token'
    state.firstTokenDelayMs = 1_450
    const slotAliveReplies = await runTurn(llamaId, [createUserMessage({ content: 'prefill guarded by /slots is_processing' })], {
      querySource: 'overload_probe',
    })
    check(
      'llamacpp counts the request as alive when the idle deadline fires while /slots reports the pinned slot is_processing',
      slotAliveReplies.length > 0 &&
        slotAliveReplies.every(row => !row.isApiErrorMessage) &&
        state.slotsRequests > slotsBefore,
      `slotsRequestsDelta=${state.slotsRequests - slotsBefore} errors=${JSON.stringify(slotAliveReplies.filter(r => r.isApiErrorMessage))}`,
    )
  } finally {
    delete process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS
    state.firstTokenDelayMs = 0
    state.mode = 'reply'
  }

  const sglangId = `compat/sglanghost/${model}`
  const sglangReplies = await runTurn(sglangId, [createUserMessage({ content: 'sglang affinity check' })])
  const sglangCapture = captures.at(-1)!
  check(
    'the SGLang road keeps its sessionAffinityHeader and clear_thinking: false without id_slot',
    sglangReplies.every(row => !row.isApiErrorMessage) &&
      typeof sglangCapture.affinity === 'string' &&
      sglangCapture.affinity.length > 0 &&
      sglangCapture.body.chat_template_kwargs?.clear_thinking === false &&
      sglangCapture.body.id_slot === undefined,
    `affinity=${sglangCapture.affinity} id_slot=${sglangCapture.body.id_slot}`,
  )

  const fastRow = HOST_RECIPES.find((row: any) => row.id === 'glm53-flash-b200-community')
  check(
    'HOST_RECIPES glm53-flash-b200-community verification names SGLang prefill in thousands of tokens/s vs llama.cpp on 1 GPU and not measured',
    fastRow !== undefined &&
      fastRow.verification.includes('community recipe') &&
      /thousands of tok(?:ens)?\/s/i.test(fastRow.verification) &&
      /llama\.cpp/i.test(fastRow.verification) &&
      /not measured/i.test(fastRow.verification),
    `verification=${fastRow?.verification ?? 'missing'}`,
  )

  const { compatChatCallModel } = await import(`${root}/src/services/providers/openaicompat/compatChatCallModel.ts`)
  const { compatSlotLaneProfile } = await import(`${root}/src/services/providers/openaicompat/compatCallModel.ts`)
  async function scripted(attempts: any[][]): Promise<{ events: any[]; assistants: any[]; calls: number }> {
    let calls = 0
    const profile = {
      ...compatSlotLaneProfile,
      resolveCredential: () => ({}),
      requestUrl: () => `${baseUrl}/chat/completions`,
      streamTransport: () => {
        const script = attempts[Math.min(calls, attempts.length - 1)]!
        calls++
        return {
          events: (async function* () {
            for (const event of script) yield event
          })(),
        }
      },
    }
    const events: any[] = []
    const assistants: any[] = []
    for await (const item of compatChatCallModel(profile as never, {
      messages: [createUserMessage({ content: 'scripted stream' })],
      tools: [tool],
      systemPrompt: asSystemPrompt(['Fixture system']),
      thinkingConfig: { type: 'enabled', budgetTokens: 1024 },
      signal: new AbortController().signal,
      options: {
        model: `compat/hosted/${model}`,
        effortValue: 'max',
        querySource: 'main_thread',
        isNonInteractiveSession: true,
        getToolPermissionContext: async () => ({}),
        agents: [],
        hasAppendSystemPrompt: false,
        mcpTools: [],
      },
    } as never) as AsyncGenerator<any>) {
      if (item.type === 'stream_event') events.push(item.event)
      else if (item.type === 'assistant') assistants.push(item)
    }
    return { events, assistants, calls }
  }
  const blockStarts = (events: any[]) => events.filter(event => event.type === 'content_block_start')
  const toolStartsFor = (events: any[], id: string) => blockStarts(events).filter(event => event.content_block?.type === 'tool_use' && event.content_block.id === id)
  const paintedFor = (events: any[], id: string): string => {
    const indices = new Set(toolStartsFor(events, id).map(event => event.index))
    return events
      .filter(event => event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta' && indices.has(event.index))
      .map(event => event.delta.partial_json)
      .join('')
  }
  const streamOrder = (events: any[]): string => [...blockStarts(events)].sort((a, b) => a.index - b.index).map(event => event.content_block.type).join(',')
  const settledOrder = (assistants: any[]): string => assistants.filter(row => !row.isApiErrorMessage).map(row => row.message.content[0]?.type).join(',')
  const settledCall = (index: number, id: string, argumentsRaw: string, name = 'FixtureEcho') => ({ index, id, name, argumentsRaw, malformed: false })
  const finishWith = (...toolCalls: any[]) => ({ type: 'finish', reason: 'tool_calls', rawReason: 'tool_calls', toolCalls })

  const responsesShape = await scripted([[
    { type: 'tool-call-fragment', index: 0, id: 'call-r', name: 'FixtureEcho', argumentsFragment: '' },
    { type: 'tool-call-fragment', index: 0, argumentsFragment: '{"te' },
    { type: 'tool-call-fragment', index: 0, argumentsFragment: 'xt":"hi' },
    { type: 'tool-call-fragment', index: 0, argumentsFragment: '"}' },
    finishWith(settledCall(0, 'call-r', '{"text":"hi"}')),
  ]])
  check(
    'Responses-road fragments (id and name on the first only) paint one live block: one start, the arguments shown once as they stream, one tool_use settled',
    toolStartsFor(responsesShape.events, 'call-r').length === 1 &&
      paintedFor(responsesShape.events, 'call-r') === '{"text":"hi"}' &&
      responsesShape.events.filter(event => event.delta?.type === 'input_json_delta').length === 3 &&
      settledOrder(responsesShape.assistants) === 'tool_use' &&
      responsesShape.assistants[0]?.message.content[0]?.input?.text === 'hi',
    `starts=${toolStartsFor(responsesShape.events, 'call-r').length} painted=${paintedFor(responsesShape.events, 'call-r')} settled=${settledOrder(responsesShape.assistants)} errors=${JSON.stringify(responsesShape.assistants.filter(row => row.isApiErrorMessage).map(row => row.message?.content))}`,
  )

  const interleaved = await scripted([[
    { type: 'tool-call-fragment', index: 0, id: 'call-a', name: 'FixtureEcho', argumentsFragment: '{"text":' },
    { type: 'tool-call-fragment', index: 1, id: 'call-b', name: 'FixtureEcho', argumentsFragment: '{"text":"b"}' },
    { type: 'tool-call-fragment', index: 0, id: 'call-a', name: 'FixtureEcho', argumentsFragment: '"a"}' },
    finishWith(settledCall(0, 'call-a', '{"text":"a"}'), settledCall(1, 'call-b', '{"text":"b"}')),
  ]])
  check(
    'interleaved fragments never reopen or replay a call: one start per call, no argument byte shown twice, both calls settle in stream order',
    toolStartsFor(interleaved.events, 'call-a').length === 1 &&
      toolStartsFor(interleaved.events, 'call-b').length === 1 &&
      '{"text":"a"}'.startsWith(paintedFor(interleaved.events, 'call-a')) &&
      paintedFor(interleaved.events, 'call-b') === '{"text":"b"}' &&
      settledOrder(interleaved.assistants) === 'tool_use,tool_use' &&
      interleaved.assistants.map(row => row.message.content[0]?.input?.text).join() === 'a,b',
    `starts=${blockStarts(interleaved.events).length} a=${paintedFor(interleaved.events, 'call-a')} b=${paintedFor(interleaved.events, 'call-b')}`,
  )

  const doneCarried = await scripted([[
    { type: 'tool-call-fragment', index: 0, id: 'call-t', name: 'FixtureEcho', argumentsFragment: '' },
    finishWith(settledCall(0, 'call-t', '{"text":"tail"}')),
  ]])
  check(
    'arguments the stream never painted are painted once into the still-open block at settlement, never as a second block',
    toolStartsFor(doneCarried.events, 'call-t').length === 1 && paintedFor(doneCarried.events, 'call-t') === '{"text":"tail"}' && settledOrder(doneCarried.assistants) === 'tool_use',
    `starts=${toolStartsFor(doneCarried.events, 'call-t').length} painted=${paintedFor(doneCarried.events, 'call-t')}`,
  )

  const ordered = await scripted([[
    { type: 'reasoning-delta', text: 'thinking first' },
    { type: 'tool-call-fragment', index: 0, id: 'call-o', name: 'FixtureEcho', argumentsFragment: '{"text":"o"}' },
    { type: 'text-delta', text: 'words after the call' },
    finishWith(settledCall(0, 'call-o', '{"text":"o"}')),
  ]])
  check(
    'text after a live tool block settles after it: the settled messages keep the streamed block order, block for block',
    streamOrder(ordered.events) === 'thinking,tool_use,text' && settledOrder(ordered.assistants) === 'thinking,tool_use,text',
    `stream=${streamOrder(ordered.events)} settled=${settledOrder(ordered.assistants)}`,
  )

  const refusedPaint = await scripted([[
    { type: 'tool-call-fragment', index: 0, id: 'call-x', name: 'NoSuchTool', argumentsFragment: '{"text":"x"}' },
    finishWith(settledCall(0, 'call-x', '{"text":"x"}', 'NoSuchTool')),
  ]])
  check(
    'a painted call the gate refuses settles its refusal note in the painted block\'s place: one block streamed, one message settled, nothing replayed',
    blockStarts(refusedPaint.events).length === 1 &&
      toolStartsFor(refusedPaint.events, 'call-x').length === 1 &&
      refusedPaint.assistants.length === 1 &&
      refusedPaint.assistants[0]?.message.content[0]?.type === 'text' &&
      refusedPaint.assistants[0]?.refusedToolCalls?.[0]?.id === 'call-x',
    `starts=${streamOrder(refusedPaint.events)} settled=${settledOrder(refusedPaint.assistants)}`,
  )

  const paintCut = await scripted([
    [
      { type: 'tool-call-fragment', index: 0, id: 'call-p', name: 'FixtureEcho', argumentsFragment: '{"text":"par' },
      { type: 'stream-fault', fault: { kind: 'timeout', code: 'idle-timeout', message: 'the stream went quiet mid-arguments', retryable: true } },
    ],
    [
      { type: 'tool-call-fragment', index: 0, id: 'call-p2', name: 'FixtureEcho', argumentsFragment: '{"text":"full"}' },
      finishWith(settledCall(0, 'call-p2', '{"text":"full"}')),
    ],
  ])
  check(
    'a stream cut while only tool arguments were painting keeps the clean retry: the request goes again and the call settles once, no error row',
    paintCut.calls === 2 &&
      paintCut.assistants.every(row => !row.isApiErrorMessage) &&
      settledOrder(paintCut.assistants) === 'tool_use' &&
      paintCut.assistants[0]?.message.content[0]?.input?.text === 'full',
    `calls=${paintCut.calls} settled=${settledOrder(paintCut.assistants)} errors=${paintCut.assistants.filter(row => row.isApiErrorMessage).length}`,
  )

  await import(`${root}/src/tasks.ts`)
  const { runAgent } = await import(`${root}/src/tools/AgentTool/runAgent.ts`)
  const { getDefaultAppState } = await import(`${root}/src/state/AppStateStore.ts`)
  const { createFileStateCacheWithSizeLimit } = await import(`${root}/src/utils/fileStateCache.ts`)
  const { runWithCwdOverride } = await import(`${root}/src/utils/cwd.ts`)
  process.env.MERCURY_AGENT_IDLE_MINUTES = '0.03'
  try {
    state.mode = 'slow-tool-stream'
    let appState = { ...getDefaultAppState(), effortValue: 'max' }
    const owner = new AbortController()
    const context = {
      abortController: owner,
      options: {
        commands: [],
        tools: [tool],
        engineModel: llamaId,
        thinkingConfig: { type: 'enabled', budgetTokens: 1024 },
        mcpClients: [],
        mcpResources: {},
        isNonInteractiveSession: true,
        debug: false,
        verbose: false,
        agentDefinitions: { activeAgents: [], allAgents: [] },
      },
      getAppState: () => appState,
      setAppState: (update: any) => {
        appState = typeof update === 'function' ? update(appState) : update
      },
      setAppStateForTasks: (update: any) => {
        appState = typeof update === 'function' ? update(appState) : update
      },
      messages: [],
      readFileState: createFileStateCacheWithSizeLimit(100),
      setInProgressToolUseIDs: () => {},
      setResponseLength: () => {},
      updateFileHistoryState: () => {},
      updateAttributionState: () => {},
    }
    const progressEvents: any[] = []
    const agentRows: any[] = []
    let agentError = ''
    await runWithCwdOverride(home, async () => {
      try {
        for await (const row of runAgent({
          agentDefinition: {
            agentType: 'slow-tool-fixture',
            source: 'projectSettings',
            getSystemPrompt: () => 'Run the slow tool call.',
          } as never,
          promptMessages: [createUserMessage({ content: 'stream a slow tool call' })],
          toolUseContext: context as never,
          canUseTool: (async (_tool: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input })) as never,
          isAsync: false,
          querySource: 'agent:custom',
          availableTools: [tool],
          model: llamaId,
          effortOverride: 'max',
          onQueryProgress: (ev: any) => progressEvents.push(ev),
          override: {
            agentId: 'slow-tool-crewmate' as never,
            userContext: {},
            systemContext: {},
            systemPrompt: ['Run the slow tool call.'],
          },
        })) {
          agentRows.push(row)
        }
      } catch (caught) {
        agentError = String(caught)
      }
    })
    const streamActivities = progressEvents.filter(ev => ev?.type === 'stream_activity')
    const inputJsonDeltas = progressEvents
      .filter(ev => ev?.type === 'stream_event' && ev.event?.type === 'content_block_delta' && ev.event.delta?.type === 'input_json_delta')
      .map(ev => ev.event.delta.partial_json as string)
    const expectedJson = '{"text":"' + Array.from({ length: 12 }, (_, i) => `part-${i + 1}-`).join('') + 'end"}'
    const finalText = agentRows
      .filter(row => row.type === 'assistant')
      .flatMap(row => row.message?.content ?? [])
      .map((block: any) => block.text ?? '')
      .join('')
    check(
      'crewmate survives a 3.5 s streaming tool call past the 1.8 s MERCURY_AGENT_IDLE_MINUTES limit and finishes',
      agentError === '' && finalText.includes('LLMHOST-READY'),
      `agentError=${agentError} finalText=${finalText}`,
    )
    check(
      'stream_activity and progressive input_json_delta events are observed during the tool call without double-counting at settlement',
      streamActivities.length > 0 && inputJsonDeltas.length === 14 && inputJsonDeltas.join('') === expectedJson,
      `streamActivities=${streamActivities.length} deltas=${inputJsonDeltas.length} joined=${inputJsonDeltas.join('')}`,
    )
  } finally {
    delete process.env.MERCURY_AGENT_IDLE_MINUTES
    state.mode = 'reply'
  }

  console.log(`prove-llmhost-slots: ${checks} checks, ${failures} failures`)
  if (failures > 0) process.exitCode = 1
} finally {
  server.close()
  rmSync(home, { recursive: true, force: true })
}
