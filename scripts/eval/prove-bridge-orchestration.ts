#!/usr/bin/env bun
// ============================================================================
//  scripts/eval/prove-bridge-orchestration.ts
//  PROOF (spec c.4 #6): the in-cell orchestration helpers.
//    · completion() rides routedCallModel — proven against the loopback
//      fixture in BOTH provider dialects (an anthropic id over /v1/messages
//      SSE and a glm id over the Z.AI chat lane) — multi-auth by
//      construction; a schema'd completion whose reply carries no JSON
//      raises typed into the cell.
//    · agent() bridges through the Agent tool seam with schema parse +
//      strict/permissive validation surfaces (a registry double stands in
//      for the live subagent; the transaction around it is production).
//    · parallel() preserves input order, propagates the LOWEST-index
//      failure, and reads its width live from the delegation ceiling;
//      pipeline() runs staged waves — proven in BOTH kernels.
//  Every endpoint base is pinned to the fixture; nothing reaches a live
//  host; scratch home; kernels disposed.
// ============================================================================
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { z } from 'zod/v4'
import { check, cleanup, finish, loadEval, makeContext, section, setup, within } from './lib.js'

const { work } = setup()

// ── the loopback fixture: both dialects, every base pinned ────────────────
const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`
const anthropicSse = (text: string): string =>
  [
    `event: message_start\n${sse({ type: 'message_start', message: { id: 'fx', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 4, output_tokens: 1 } } })}`,
    `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
    `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}`,
    `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`,
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  ].join('')
const chatSse = (text: string): string =>
  [
    sse({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] }),
    sse({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2 } }),
    'data: [DONE]\n\n',
  ].join('')

const captured: Array<{ path: string }> = []
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    if (req.method === 'POST' && path.endsWith('/v1/messages')) {
      captured.push({ path })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(anthropicSse('settled by the first-party lane'))
      return
    }
    if (req.method === 'POST' && path.endsWith('/chat/completions')) {
      captured.push({ path })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(chatSse('settled by the glm lane'))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const port = typeof address === 'object' && address ? address.port : 0
const base = `http://127.0.0.1:${port}`
Object.assign(process.env, {
  ANTHROPIC_BASE_URL: base,
  ANTHROPIC_AUTH_TOKEN: 'fixture-token',
  MERCURY_ZAI_API_BASE: `${base}/zai/v4`,
  ZAI_API_KEY: 'fixture-zai-key',
  // Every other family pinned to the fixture too: an unpinned base fails
  // open to real credentials.
  MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
  MERCURY_OPENAI_CHATGPT_BASE: `${base}/openai/chatgpt`,
  MERCURY_OPENAI_AUTH_BASE: `${base}/openai/auth`,
  MERCURY_MOONSHOT_API_BASE: `${base}/moonshot/v1`,
  MERCURY_DEEPSEEK_API_BASE: `${base}/deepseek`,
  MERCURY_OPENROUTER_API_BASE: `${base}/openrouter/api/v1`,
  MERCURY_GEMINI_API_BASE: `${base}/gemini/v1beta`,
  MERCURY_HUGGINGFACE_API_BASE: `${base}/hf/v1`,
  MERCURY_HUGGINGFACE_HUB_BASE: `${base}/hf/hub`,
  MERCURY_LOCAL_BASE_URL: base,
})

const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const { evalKernelManager } = await loadEval()
const { makeEvalBridgeServer, oneShotCompletion } = await import('../../src/services/eval/evalBridge.js')
const { buildTool } = await import('../../src/Tool.js')

// ── the Agent seam double + a probe tool (registry-resolved, full
//    transaction around them) ───────────────────────────────────────────────
const agentCalls: Array<{ prompt: string }> = []
const AgentDouble = buildTool({
  name: 'Agent',
  maxResultSizeChars: 20_000,
  inputSchema: z.object({
    description: z.string(),
    prompt: z.string(),
    subagent_type: z.string().optional(),
    isolation: z.string().optional(),
  }),
  async description() {
    return 'agent double'
  },
  async prompt() {
    return 'agent double'
  },
  isConcurrencySafe() {
    return true
  },
  async call(input: { prompt: string }) {
    agentCalls.push({ prompt: input.prompt })
    // A schema'd prompt gets JSON back; an 'invalid' marker returns a payload
    // violating the schema; plain prompts get prose.
    if (input.prompt.includes('JSON Schema')) {
      if (input.prompt.includes('answer-badly')) {
        return { data: '{"count": "not-a-number"}' }
      }
      return { data: '{"count": 3, "label": "from-agent"}' }
    }
    return { data: `agent says: ${input.prompt.slice(0, 24)}` }
  },
  mapToolResultToToolResultBlockParam(output: string, toolUseID: string) {
    return { tool_use_id: toolUseID, type: 'tool_result', content: output }
  },
})
const probeCalls: string[] = []
const ProbeTool = buildTool({
  name: 'Probe',
  maxResultSizeChars: 20_000,
  inputSchema: z.object({ tag: z.string(), fail: z.boolean().optional() }),
  async description() {
    return 'probe'
  },
  async prompt() {
    return 'probe'
  },
  isConcurrencySafe() {
    return true
  },
  async call(input: { tag: string; fail?: boolean }) {
    probeCalls.push(input.tag)
    if (input.fail) throw new Error(`probe ${input.tag} failed deliberately`)
    return { data: `probe:${input.tag}` }
  },
  mapToolResultToToolResultBlockParam(output: string, toolUseID: string) {
    return { tool_use_id: toolUseID, type: 'tool_result', content: output }
  },
})

const allowAll = (async (_tool: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input })) as never

