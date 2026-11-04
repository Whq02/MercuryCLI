#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod/v4'

process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'))
delete process.env.NODE_ENV
for (const key of [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'MERCURY_OAUTH_TOKEN',
  'MERCURY_MODEL',
  'MERCURY_SCRIPTED_STREAM',
  'MERCURY_BARE',
  'MERCURY_EFFORT_LEVEL',
  'MERCURY_OPENAI_CHATGPT_BASE',
  'MERCURY_AUTH_SCOPE_DIR',
  'MERCURY_WIRE_DUMP',
  'MERCURY_HOME',
]) {
  delete process.env[key]
}

const configHome = mkdtempSync(join(tmpdir(), 'openai-400-capture-'))
process.env.MERCURY_CONFIG_DIR = configHome
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

const MODEL = 'gpt-6-astra'
const SECRET_API_KEY = 'sk-proj-secret-fixture-credential-1234567890abcdef'
const SECRET_BEARER = 'Bearer secret-inline-bearer-token-9876543210fedcba'
const OFFENDING_CALL_ID = 'call_fixture_oversized_webfetch_01'
const FOLLOWUP_CALL_ID = 'call_fixture_followup_02'
const FIXTURE_AGENT_ID = 'agent-fixture-400'
const BODY_DETAIL = 'input[3].output: oversized 29 KB function_call_output rejected by endpoint'
const BODY_PARAM = 'input[3].output'

