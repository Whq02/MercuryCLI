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
  healthRequests: 0,
  processingSlot: -1,
  firstTokenDelayMs: 0,
  slotsHang: false,
  slotsMissing: false,
  mode: 'reply' as 'reply' | 'tools' | '5xx-once' | 'delayed-first-token' | 'slow-tool-stream' | 'silent-after-headers' | 'no-headers',
}
const heldResponses = new Set<ServerResponse>()
const model = 'Fixture/GLM-5.3-Flash-GGUF'
const SLOW_TOOL_TICK_MS = 650
const SLOW_TOOL_TICKS = 15
const SLOW_TOOL_STREAM_S = (SLOW_TOOL_TICK_MS * SLOW_TOOL_TICKS) / 1000
const SLOW_TOOL_IDLE_MINUTES = '0.1'
const SLOW_TOOL_IDLE_S = Number(SLOW_TOOL_IDLE_MINUTES) * 60

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
  if (path === '/health') {
    state.healthRequests++
    sendJson(res, 200, { status: 'ok' })
    return
  }
  if (path === '/slots') {
    state.slotsRequests++
    if (state.slotsHang) {
      heldResponses.add(res)
      return
    }
    if (state.slotsMissing) {
      sendJson(res, 404, { error: { code: 404, message: 'File Not Found', type: 'not_found_error' } })
      return
    }
    sendJson(res, 200, Array.from({ length: state.totalSlots }, (_, id) => ({ id, is_processing: state.processingSlot === id })))
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
  if (state.mode === 'silent-after-headers') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    res.flushHeaders()
    heldResponses.add(res)
    return
  }
  if (state.mode === 'no-headers') {
    heldResponses.add(res)
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
    }, SLOW_TOOL_TICK_MS)
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