async function runCell(language: 'py' | 'js', code: string) {
  const abort = new AbortController()
  const context = await makeContext({ tools: [AgentDouble, ProbeTool], abortController: abort })
  const cellAbort = new AbortController()
  const serveBridge = makeEvalBridgeServer({ context, canUseTool: allowAll, cellAbort })
  try {
    return await within(
      `${language} orchestration cell`,
      90_000,
      evalKernelManager.runCell({
        owner: `orch-${language}`,
        cwd: work,
        input: { language, code, timeoutSeconds: 60 },
        abortSignal: abort.signal,
        serveBridge,
      }),
    )
  } finally {
    cellAbort.abort()
  }
}

try {
  section('completion() — both dialects through routedCallModel')
  const first = await oneShotCompletion({
    model: 'claude-sonnet-5',
    prompt: 'say the word',
    signal: new AbortController().signal,
  })
  check('anthropic-lane completion answers', first === 'settled by the first-party lane', first)
  const glm = await oneShotCompletion({
    model: 'glm-5.2',
    prompt: 'say the word',
    signal: new AbortController().signal,
  })
  check('glm-lane completion answers (multi-auth by construction)', glm === 'settled by the glm lane', glm)
  check('the two lanes hit DIFFERENT fixture paths', captured.some(c => c.path.endsWith('/v1/messages')) && captured.some(c => c.path === '/zai/v4/chat/completions'), JSON.stringify(captured))

  section('completion() schema failure raises typed into the cell')
  const cs = await runCell(
    'py',
    "try:\n    completion('give me data', schema={'type': 'object'})\n    r = 'ok'\nexcept Exception as e:\n    r = 'raised: ' + str(e)\nr",
  )
  check('schema-less reply → typed raise', (cs.resultRepr ?? '').includes('raised:') && (cs.resultRepr ?? '').includes('JSON'), cs.resultRepr)

  section('agent() — schema parse, strict and permissive surfaces')
  const ag1 = await runCell(
    'py',
    "data = agent('summarize the repo', schema={'type': 'object', 'properties': {'count': {'type': 'number'}, 'label': {'type': 'string'}}, 'required': ['count', 'label']})\nrepr((data['count'], data['label']))",
  )
  check('schema agent returns PARSED data', (ag1.resultRepr ?? '').includes("(3, 'from-agent')"), ag1.resultRepr ?? JSON.stringify(ag1.error))
  const ag2 = await runCell(
    'py',
    "try:\n    agent('answer-badly please', schema={'type': 'object', 'properties': {'count': {'type': 'number'}}, 'required': ['count']})\n    r = 'ok'\nexcept Exception as e:\n    r = 'raised: ' + str(e)\nr",
  )
  check('strict schema violation raises with the exact path', (ag2.resultRepr ?? '').includes('raised:') && (ag2.resultRepr ?? '').includes('count'), ag2.resultRepr)
  const ag3 = await runCell(
    'py',
    "v = agent('answer-badly please', schema={'type': 'object', 'properties': {'count': {'type': 'number'}}, 'required': ['count']}, strict=False)\nrepr(v)",
  )
  check('permissive mode returns the parsed-but-invalid value', (ag3.resultRepr ?? '').includes('not-a-number'), ag3.resultRepr)
  const ag4 = await runCell('py', "agent('plain prose request')")
  check('plain agent returns final text', ag4.status === 'ok' && (ag4.resultRepr ?? '').includes('agent says:'), ag4.resultRepr)

  section('parallel() — order, width, lowest-index failure (Python)')
  probeCalls.length = 0
  const par1 = await runCell(
    'py',
    "results = parallel([\n    lambda: tool.Probe(tag='a'),\n    lambda: tool.Probe(tag='b'),\n    lambda: tool.Probe(tag='c'),\n])\nrepr(results)",
  )
  check('parallel preserves input order', (par1.resultRepr ?? '').includes("['probe:a', 'probe:b', 'probe:c']"), par1.resultRepr ?? JSON.stringify(par1.error))
  const par2 = await runCell(
    'py',
    "try:\n    parallel([\n        lambda: tool.Probe(tag='x0'),\n        lambda: tool.Probe(tag='x1', fail=True),\n        lambda: tool.Probe(tag='x2', fail=True),\n    ])\n    r = 'ok'\nexcept Exception as e:\n    r = 'raised: ' + str(e)\nr",
  )
  check('the LOWEST-index failure propagates', (par2.resultRepr ?? '').includes('x1 failed'), par2.resultRepr)

  section('parallel()/pipeline() in the JS kernel')
  const jsPar = await runCell(
    'js',
    "const results = await parallel([\n  () => tool.Probe({ tag: 'ja' }),\n  () => tool.Probe({ tag: 'jb' }),\n])\nresults.join('|')",
  )
  check('js parallel ordered', (jsPar.resultRepr ?? '').includes('probe:ja|probe:jb'), jsPar.resultRepr ?? JSON.stringify(jsPar.error))
  const jsPipe = await runCell(
    'js',
    "const out = await pipeline(['p', 'q'], async item => tool.Probe({ tag: item }), async prev => prev + '!')\nout.join('|')",
  )
  check('js pipeline staged waves', (jsPipe.resultRepr ?? '').includes('probe:p!|probe:q!'), jsPipe.resultRepr ?? JSON.stringify(jsPipe.error))

  section('pipeline() staged waves (Python) + live width')
  const pyPipe = await runCell(
    'py',
    "out = pipeline(['m', 'n'], lambda item: tool.Probe(tag=item), lambda prev: prev + '!')\nrepr(out)",
  )
  check('py pipeline staged waves', (pyPipe.resultRepr ?? '').includes("['probe:m!', 'probe:n!']"), pyPipe.resultRepr)
  const width = await runCell('py', 'repr(type(parallel([])).__name__)')
  check('parallel([]) short-circuits without a width query', width.status === 'ok')
} finally {
  await evalKernelManager.disposeAll()
  check('no kernel left behind', evalKernelManager.kernelCount() === 0)
  server.close()
  cleanup()
}
finish('BRIDGE-ORCHESTRATION')