const MODELS_BODY = {
  models: [
    {
      slug: MODEL,
      display_name: 'GPT-6 Astra',
      supported_reasoning_levels: [
        { effort: 'low', description: 'low' },
        { effort: 'high', description: 'high' },
        { effort: 'max', description: 'max' },
      ],
      default_reasoning_level: 'max',
      visibility: 'list',
      priority: 1,
      context_window: 1_050_000,
      max_context_window: 1_050_000,
      input_modalities: ['text', 'image'],
      supported_in_api: true,
    },
  ],
}

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`

interface WirePost {
  raw: string
  parsed?: Record<string, unknown>
  hasUnpairedSurrogateEscape: boolean
  offendingOutputChars: number
  hasFollowupOutput: boolean
  status: number
}

const wirePosts: WirePost[] = []
let alwaysReject400 = false
let replyWithToolCallOnce = false

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    if (req.method === 'GET' && path.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
      res.end(JSON.stringify(MODELS_BODY))
      return
    }
    if (req.method !== 'POST' || !path.endsWith('/responses')) {
      res.writeHead(404, { 'content-type': 'application/json', connection: 'close' })
      res.end('{}')
      return
    }
    const raw = Buffer.concat(chunks).toString('utf8')
    const hasUnpairedSurrogateEscape = /\\ud[89a-f][0-9a-f]{2}/i.test(raw)
    let parsed: Record<string, unknown> | undefined
    let offendingOutputChars = 0
    let hasFollowupOutput = false
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>
      const input = Array.isArray(parsed.input) ? (parsed.input as Array<Record<string, unknown>>) : []
      for (const item of input) {
        if (item.type === 'function_call_output' && item.call_id === OFFENDING_CALL_ID && typeof item.output === 'string') {
          offendingOutputChars = item.output.length
        }
        if (item.type === 'function_call_output' && item.call_id === FOLLOWUP_CALL_ID) {
          hasFollowupOutput = true
        }
      }
    } catch {
      parsed = undefined
    }
    const reject = alwaysReject400 || hasUnpairedSurrogateEscape || offendingOutputChars > 20_000
    if (reject) {
      wirePosts.push({ raw, parsed, hasUnpairedSurrogateEscape, offendingOutputChars, hasFollowupOutput, status: 400 })
      res.writeHead(400, { 'content-type': 'application/json', connection: 'close' })
      res.end(
        JSON.stringify({
          error: {
            message: 'Bad Request',
            param: BODY_PARAM,
          },
          detail: BODY_DETAIL,
        }),
      )
      return
    }
    wirePosts.push({ raw, parsed, hasUnpairedSurrogateEscape, offendingOutputChars, hasFollowupOutput, status: 200 })
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
    const respId = `resp_fixture_ok_${wirePosts.length}`
    res.write(sse({ type: 'response.created', response: { id: respId } }))
    if (replyWithToolCallOnce) {
      replyWithToolCallOnce = false
      const callItem = {
        type: 'function_call',
        id: 'fc_fixture_followup_02',
        call_id: FOLLOWUP_CALL_ID,
        name: 'Echo',
        arguments: JSON.stringify({ text: 'step-two-check' }),
      }
      res.write(sse({ type: 'response.output_item.added', item: callItem }))
      res.write(sse({ type: 'response.output_item.done', item: callItem }))
      res.end(
        sse({
          type: 'response.completed',
          response: {
            id: respId,
            usage: { input_tokens: 120, output_tokens: 18, input_tokens_details: { cached_tokens: 64 } },
          },
        }),
      )
      return
    }
    const replyText = 'Recovered and finished the brief.'
    res.write(sse({ type: 'response.output_text.delta', delta: replyText }))
    res.write(
      sse({
        type: 'response.output_item.done',
        item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: replyText }] },
      }),
    )
    res.end(
      sse({
        type: 'response.completed',
        response: {
          id: respId,
          usage: { input_tokens: 120, output_tokens: 12, input_tokens_details: { cached_tokens: 64 } },
        },
      }),
    )
  })
})

await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
Object.assign(process.env, {
  MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
  OPENAI_API_KEY: SECRET_API_KEY,
})

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { getOriginalCwd, getSessionId, getSessionProjectDir } = bootstrap
const { getProjectDir } = await import('../../src/utils/sessionStoragePortable.ts')
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { classifyOverflowFault } = await import('../../src/services/api/overflowSignal.ts')
import type { Tool } from '../../src/Tool.ts'
import type { AssistantMessage, Message } from '../../src/types/message.ts'

const sessionDir = join(getSessionProjectDir() ?? getProjectDir(getOriginalCwd()), getSessionId())

const echoTool = {
  name: 'Echo',
  inputSchema: z.object({ text: z.string() }),
  prompt: async () => 'Echoes fixture text.',
  isEnabled: () => true,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
} as unknown as Tool

const offendingToolResultText =
  'Source: https://example.test/docs/reference.md\n' +
  `[Auth probe header that must be scrubbed in capture: ${SECRET_BEARER}]\n` +
  Array.from({ length: 320 }, (_, i) => `Fixture line ${i + 1}: synthetic documentation line with parameters and benchmarks for proof coverage.`).join('\n') +
  '\n---\n\uDC4D **Synthetic Section Heading**: fixture excerpt after slicing an emoji pair in UTF-16 code units.\n' +
  Array.from({ length: 120 }, (_, i) => `Fixture tail ${i + 1}: synthetic protocol specification and schema validation rules.`).join('\n')

function buildHistoryBeforeFault(seedLabel: string): Message[] {
  const userBrief = createUserMessage({
    content: `[${seedLabel}] Audit the fixture pages and write the summary. Never leak ${SECRET_BEARER}.`,
  })
  const assistantToolCall: AssistantMessage = {
    type: 'assistant',
    requestId: undefined,
    uuid: '00000000-0000-4000-8000-000000000401' as never,
    timestamp: new Date().toISOString(),
    message: {
      id: 'openai_00000000-0000-4000-8000-000000000401',
      model: MODEL,
      role: 'assistant',
      type: 'message',
      content: [
        {
          type: 'tool_use',
          id: OFFENDING_CALL_ID,
          name: 'Echo',
          input: { text: 'fetch-docs' },
        },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: {
        input_tokens: 245331,
        output_tokens: 1146,
        cache_read_input_tokens: 105344,
        cache_creation_input_tokens: 0,
      } as never,
      container: null,
      context_management: null,
    },
    apexProviderTurn: {
      provider: 'openai',
      responseId: 'resp_fixture_turn_01',
      items: [
        {
          type: 'reasoning',
          id: 'rs_fixture_turn_01',
          summary: [{ type: 'summary_text', text: '**Checking fixture targets**' }],
          content: [],
          encrypted_content: 'gAAAAABfixture_encrypted_reasoning_payload_' + 'A'.repeat(2000),
        },
        {
          type: 'function_call',
          call_id: OFFENDING_CALL_ID,
          name: 'Echo',
          arguments: JSON.stringify({ text: 'fetch-docs' }),
          id: 'fc_fixture_turn_01',
        },
      ],
    },
  }
  const userToolResult = createUserMessage({
    content: [
      {
        type: 'tool_result',
        tool_use_id: OFFENDING_CALL_ID,
        content: offendingToolResultText,
      },
    ],
  })
  return [userBrief, assistantToolCall, userToolResult]
}

async function runTurn(messages: Message[], agentId = FIXTURE_AGENT_ID): Promise<{ assistants: AssistantMessage[]; streamedText: string }> {
  const assistants: AssistantMessage[] = []
  let streamedText = ''
  const stream = routedCallModel({
    messages: messages as never,
    systemPrompt: asSystemPrompt(['You are a research specialist on the OpenAI Responses road.']),
    thinkingConfig: { type: 'disabled' },
    tools: [echoTool],
    signal: new AbortController().signal,
    options: {
      getToolPermissionContext: () => Promise.resolve(getEmptyToolPermissionContext()),
      model: MODEL,
      effortValue: 'max',
      isNonInteractiveSession: true,
      hasAppendSystemPrompt: false,
      querySource: 'agent:builtin:mercury-crew' as never,
      agentId: agentId as never,
      agents: [],
      mcpTools: [],
    },
  } as never)
  for await (const event of stream) {
    const rec = event as Record<string, unknown>
    if (rec.type === 'assistant') {
      assistants.push(event as AssistantMessage)
    } else if (rec.type === 'stream_event') {
      const ev = (rec as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        streamedText += ev.delta.text ?? ''
      }
    }
  }
  return { assistants, streamedText }
}

function textOfAssistant(msg: AssistantMessage | undefined): string {
  if (!msg) return ''
  const content = msg.message.content
  if (!Array.isArray(content)) return ''
  return content.map(b => (b.type === 'text' ? b.text : '')).join('\n')
}

function listCaptureFiles(): string[] {
  if (!existsSync(sessionDir)) return []
  return readdirSync(sessionDir, { recursive: true })
    .map(entry => join(sessionDir, String(entry)))
    .filter(p => p.endsWith('.json') && !p.endsWith('.meta.json') && !p.endsWith('.resume-snapshot.json'))
    .sort()
}

try {
  section('§1 Initial 400 on the OpenAI road — capture file under session dir, redacted & truncated, fault names file and body detail')
  const history1 = buildHistoryBeforeFault('run-1')
  check('fixture tool_result is ~29 KB and carries the unpaired surrogate U+DC4D', offendingToolResultText.length > 27_000 && offendingToolResultText.includes('\uDC4D'))

  const turn1 = await runTurn(history1, FIXTURE_AGENT_ID)
  check('initial 400 makes exactly 1 wire POST (no recovery retry on a non-resumed turn)', wirePosts.length === 1 && wirePosts[0]?.status === 400, `posts=${wirePosts.length}`)
  check('lone surrogates in transcript strings are sanitised before reaching the wire on every request', wirePosts[0]?.hasUnpairedSurrogateEscape === false)

  const errRow1 = turn1.assistants.at(-1)
  const errText1 = textOfAssistant(errRow1)
  console.log(`      turn1 error row: ${errText1}`)

  check('terminal row is an API error with invalid_request', errRow1?.isApiErrorMessage === true && errRow1.error === 'invalid_request')
  check('fault message carries the body detail and param (not bare "Bad Request" alone)', errText1.includes(BODY_DETAIL) && errText1.includes(BODY_PARAM), errText1)
  check('fault row never carries a brace', !errText1.includes('{') && !errText1.includes('}'), errText1)

  const capturesAfterTurn1 = listCaptureFiles()
  check('exactly one diagnostic capture file was written under the session directory', capturesAfterTurn1.length === 1, `found=${JSON.stringify(capturesAfterTurn1)} in ${sessionDir}`)
  const captureFile1 = capturesAfterTurn1[0] ?? ''
  check('fault message names the capture file path', captureFile1 !== '' && errText1.includes(captureFile1), `captureFile=${captureFile1} | errText=${errText1}`)

  if (captureFile1 && existsSync(captureFile1)) {
    const rawCapture = readFileSync(captureFile1, 'utf8')
    const stat = statSync(captureFile1)
    check('capture file size is bounded (<= 48 KB)', stat.size > 0 && stat.size <= 49_152, `size=${stat.size}`)
    check('secrets and credentials are redacted from the capture file', !rawCapture.includes(SECRET_API_KEY) && !rawCapture.includes('secret-inline-bearer-token-9876543210fedcba') && rawCapture.includes('Bearer ***'))
    const parsedCapture = JSON.parse(rawCapture) as Record<string, unknown>
    check('capture file records status 400, model, and truncated large text parts with their sizes', parsedCapture.status === 400 && rawCapture.includes('truncated:') && rawCapture.includes(`${offendingToolResultText.length} chars`))
  } else {
    check('capture file is readable JSON with redacted secrets and truncated text sizes', false, 'capture file missing')
  }

  section('§2 Recovery on resume — trims once with notice, returns a tool call, and the following request stays clean and succeeds')
  replyWithToolCallOnce = true
  const resumedMessages: Message[] = [
    ...history1,
    ...(errRow1 ? [errRow1] : []),
    createUserMessage({ content: 'Carry on with the brief and run the follow-up tool.' }),
  ]
  const postsBeforeResume = wirePosts.length
  const turn2 = await runTurn(resumedMessages, FIXTURE_AGENT_ID)
  const resumePosts = wirePosts.slice(postsBeforeResume)

  check(
    'resumed turn made 2 wire POSTs: the replayed 400, then 1 trimmed retry that succeeded (200)',
    resumePosts.length === 2 && resumePosts[0]?.status === 400 && resumePosts[1]?.status === 200,
    `statuses=${JSON.stringify(resumePosts.map(p => p.status))}`,
  )
  check(
    'the retry compacted the offending 29 KB tool result using the road digest placeholder',
    resumePosts[1] !== undefined &&
      !resumePosts[1].hasUnpairedSurrogateEscape &&
      resumePosts[1].offendingOutputChars > 0 &&
      resumePosts[1].offendingOutputChars < 200 &&
      resumePosts[1].raw.includes('[stale tool result'),
    `offendingOutputChars=${resumePosts[1]?.offendingOutputChars}`,
  )
  const turn2Texts = turn2.assistants.map(textOfAssistant).join('\n')
  const settledToolUse = turn2.assistants
    .flatMap(m => (Array.isArray(m.message.content) ? m.message.content : []))
    .find(b => b.type === 'tool_use' && b.id === FOLLOWUP_CALL_ID)
  check(
    'recovered turn settled the follow-up tool_use call alongside the one-line [openai] notice',
    settledToolUse !== undefined &&
      turn2.assistants.every(m => m.isApiErrorMessage !== true) &&
      turn2.assistants.some(
        m =>
          textOfAssistant(m).includes('[openai]') &&
          textOfAssistant(m).includes(OFFENDING_CALL_ID) &&
          !textOfAssistant(m).includes('\n'),
      ),
    turn2Texts,
  )

  const followupResult = createUserMessage({
    content: [
      {
        type: 'tool_result',
        tool_use_id: FOLLOWUP_CALL_ID,
        content: 'step-two-complete',
      },
    ],
  })
  const postsBeforeFollowup = wirePosts.length
  const turn2Followup = await runTurn([...resumedMessages, ...turn2.assistants, followupResult], FIXTURE_AGENT_ID)
  const followupPosts = wirePosts.slice(postsBeforeFollowup)
  const followupTexts = turn2Followup.assistants.map(textOfAssistant).join('\n')
  check(
    'following request after the recovered tool call keeps the offending tool result compacted and succeeds in 1 POST (200)',
    followupPosts.length === 1 &&
      followupPosts[0]?.status === 200 &&
      followupPosts[0].hasFollowupOutput === true &&
      followupPosts[0].offendingOutputChars > 0 &&
      followupPosts[0].offendingOutputChars < 200 &&
      turn2Followup.assistants.every(m => m.isApiErrorMessage !== true) &&
      followupTexts.includes('Recovered and finished the brief.'),
    `posts=${followupPosts.length} offendingChars=${followupPosts[0]?.offendingOutputChars} texts=${followupTexts}`,
  )

  section('§3 Bounded recovery — when the retry also fails with 400, it stops after one retry, emits the notice, and names the capture file')
  alwaysReject400 = true
  const history3 = buildHistoryBeforeFault('run-3')
  const initial3 = await runTurn(history3, 'agent-bounded-3')
  const errRow3 = initial3.assistants.at(-1)!
  const postsBeforeBoundedResume = wirePosts.length
  const capturesBeforeBoundedResume = listCaptureFiles().length
  const resumed3 = await runTurn(
    [...history3, errRow3, createUserMessage({ content: 'Resume when backend rejects everything.' })],
    'agent-bounded-3',
  )
  const boundedPosts = wirePosts.slice(postsBeforeBoundedResume)
  const capturesAfterBoundedResume = listCaptureFiles()
  const finalErr3 = textOfAssistant(resumed3.assistants.at(-1))
  check(
    'when the retry also 400s, exactly 2 wire POSTs are made on the resumed turn (never a second retry)',
    boundedPosts.length === 2 && boundedPosts.every(p => p.status === 400),
    `statuses=${JSON.stringify(boundedPosts.map(p => p.status))}`,
  )
  check(
    'the one-line compaction notice still lands in the transcript before the standing error row when the retry fails',
    resumed3.assistants.some(m => textOfAssistant(m).includes('[openai]') && textOfAssistant(m).includes(OFFENDING_CALL_ID)),
    resumed3.assistants.map(textOfAssistant).join('\n'),
  )
  check(
    'one capture file per fault was written, and the standing fault names the latest capture file and body detail',
    capturesAfterBoundedResume.length === capturesBeforeBoundedResume + 2 &&
      finalErr3.includes(BODY_DETAIL) &&
      capturesAfterBoundedResume.some(f => finalErr3.includes(f)),
    finalErr3,
  )

  section('§4 Shared OpenAI-compat Responses transport — explicit capture, wireMessage preservation for bodiless overflow, and retention bound')
  const { openrouterResponsesTransport } = await import('../../src/services/providers/openrouter/openrouterResponsesTransport.ts')
  const { mapOpenaiHttpFailure } = await import('../../src/services/providers/openai/openaiWire.ts')
  const { MAX_FAULT_CAPTURES_PER_SESSION } = await import('../../src/services/api/dumpPrompts.ts')
  const capturesBeforeCompat = listCaptureFiles().length
  const compatTransport = openrouterResponsesTransport(
    {
      url: `${base}/openai/v1/chat/completions`,
      apiKey: SECRET_API_KEY,
      request: {
        model: 'openai/gpt-6-astra',
        messages: [{ role: 'user', content: 'compat responses probe' }],
        tools: [],
      },
      deferral: {
        form: 'openrouter-native',
        deferredNames: new Set(),
        imagesSupported: true,
      },
    } as never,
    history3,
  )
  const compatEvents: Array<Record<string, unknown>> = []
  if (compatTransport) {
    for await (const ev of compatTransport.events) {
      compatEvents.push(ev as unknown as Record<string, unknown>)
    }
  }
  const compatFault = compatEvents.find(e => e.type === 'stream-fault') as { fault?: { message?: string; wireMessage?: string } } | undefined
  const capturesAfterCompat = listCaptureFiles()
  check(
    'OpenAI-compat Responses transport writes a capture file on 400, names it and the body detail in message, and carries wireMessage',
    capturesAfterCompat.length === capturesBeforeCompat + 1 &&
      typeof compatFault?.fault?.message === 'string' &&
      compatFault.fault.message.includes(BODY_DETAIL) &&
      compatFault.fault.wireMessage === `Bad Request — ${BODY_DETAIL}` &&
      capturesAfterCompat.some(f => compatFault.fault?.message?.includes(f)),
    JSON.stringify(compatFault),
  )
  const bodilessCaptured = mapOpenaiHttpFailure(400, { detail: 'Bad Request' }, undefined, {
    request: { model: 'openai/gpt-6-astra', input: [] },
  })
  const bodilessSignal = classifyOverflowFault({
    family: 'openrouter',
    status: 400,
    code: bodilessCaptured.code,
    message: bodilessCaptured.wireMessage ?? bodilessCaptured.message,
    measured: () => ({ tokens: 90_000, window: 100_000 }),
  })
  const bodilessFromFullMessage = classifyOverflowFault({
    family: 'openrouter',
    status: 400,
    code: bodilessCaptured.code,
    message: bodilessCaptured.message,
    measured: () => ({ tokens: 90_000, window: 100_000 }),
  })
  check(
    'a near-window bodiless 400 with a capture path preserves its context-size overflow signal',
    bodilessSignal !== null &&
      bodilessSignal.shape === 'context-size' &&
      bodilessSignal.measuredTokens === 90_000 &&
      bodilessFromFullMessage !== null &&
      bodilessFromFullMessage.shape === 'context-size',
    JSON.stringify({ bodilessSignal, bodilessFromFullMessage }),
  )
  for (let i = 0; i < MAX_FAULT_CAPTURES_PER_SESSION + 5; i++) {
    mapOpenaiHttpFailure(400, { detail: `cap-probe-${i}` }, undefined, { request: { model: MODEL, input: [] } })
  }
  check(
    'session capture files are bounded by MAX_FAULT_CAPTURES_PER_SESSION',
    listCaptureFiles().length <= MAX_FAULT_CAPTURES_PER_SESSION,
    `count=${listCaptureFiles().length} cap=${MAX_FAULT_CAPTURES_PER_SESSION}`,
  )
} finally {
  server.close()
  rmSync(configHome, { recursive: true, force: true })
}

console.log(`\n${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
