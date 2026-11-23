#!/usr/bin/env bun
import { proofHome } from '../lib/hermetic.ts'
import { removeScratch } from '../lib/removeScratch.ts'
import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import type { Message } from '../../src/engine/message-shapes/message.ts'
import type { JsonOutputFormat } from '../../src/engine/message-shapes/wire.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
for (const name of Object.keys(process.env)) {
  if (/^(ANTHROPIC_|MERCURY_)/.test(name) && !['MERCURY_CONFIG_DIR', 'MERCURY_CREDENTIAL_STORE'].includes(name)) delete process.env[name]
}
process.env.MERCURY_CONFIG_DIR = proofHome
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_THINKING_DISPLAY = 'updates'

const HINT = 'to fix, change modelThinkingOffIsBetweenTools in src/models/facts/capabilities.ts or the lines after applyThinkingBinding in src/models/roads/anthropic/stream-core/wireParams.ts'
let failures = 0
function check(label: string, cond: boolean, detail?: string): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${cond ? '' : ` — ${detail ?? ''} — ${HINT}`}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const turns: ScriptedTurn[] = Array.from({ length: 32 }, () => ({ kind: 'text', text: 'OK' }) as ScriptedTurn)
const fixture = await startFixtureApi(turns, { captureAllHeaders: true })
const nativeFetch = globalThis.fetch
const leftTheMachine: string[] = []
const fixtureFetch: typeof fetch = (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (url.host === 'api.anthropic.com') return nativeFetch(new URL(`${url.pathname}${url.search}`, fixture.url), init)
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return nativeFetch(input, init)
  leftTheMachine.push(url.host)
  return Promise.reject(new Error(`the proof lets no request leave the machine: ${url.host}`))
}
globalThis.fetch = fixtureFetch