const vllm = { mode: 'delayed-reply' as 'delayed-reply' | 'stop-listening', delayMs: 0, healthRequests: 0 }
const vllmServer = createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
  if (path === '/health') {
    vllm.healthRequests++
    res.writeHead(200)
    res.end()
    return
  }
  if (path !== '/v1/chat/completions') {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
    return
  }
  const body = JSON.parse(await readRequestBody(req)) as any
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  res.flushHeaders()
  if (vllm.mode === 'stop-listening') {
    heldResponses.add(res)
    vllmServer.close()
    return
  }
  const vllmChunk = (delta: unknown, finish: string | null = null) =>
    `data: ${JSON.stringify({ model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  const timer = setTimeout(() => {
    if (!res.writableEnded && !res.destroyed) res.end(vllmChunk({ content: 'VLLM-READY' }) + vllmChunk({}, 'stop') + 'data: [DONE]\n\n')
  }, vllm.delayMs)
  res.on('close', () => clearTimeout(timer))
})
const vllmPort = await new Promise<number>((resolvePort, rejectPort) => {
  vllmServer.once('error', rejectPort)
  vllmServer.listen(0, '127.0.0.1', () => {
    const addr = vllmServer.address()
    resolvePort(typeof addr === 'object' && addr !== null ? addr.port : 0)
  })
})
const vllmBaseUrl = `http://127.0.0.1:${vllmPort}/v1`
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

  function preferredSlotFor(sessionOwner: string, totalSlots: number): number {
    return createHash('sha256').update(sessionOwner).digest().readUInt32BE(0) % totalSlots
  }

  const llamaId = `compat/llmhost/${model}`
  const llmoldId = `compat/llmold/${model}`
  const endpoints = {
    llmhost: { baseUrl, dialect: 'llamacpp' },
    llmold: { baseUrl, dialect: 'llamacpp' },
    hosted: { baseUrl, dialect: 'chat-completions' },
    sglanghost: { baseUrl, dialect: 'sglang', sessionAffinityHeader: 'x-session-id' },
    vllmhost: { baseUrl: vllmBaseUrl, dialect: 'vllm' },
  }
  writeSettings({ compatProvider: endpoints })
  const vllmId = `compat/vllmhost/${model}`
  const serverWords = `the llama.cpp server at http://127.0.0.1:${port}`
  const errorText = (rows: any[]): string => rows.filter(row => row.isApiErrorMessage).map(row => JSON.stringify(row.message?.content ?? '')).join(' ')

  state.mode = 'tools'
  const firstUserA = createUserMessage({ content: 'conversation A turn 0' })
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
  const mainSlot = seenSlotsA[0] as number
  check(
    'same conversation keeps one registry-assigned id_slot across all 3 turns',
    Number.isInteger(mainSlot) && mainSlot >= 0 && mainSlot < 4 && seenSlotsA.every(slot => slot === mainSlot),
    `seen=${JSON.stringify(seenSlotsA)} main=${mainSlot}`,
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
  let collider: { user: any; agentId: string } | undefined
  for (let i = 0; i < 256 && collider === undefined; i++) {
    const user = createUserMessage({ content: `crewmate preferring the main slot ${i}` })
    const agentId = `agent-collide-${i}`
    if (preferredSlotFor(String(processOwnerForLane(agentId)), 4) === mainSlot) collider = { user, agentId }
  }
  const colliderReplies = collider === undefined ? [] : await runTurn(llamaId, [collider.user], { agentId: collider.agentId })
  const colliderSlot = captures.at(-1)!.body.id_slot
  check(
    'a new crewmate whose registry owner prefers its parent\'s slot takes a free slot instead',
    collider !== undefined &&
      colliderReplies.length > 0 && colliderReplies.every(row => !row.isApiErrorMessage) &&
      Number.isInteger(colliderSlot) &&
      colliderSlot >= 0 && colliderSlot !== mainSlot &&
      colliderSlot < 4 && captures.at(-1)!.body.cache_prompt === true,
    `main=${mainSlot} collider=${colliderSlot}`,
  )
  const crewSlots: number[] = []
  let crewCachePrompt = true
  let balancedOverflow = true
  const occupants = new Map<number, number>([[mainSlot, 1], [colliderSlot, 1]])
  for (let i = 0; i < 8; i++) {
    const userB = createUserMessage({ content: `other conversation ${i}` })
    const replies = await runTurn(llamaId, [userB], { agentId: `agent-${i}` })
    assert.ok(replies.length > 0 && replies.every(row => !row.isApiErrorMessage))
    const body = captures.at(-1)!.body
    if (typeof body.id_slot === 'number') {
      crewSlots.push(body.id_slot)
      if (i >= 2 && occupants.get(body.id_slot) !== Math.min(...occupants.values())) balancedOverflow = false
      occupants.set(body.id_slot, (occupants.get(body.id_slot) ?? 0) + 1)
    }
    if (body.cache_prompt !== true) crewCachePrompt = false
  }
  check(
    'crewmates fill free slots without taking the main slot; once all four are held, overflow balances within the existing capacity',
    crewSlots.length === 8 &&
      crewCachePrompt && balancedOverflow &&
      new Set([mainSlot, colliderSlot, ...crewSlots.slice(0, 2)]).size === 4 &&
      crewSlots.every(slot => Number.isInteger(slot) && slot >= 0 && slot < 4),
    `main=${mainSlot} collider=${colliderSlot} crew=${JSON.stringify(crewSlots)}`,
  )
  messagesA.push(createUserMessage({ content: 'the main conversation after its crewmates' }))
  const againA = await runTurn(llamaId, messagesA)
  check(
    'the main conversation keeps its slot after nine crewmates came and went',
    againA.every(row => !row.isApiErrorMessage) && captures.at(-1)!.body.id_slot === mainSlot,
    `main=${mainSlot} seen=${captures.at(-1)!.body.id_slot}`,
  )
  check(
    'GET /props stayed cached across the other conversations on the same endpoint',
    state.propsRequests === 1,
    `propsRequests=${state.propsRequests}`,
  )

  state.totalSlots = 7
  state.mode = '5xx-once'
  const before5xx = captures.length
  const userAfter5xx = createUserMessage({ content: 'after 5xx reload' })
  const repliesAfter5xx = await runTurn(llamaId, [userAfter5xx], { agentId: 'agent-5xx' })
  const retryBody = captures.at(-1)!.body
  const retryCaptures = captures.slice(before5xx)
  const wideReplies = await runTurn(llamaId, [createUserMessage({ content: 'a conversation for the grown slot table' })], { agentId: 'agent-wide' })
  const wideBody = captures.at(-1)!.body
  check(
    'a 5xx response invalidates the cached slot count, re-reads GET /props, and the new total_slots is applied',
    repliesAfter5xx.some(row => !row.isApiErrorMessage) &&
      state.propsRequests === 2 &&
      retryCaptures.length === 2 &&
      Number.isInteger(retryBody.id_slot) && retryBody.id_slot >= 0 &&
      retryBody.id_slot < 7 &&
      retryBody.id_slot === retryCaptures[0]!.body.id_slot &&
      retryBody.cache_prompt === true &&
      wideReplies.every(row => !row.isApiErrorMessage) &&
      Number.isInteger(wideBody.id_slot) && wideBody.id_slot >= 4 && wideBody.id_slot < 7,
    `propsRequests=${state.propsRequests} requests=${retryCaptures.length} retry=${retryBody.id_slot} wide=${wideBody.id_slot}`,
  )

  state.propsAvailable = false
  state.mode = '5xx-once'
  const userNoProps = createUserMessage({ content: 'props unavailable turn' })
  const repliesNoProps = await runTurn(llamaId, [userNoProps], { agentId: 'agent-no-props' })
  const noPropsBody = captures.at(-1)!.body
  check(
    '/props unavailable sends no id_slot and keeps cache_prompt on',
    repliesNoProps.some(row => !row.isApiErrorMessage) &&
      noPropsBody.id_slot === undefined &&
      noPropsBody.cache_prompt === true,
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
    const hostedBody = captures.at(-1)!.body
    check(
      'hosted-vendor compat route keeps the 30 s (scaled) silent-after-headers fence and sends neither id_slot nor cache_prompt',
      cutHosted.some(row => row.isApiErrorMessage && row.errorDetails === 'silent-after-headers') &&
        idle.silentAfterHeadersMsForRoute('openai-compat', 'chat-completions') === 300 &&
        hostedBody.id_slot === undefined &&
        hostedBody.cache_prompt === undefined,
      `hosted=${JSON.stringify(cutHosted.map(r => ({ err: r.isApiErrorMessage, details: r.errorDetails })))} id_slot=${hostedBody.id_slot} cache_prompt=${hostedBody.cache_prompt}`,
    )
  } finally {
    delete process.env.MERCURY_SILENT_AFTER_HEADERS_MS
  }

  writeSettings({ patience: { streamIdleSeconds: 1800, quietStreamIdleSeconds: 900 }, compatProvider: endpoints })
  check(
    'self-hosted compat dialect budget is never shorter than streamIdleMs',
    idle.streamIdleTimeoutMsForRoute('openai-compat', 'llamacpp') === 1_800_000,
    `idleMs=${idle.streamIdleTimeoutMsForRoute('openai-compat', 'llamacpp')}`,
  )

  writeSettings({ patience: { streamIdleSeconds: 1, quietStreamIdleSeconds: 3 }, compatProvider: endpoints })
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

  process.env.MERCURY_SILENT_AFTER_HEADERS_MS = '400'
  try {
    const fenceMs = 400
    state.mode = 'silent-after-headers'
    state.processingSlot = -1
    const idleFenceStarted = Date.now()
    const idleFence = await runTurn(llamaId, [createUserMessage({ content: 'headers, then nothing, on an idle slot' })], { querySource: 'overload_probe' })
    const idleFenceElapsed = Date.now() - idleFenceStarted
    check(
      'headers then silence on an idle pinned slot is cut at the fence time, not at the 3 s idle budget, the words naming the slot',
      idleFence.some(row => row.isApiErrorMessage && row.errorDetails === 'silent-after-headers') &&
        errorText(idleFence).includes(serverWords) &&
        /reports slot \d+ idle/.test(errorText(idleFence)) &&
        idleFenceElapsed < 2_000,
      `elapsedMs=${idleFenceElapsed} rows=${JSON.stringify(idleFence.map(r => r.errorDetails ?? 'reply'))} text=${errorText(idleFence).slice(0, 300)}`,
    )

    state.mode = 'delayed-first-token'
    state.firstTokenDelayMs = 2 * fenceMs + 100
    const slotsBeforeWorking = state.slotsRequests
    const working = await runTurn(llamaId, [createUserMessage({ content: 'headers, then a long prefill on a busy slot' })], { querySource: 'overload_probe' })
    check(
      'headers then silence while the pinned slot reports processing is never cut: /slots is read at each fence and the stream completes after twice the fence',
      working.length > 0 && working.every(row => !row.isApiErrorMessage) && state.slotsRequests - slotsBeforeWorking >= 2,
      `slotsDelta=${state.slotsRequests - slotsBeforeWorking} errors=${errorText(working).slice(0, 300)}`,
    )

    state.mode = 'silent-after-headers'
    state.slotsMissing = true
    const missingStarted = Date.now()
    const missing = await runTurn(llamaId, [createUserMessage({ content: 'headers, then nothing, on a server without /slots' })], { querySource: 'overload_probe' })
    const missingElapsed = Date.now() - missingStarted
    state.slotsMissing = false
    check(
      'a server whose /slots answers 404 is never cut at the fence: the cut lands at the 3 s idle budget and says the server does not report slots',
      missing.some(row => row.isApiErrorMessage && row.errorDetails === 'idle-timeout') &&
        errorText(missing).includes(`${serverWords} does not report slots (GET /slots answered HTTP 404)`) &&
        missingElapsed >= 2_800 &&
        missingElapsed < 6_000,
      `elapsedMs=${missingElapsed} rows=${JSON.stringify(missing.map(r => r.errorDetails ?? 'reply'))} text=${errorText(missing).slice(0, 300)}`,
    )

    vllm.mode = 'delayed-reply'
    vllm.delayMs = 2 * fenceMs + 100
    const healthBefore = vllm.healthRequests
    const vllmWorking = await runTurn(vllmId, [createUserMessage({ content: 'headers, then a long prefill on vLLM' })], { querySource: 'overload_probe' })
    check(
      'a vLLM stream silent after its headers while /health answers is not cut at the fence and completes',
      vllmWorking.length > 0 && vllmWorking.every(row => !row.isApiErrorMessage) && vllm.healthRequests - healthBefore >= 1,
      `healthDelta=${vllm.healthRequests - healthBefore} errors=${errorText(vllmWorking).slice(0, 300)}`,
    )

    vllm.mode = 'stop-listening'
    const refusedStarted = Date.now()
    const vllmRefused = await runTurn(vllmId, [createUserMessage({ content: 'headers, then the vLLM process goes away' })], { querySource: 'overload_probe' })
    const refusedElapsed = Date.now() - refusedStarted
    check(
      'a vLLM server that refuses the connection for /health is cut at the fence time, the words naming the server',
      vllmRefused.some(row => row.isApiErrorMessage && row.errorDetails === 'silent-after-headers') &&
        errorText(vllmRefused).includes(`the vLLM server at http://127.0.0.1:${vllmPort} could not be reached for GET /health (connection refused)`) &&
        refusedElapsed < 2_000,
      `elapsedMs=${refusedElapsed} rows=${JSON.stringify(vllmRefused.map(r => r.errorDetails ?? 'reply'))} text=${errorText(vllmRefused).slice(0, 300)}`,
    )
  } finally {
    delete process.env.MERCURY_SILENT_AFTER_HEADERS_MS
    state.slotsMissing = false
    state.firstTokenDelayMs = 0
    state.mode = 'reply'
  }
  process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS = '1000'
  try {
    const slotsBefore = state.slotsRequests
    state.mode = 'delayed-first-token'
    state.firstTokenDelayMs = 1_450
    const slotTicks: number[] = []
    const slotAliveReplies = await runTurn(llamaId, [createUserMessage({ content: 'prefill guarded by /slots is_processing' })], {
      querySource: 'overload_probe',
      onStreamActivity: (atMs: number) => slotTicks.push(atMs),
    })
    check(
      'llamacpp counts the request as alive when the idle deadline fires while /slots reports the pinned slot is_processing',
      slotAliveReplies.length > 0 &&
        slotAliveReplies.every(row => !row.isApiErrorMessage) &&
        state.slotsRequests > slotsBefore,
      `slotsRequestsDelta=${state.slotsRequests - slotsBefore} errors=${JSON.stringify(slotAliveReplies.filter(r => r.isApiErrorMessage))}`,
    )
    check(
      'a slot that reports is_processing is heard by the crewmate watchdog: every working reading ticks onStreamActivity, so a long prefill is never read as crewmate silence',
      slotTicks.length >= 1 && slotTicks.length >= state.slotsRequests - slotsBefore,
      `ticks=${slotTicks.length} slotsRequestsDelta=${state.slotsRequests - slotsBefore}`,
    )

    state.propsAvailable = false
    const unpinnedSlotsBefore = state.slotsRequests
    state.firstTokenDelayMs = 1_450
    const unpinned = await runTurn(llmoldId, [createUserMessage({ content: 'an older llama.cpp whose /props names no total_slots' })], {
      querySource: 'overload_probe',
    })
    const unpinnedBody = captures.at(-1)!.body
    state.propsAvailable = true
    check(
      'a llama.cpp server with no total_slots takes the old road: nothing pinned, /slots never asked, the idle budget cuts the silence',
      unpinnedBody.id_slot === undefined &&
        state.slotsRequests === unpinnedSlotsBefore &&
        unpinned.some(row => row.isApiErrorMessage && row.errorDetails === 'idle-timeout'),
      `id_slot=${unpinnedBody.id_slot} slotsDelta=${state.slotsRequests - unpinnedSlotsBefore} rows=${JSON.stringify(unpinned.map(r => r.errorDetails ?? 'reply'))}`,
    )

    state.mode = 'silent-after-headers'
    state.processingSlot = -1
    const idleStarted = Date.now()
    const idleCut = await runTurn(llamaId, [createUserMessage({ content: 'the server took the request and then dropped it' })], {
      querySource: 'overload_probe',
    })
    const idleElapsed = Date.now() - idleStarted
    check(
      'headers and then silence on an idle pinned slot ends in bounded time, the cut naming the server and the slot it read',
      errorText(idleCut).includes(serverWords) && /reports slot \d+ idle/.test(errorText(idleCut)) && idleElapsed < 10_000,
      `elapsedMs=${idleElapsed} text=${errorText(idleCut).slice(0, 400)}`,
    )

    state.slotsHang = true
    const hangStarted = Date.now()
    const hangCut = await runTurn(llamaId, [createUserMessage({ content: 'the server stopped answering everything' })], {
      querySource: 'overload_probe',
    })
    const hangElapsed = Date.now() - hangStarted
    state.slotsHang = false
    check(
      'a server that no longer answers GET /slots either is cut once the probe times out, the cut naming the server',
      errorText(hangCut).includes(`${serverWords} did not answer GET /slots within 5 s`) && hangElapsed < 15_000,
      `elapsedMs=${hangElapsed} text=${errorText(hangCut).slice(0, 400)}`,
    )

    state.mode = 'no-headers'
    const headerlessStarted = Date.now()
    const headerlessCut = await runTurn(llamaId, [createUserMessage({ content: 'the server accepted the connection and never answered' })], {
      querySource: 'overload_probe',
    })
    const headerlessElapsed = Date.now() - headerlessStarted
    check(
      'no headers at all on an idle pinned slot ends at the first-byte budget, the cut naming the server and the slot it read',
      /no first byte from/.test(errorText(headerlessCut)) &&
        errorText(headerlessCut).includes(serverWords) &&
        /reports slot \d+ idle/.test(errorText(headerlessCut)) &&
        headerlessElapsed < 15_000,
      `elapsedMs=${headerlessElapsed} text=${errorText(headerlessCut).slice(0, 400)}`,
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
    'the SGLang road keeps its sessionAffinityHeader and clear_thinking: false without id_slot or cache_prompt',
    sglangReplies.every(row => !row.isApiErrorMessage) &&
      typeof sglangCapture.affinity === 'string' &&
      sglangCapture.affinity.length > 0 &&
      sglangCapture.body.chat_template_kwargs?.clear_thinking === false &&
      sglangCapture.body.id_slot === undefined &&
      sglangCapture.body.cache_prompt === undefined,
    `affinity=${sglangCapture.affinity} id_slot=${sglangCapture.body.id_slot} cache_prompt=${sglangCapture.body.cache_prompt}`,
  )

  process.env.MERCURY_COMPAT_BASE_URL = baseUrl
  const propsBeforeLegacy = state.propsRequests
  const legacyReplies = await runTurn(`compat/default/${model}`, [createUserMessage({ content: 'the legacy single endpoint from MERCURY_COMPAT_BASE_URL' })])
  delete process.env.MERCURY_COMPAT_BASE_URL
  const legacyBody = captures.at(-1)!.body
  check(
    'the legacy MERCURY_COMPAT_BASE_URL endpoint takes the chat-completions road: no /props read, no id_slot, no cache_prompt',
    legacyReplies.every(row => !row.isApiErrorMessage) &&
      state.propsRequests === propsBeforeLegacy &&
      legacyBody.id_slot === undefined &&
      legacyBody.cache_prompt === undefined,
    `props=${state.propsRequests - propsBeforeLegacy} id_slot=${legacyBody.id_slot} cache_prompt=${legacyBody.cache_prompt}`,
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
    'a stream cut after a tool fragment is terminal: one request, one error row naming the cut, no completed call',
    paintCut.calls === 1 &&
      toolStartsFor(paintCut.events, 'call-p').length === 1 &&
      paintedFor(paintCut.events, 'call-p') === '{"text":"par' &&
      toolStartsFor(paintCut.events, 'call-p2').length === 0 &&
      paintCut.assistants.length === 1 &&
      paintCut.assistants[0]?.isApiErrorMessage === true &&
      paintCut.assistants[0]?.errorDetails === 'idle-timeout' &&
      errorText(paintCut.assistants).includes('the stream went quiet mid-arguments') &&
      settledOrder(paintCut.assistants) === '',
    `calls=${paintCut.calls} settled=${settledOrder(paintCut.assistants)} errors=${paintCut.assistants.filter(row => row.isApiErrorMessage).length}`,
  )

  await import(`${root}/src/tasks.ts`)
  const { runAgent } = await import(`${root}/src/tools/AgentTool/runAgent.ts`)
  const { getDefaultAppState } = await import(`${root}/src/state/AppStateStore.ts`)
  const { createFileStateCacheWithSizeLimit } = await import(`${root}/src/utils/fileStateCache.ts`)
  const { runWithCwdOverride } = await import(`${root}/src/utils/cwd.ts`)
  process.env.MERCURY_AGENT_IDLE_MINUTES = SLOW_TOOL_IDLE_MINUTES
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
    const stallPhase =
      agentError === '' ? 'none' : inputJsonDeltas.length < 14 ? `mid-stream after ${inputJsonDeltas.length} of 14 deltas (the deltas were not counted as life)` : `after the stream settled (a cold tool phase longer than the ${SLOW_TOOL_IDLE_S} s limit on this box)`
    check(
      `crewmate survives a ${SLOW_TOOL_STREAM_S} s streaming tool call past the ${SLOW_TOOL_IDLE_S} s MERCURY_AGENT_IDLE_MINUTES limit and finishes`,
      agentError === '' && finalText.includes('LLMHOST-READY'),
      `stall=${stallPhase} agentError=${agentError} finalText=${finalText}`,
    )
    check(
      'progressive input_json_delta events are observed during the tool call without double-counting at settlement, and they are the life: no heartbeat is minted for a painted argument delta (the Anthropic road\'s rule)',
      streamActivities.length === 0 && inputJsonDeltas.length === 14 && inputJsonDeltas.join('') === expectedJson,
      `streamActivities=${streamActivities.length} deltas=${inputJsonDeltas.length} joined=${inputJsonDeltas.join('')}`,
    )
  } finally {
    delete process.env.MERCURY_AGENT_IDLE_MINUTES
    state.mode = 'reply'
  }

  console.log(`prove-llmhost-slots: ${checks} checks, ${failures} failures`)
  if (failures > 0) process.exitCode = 1
} finally {
  for (const held of heldResponses) held.destroy()
  if (vllmServer.listening) vllmServer.close()
  server.close()
  rmSync(home, { recursive: true, force: true })
}