const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const { switchSession } = await import('../../src/boot/process-state/processState.ts')
const { asSessionId } = await import('../../src/sessions/transcripts/ids.ts')
switchSession(asSessionId('22222222-2222-4222-8222-222222222222'))
const { routedCallModel } = await import('../../src/models/roads/callModelRouter.ts')
const { createUserMessage } = await import('../../src/engine/messages/messages.ts')
const { asSystemPrompt } = await import('../../src/engine/system-prompt/systemPromptType.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const caps = await import('../../src/models/facts/capabilities.ts')
const { MESSAGE_EFFORT_BETA_HEADER, THINKING_BINDING_CONTROLS_BETA_HEADER, THINKING_DISPLAY_UPDATES_BETA_HEADER } = await import('../../src/models/roads/betaHeaders.ts')

type Body = { model?: string; thinking?: unknown; output_config?: { effort?: string; format?: unknown }; messages?: Array<{ role: string; content: unknown; output_config?: unknown }> }
type Sent = { body: Body; betas: string[]; failed: string | null }
const j = (value: unknown): string => JSON.stringify(value)
const SONNET = 'claude-sonnet-5-5'
const BETWEEN = '{"type":"between_tools"}'
const MESSAGE_EFFORT = '{"role":"system","content":[],"output_config":{"effort":"low"}}'

async function send(model: string, thinking: 'disabled' | 'adaptive', effort: string | undefined, history?: Message[], outputFormat?: JsonOutputFormat): Promise<Sent> {
  const from = fixture.messageRequests().length
  let failed: string | null = null
  for await (const event of routedCallModel({
    messages: history ?? [createUserMessage({ content: 'Say OK.' })],
    systemPrompt: asSystemPrompt(['You answer in one word.']),
    thinkingConfig: { type: thinking }, tools: [], signal: new AbortController().signal,
    options: {
      model, querySource: 'sdk', isNonInteractiveSession: true,
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      agents: [], mcpTools: [], hasAppendSystemPrompt: false, enablePromptCaching: true,
      effortValue: effort as never, fetchOverride: fixtureFetch, ...(outputFormat !== undefined ? { outputFormat } : {}),
    },
  })) {
    if (event.type === 'assistant' && event.isApiErrorMessage) failed = j(event.message.content).slice(0, 300)
  }
  const request = fixture.messageRequests()[from]
  const body = (request?.body ?? {}) as Body
  return { body, betas: (request?.headers['anthropic-beta'] ?? '').split(',').filter(Boolean), failed: request === undefined ? 'no request reached the stand-in' : failed }
}
const bare = (sent: Sent): boolean => sent.failed === null && j(sent.body.thinking) === BETWEEN && !sent.betas.includes(THINKING_BINDING_CONTROLS_BETA_HEADER) && !sent.betas.includes(THINKING_DISPLAY_UPDATES_BETA_HEADER)
const shown = (sent: Sent): string => j({ thinking: sent.body.thinking ?? null, effort: sent.body.output_config?.effort ?? null, betas: sent.betas, failed: sent.failed })

try {
  section('§1 thinking off on Sonnet 5.5 at the three efforts the API accepts: the request says between_tools and nothing beside it')
  for (const effort of ['low', 'medium', 'high']) {
    const sent = await send(SONNET, 'disabled', effort)
    check(`${effort}: thinking is {"type":"between_tools"} alone, no binding or display header, effort ${effort} at the request level`, bare(sent) && sent.body.output_config?.effort === effort, shown(sent))
  }
  const twin = await send(`${SONNET}[1m]`, 'disabled', 'high')
  check('the [1m] twin at high sends the same setting', bare(twin), shown(twin))
  const unset = await send(SONNET, 'disabled', undefined)
  const unsetEffort = unset.body.output_config?.effort
  check('with no effort chosen the setting rides whenever the request-level effort is absent or high and below', (unsetEffort === 'xhigh' || unsetEffort === 'max') ? unset.body.thinking === undefined : bare(unset), shown(unset))

  section('§2 at xhigh and max the API refuses between_tools, so the request keeps no thinking parameter; so does a request with a JSON output format')
  for (const effort of ['xhigh', 'max']) {
    const sent = await send(SONNET, 'disabled', effort)
    check(`${effort}: no thinking parameter, effort ${effort} at the request level`, sent.failed === null && !('thinking' in sent.body) && sent.body.output_config?.effort === effort, shown(sent))
  }
  check('the one rule says the same, level by level', ['low', 'medium', 'high', undefined, null].every(effort => caps.modelThinkingOffIsBetweenTools(SONNET, { effort })) && !caps.modelThinkingOffIsBetweenTools(SONNET, { effort: 'xhigh' }) && !caps.modelThinkingOffIsBetweenTools(SONNET, { effort: 'max' }))
  const format: JsonOutputFormat = { type: 'json_schema', schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false } }
  const titled = await send(SONNET, 'disabled', 'low', undefined, format)
  check('beside a JSON output format (no live call has confirmed between_tools there) the request keeps no thinking parameter', titled.failed === null && !('thinking' in titled.body) && titled.body.output_config?.effort === 'low' && j(titled.body.output_config?.format) === j(format) && !caps.modelThinkingOffIsBetweenTools(SONNET, { effort: 'low', format }), `${shown(titled)} ${j(titled.body.output_config)}`)

  section('§3 thinking on keeps its request: adaptive with the binding and the display')
  const adaptive = await send(SONNET, 'adaptive', 'high')
  check('Sonnet 5.5 with thinking on sends adaptive, the block binding and the updates display', adaptive.failed === null && j(adaptive.body.thinking) === '{"type":"adaptive","display":"updates","block_binding":{"prefix_mismatch_behavior":"drop_block"}}' && adaptive.betas.includes(THINKING_BINDING_CONTROLS_BETA_HEADER) && adaptive.betas.includes(THINKING_DISPLAY_UPDATES_BETA_HEADER), shown(adaptive))

  section('§4 every other model keeps the request it sent with thinking off')
  for (const model of ['claude-opus-5-5', 'claude-fable-5-2', 'claude-mythos-5-2', 'claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-5-5']) {
    const sent = await send(model, 'disabled', 'high')
    check(`${model}: no thinking parameter`, sent.failed === null && !('thinking' in sent.body), shown(sent))
  }
  check('a carrier spelling and an undeclared generation never take the setting', !caps.modelThinkingOffIsBetweenTools('openrouter/anthropic/claude-sonnet-5-5', { effort: 'high' }) && !caps.modelThinkingOffIsBetweenTools('claude-sonnet-5-7', { effort: 'high' }) && !caps.modelThinkingOffIsBetweenTools('claude-opus-5-5', { effort: 'high' }))
  check('thinking stays always on for the row, so the side roads read as they did', caps.modelThinkingAlwaysOn(SONNET))

  section('§5 between_tools takes no per-message effort and no thinking block beside it')
  const said = { type: 'assistant', uuid: '00000000-0000-4000-a000-000000000002', timestamp: '2026-11-22T00:00:00.000Z', message: { id: 'msg_said', type: 'message', role: 'assistant', model: SONNET, content: [{ type: 'text', text: 'OK', citations: [] }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } } as unknown as Message
  const ask = (): Message[] => [createUserMessage({ content: 'Say OK.' }), said, { ...createUserMessage({ content: 'Sum it up in one word.', isMeta: true }), replyEffort: 'low' } as Message]
  const stepped = await send(SONNET, 'adaptive', 'high', ask())
  check('thinking on: the low-effort reply row follows the ask and its header rides (the stand-in would carry both)', stepped.failed === null && j(stepped.body.messages?.at(-1)) === MESSAGE_EFFORT && stepped.betas.includes(MESSAGE_EFFORT_BETA_HEADER), `${j(stepped.body.messages?.map(row => row.role))} ${j(stepped.betas)}`)
  const flat = await send(SONNET, 'disabled', 'high', ask())
  check('thinking off: the same ask sends between_tools, no row and no header, at the request-level effort', bare(flat) && flat.body.output_config?.effort === 'high' && !j(flat.body.messages).includes('"role":"system"') && !flat.betas.includes(MESSAGE_EFFORT_BETA_HEADER), `${shown(flat)} ${j(flat.body.messages?.map(row => row.role))}`)
  const wrote = { type: 'assistant', uuid: '00000000-0000-4000-a000-000000000001', timestamp: '2026-11-22T00:00:00.000Z', message: { id: 'msg_wrote', type: 'message', role: 'assistant', model: SONNET, content: [{ type: 'thinking', thinking: 'a plan', signature: 'sig' }, { type: 'text', text: 'done', citations: [] }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } } as unknown as Message
  const replay = await send(SONNET, 'disabled', 'high', [createUserMessage({ content: 'Plan it.' }), wrote, createUserMessage({ content: 'Say OK.' })])
  check('thinking off: an earlier thinking block of the model stays out of the between_tools request', bare(replay) && !j(replay.body.messages).includes('"type":"thinking"') && j(replay.body.messages).includes('done'), `${shown(replay)} ${j(replay.body.messages).slice(0, 300)}`)

  section('§6 nothing left the machine')
  check('every request went to the stand-in', leftTheMachine.length === 0, leftTheMachine.join(', '))
} finally {
  await fixture.close()
  removeScratch(proofHome)
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(` FAIL — ${failures} Sonnet 5.5 thinking-off wire check(s) failed`)
  process.exit(1)
}
console.log(' ALL SONNET 5.5 THINKING-OFF WIRE PROOFS PASS')
process.exit(0)
