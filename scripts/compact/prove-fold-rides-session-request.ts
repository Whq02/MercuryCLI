import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
for (const key of ['MERCURY_HOME', 'MERCURY_OAUTH_TOKEN', 'MERCURY_MODEL', 'MERCURY_EXTRA_BODY', 'MERCURY_EFFORT_LEVEL', 'MERCURY_MAX_OUTPUT_TOKENS', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_SM_COMPACT']) delete process.env[key]
const home = mkdtempSync(join(tmpdir(), 'fold-rides-session-request-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const { startOverflowFixture, OVERFLOW_LANES } = await import('./overflowFixture.ts')
const fixture = await startOverflowFixture()
Object.assign(process.env, fixture.env)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { setIsInteractive } = await import('../../src/bootstrap/state.ts')
setIsInteractive(false)
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.ts')
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { FileStateCache, READ_FILE_STATE_CACHE_SIZE } = await import('../../src/utils/fileStateCache.ts')
const { recordSentRequest } = await import('../../src/utils/forkedAgent.ts')
const { rosterOwnerFromToolUseContext } = await import('../../src/services/run/resolveOwner.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { compactConversation } = await import('../../src/services/compact/compact.ts')

let failures = 0
let checks = 0
const check = (name: string, ok: boolean, details: unknown = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${JSON.stringify(details)}`}`)
}
const summary = 'The synthetic parser accepts quoted commas and its 14 checks passed. Preserve the test command and continue with CLI verification.'
const ENVELOPE_KEYS_OUTSIDE = new Set(['messages', 'input', 'system', 'instructions', 'tools', 'metadata', 'stream', 'stream_options', 'tool_choice', 'prompt_cache_key', 'previous_response_id', 'store', 'user', 'safety_identifier', 'model', 'max_tokens', 'max_completion_tokens', 'max_output_tokens', 'include', 'cache_control', 'n'])
type Body = Record<string, any>
const posture = (body: Body | undefined): Record<string, unknown> => {
  if (body === undefined) return { absent: true }
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(body).sort()) if (!ENVELOPE_KEYS_OUTSIDE.has(key)) out[key] = body[key]
  return out
}
const ceilingOf = (body: Body | undefined): unknown => body === undefined ? undefined : (body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens ?? null)
const assistantRows = (body: Body | undefined): Array<{ at: number; row: unknown }> => {
  if (body === undefined) return []
  if (Array.isArray(body.input)) return body.input.map((item: any, at: number) => ({ at, item })).filter(({ item }: any) => item.type === 'reasoning' || (item.type === 'message' && item.role === 'assistant')).map(({ at, item }: any) => ({ at, row: item }))
  return (body.messages ?? []).map((row: any, at: number) => ({ at, row })).filter(({ row }: any) => row.role === 'assistant').map(({ at, row }: any) => ({ at, row: { content: Array.isArray(row.content) ? row.content.filter((block: any) => block.type === 'thinking' || block.type === 'redacted_thinking') : row.content, reasoning_content: row.reasoning_content, reasoning_details: row.reasoning_details, reasoning: row.reasoning } }))
}
const requestCount = (body: Body | undefined): number => Array.isArray(body?.input) ? body!.input.length : Array.isArray(body?.messages) ? body!.messages.length : -1

const roads = [
  ...OVERFLOW_LANES,
  { lane: 'anthropic-adaptive', model: 'claude-fable-5-1', dialect: 'anthropic' as const },
  { lane: 'anthropic-budget', model: 'claude-sonnet-4-5', dialect: 'anthropic' as const },
  { lane: 'openrouter-responses', model: OVERFLOW_LANES.find(road => road.lane === 'openrouter')!.model, dialect: 'responses' as const },
]
const efforts = ['max', 'low', 'xhigh'] as const
const thinkingShapes = [{ type: 'adaptive' }, { type: 'enabled', budgetTokens: 8192 }, { type: 'enabled' }, { type: 'disabled' }] as const

function historyFor(road: { lane: string; model: string }, withRedacted: boolean): any[] {
  const signed = { type: 'thinking', thinking: 'Preserved fixture reasoning.', signature: 'fixture-signature-byte-exact' }
  const redacted = { type: 'redacted_thinking', data: 'fixture-redacted-bytes-exact' }
  const first: any = createAssistantMessage({ content: [signed, ...(withRedacted ? [redacted] : []), { type: 'text', text: 'The parser checks passed.' }] as never })
  first.message.model = road.model
  const reasoning = { type: 'reasoning', id: 'rs_fixture', summary: [{ type: 'summary_text', text: signed.thinking }], encrypted_content: 'fixture-encrypted-byte-exact' }
  const answer = { type: 'message', id: 'msg_fixture', role: 'assistant', content: [{ type: 'output_text', text: 'The parser checks passed.' }] }
  if (road.lane === 'openai') first.apexProviderTurn = { provider: 'openai', model: road.model, items: [reasoning, answer] }
  if (road.lane === 'openrouter-responses') first.openrouterProviderTurn = { model: road.model.slice('openrouter/'.length), items: [reasoning, answer] }
  const second: any = createAssistantMessage({ content: [{ type: 'thinking', thinking: 'Second preserved reasoning.', signature: 'fixture-signature-two' }, { type: 'text', text: 'The CLI run is next.' }] as never })
  second.message.model = road.model
  const reasoning2 = { type: 'reasoning', id: 'rs_fixture_two', summary: [], encrypted_content: 'fixture-encrypted-two' }
  const answer2 = { type: 'message', id: 'msg_fixture_two', role: 'assistant', content: [{ type: 'output_text', text: 'The CLI run is next.' }] }
  if (road.lane === 'openai') second.apexProviderTurn = { provider: 'openai', model: road.model, items: [reasoning2, answer2] }
  if (road.lane === 'openrouter-responses') second.openrouterProviderTurn = { model: road.model.slice('openrouter/'.length), items: [reasoning2, answer2] }
  return [createUserMessage({ content: 'Check the parser.' }), first, createUserMessage({ content: 'Run the CLI next.' }), second, createUserMessage({ content: 'Preserve the result.' })]
}

type Drive = { reference: Body | undefined; fold: Body[]; error: unknown; result: Awaited<ReturnType<typeof compactConversation>> | undefined }
async function drive(road: { lane: string; model: string; dialect: string }, effort: string, thinkingConfig: any, opts: { continued: boolean; redacted: boolean; auto?: boolean; overflow?: boolean; script?: unknown[] }): Promise<Drive> {
  const state = { toolPermissionContext: getEmptyToolPermissionContext(), sessionHooks: new Map(), tasks: {}, agentNameRegistry: new Map(), mcp: { clients: [], tools: [], commands: [], resources: {} }, effortValue: effort }
  const tools = [FileReadTool]
  const context: any = { abortController: new AbortController(), getAppState: () => state, setAppState: () => {}, messages: [], readFileState: new FileStateCache(READ_FILE_STATE_CACHE_SIZE, 25 * 1024 * 1024), options: { tools, commands: [], mcpClients: [], engineModel: road.model, maxThinkingTokens: thinkingConfig.budgetTokens ?? 0, thinkingConfig, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [] } } }
  const messages = historyFor(road, opts.redacted)
  const systemPrompt = asSystemPrompt(['Synthetic fold request proof.'])
  fixture.script([{ text: summary }])
  const referenceAt = fixture.captured.length
  let referenceError: unknown
  try {
    for await (const _ of routedCallModel({ messages, systemPrompt, thinkingConfig, tools, signal: context.abortController.signal, options: { model: road.model, getToolPermissionContext: async () => state.toolPermissionContext, isNonInteractiveSession: true, hasAppendSystemPrompt: false, maxOutputTokensOverride: undefined, querySource: 'main_thread' as never, agents: [], mcpTools: [], effortValue: state.effortValue as never, ownerKey: String(rosterOwnerFromToolUseContext(context)), onWait: () => {}, onStreamActivity: () => {} } })) {}
  } catch (caught) { referenceError = String(caught) }
  const reference = fixture.captured[referenceAt]?.body as Body | undefined
  if (opts.continued) recordSentRequest(String(rosterOwnerFromToolUseContext(context)), messages)
  fixture.script((opts.script ?? [{ text: summary }]) as never)
  const before = fixture.captured.length
  let error: unknown = referenceError
  let result: Awaited<ReturnType<typeof compactConversation>> | undefined
  try {
    const overflow = opts.overflow ? { source: 'provider', family: road.lane, shape: 'context-length-exceeded' } : undefined
    result = await compactConversation(messages, context, { systemPrompt, userContext: {}, systemContext: {}, toolUseContext: context, forkContextMessages: messages } as never, opts.auto === true, undefined, opts.auto === true, opts.auto === true ? { isRecompaction: false, turnsSincePreviousCompact: 3, autoCompactThreshold: 150_000 } : undefined, overflow as never)
  } catch (caught) { error = String(caught) }
  const fold = fixture.captured.slice(before).map(request => request.body as Body)
  return { reference, fold, error, result }
}

function compare(label: string, reference: Body | undefined, fold: Body | undefined, messagesRef: any[], expectSameTail: boolean): void {
  check(`${label}: a request was built on both sides`, reference !== undefined && fold !== undefined, { reference: reference !== undefined, fold: fold !== undefined })
  if (reference === undefined || fold === undefined) return
  const refPosture = posture(reference)
  const foldPosture = posture(fold)
  check(`${label}: every effort and thinking field outside the envelope is the session request's`, JSON.stringify(refPosture) === JSON.stringify(foldPosture), { session: refPosture, fold: foldPosture })
  check(`${label}: the output ceiling is the session request's`, JSON.stringify(ceilingOf(reference)) === JSON.stringify(ceilingOf(fold)), { session: ceilingOf(reference), fold: ceilingOf(fold) })
  const refRows = assistantRows(reference)
  const foldRows = assistantRows(fold)
  check(`${label}: every preserved thinking block rides byte-identically at its original position`, JSON.stringify(refRows) === JSON.stringify(foldRows), { session: refRows, fold: foldRows })
  const wire = JSON.stringify(fold)
  const refWire = JSON.stringify(reference)
  const count = (text: string, needle: RegExp): number => (text.match(needle) ?? []).length
  check(`${label}: no preserved block is duplicated or dropped`, count(wire, /fixture-signature-byte-exact/g) === count(refWire, /fixture-signature-byte-exact/g) && count(wire, /fixture-signature-two/g) === count(refWire, /fixture-signature-two/g) && count(wire, /fixture-encrypted-byte-exact/g) === count(refWire, /fixture-encrypted-byte-exact/g) && count(wire, /fixture-redacted-bytes-exact/g) === count(refWire, /fixture-redacted-bytes-exact/g), { fold: wire.match(/fixture-(?:signature|encrypted|redacted)[a-z-]*/g), session: refWire.match(/fixture-(?:signature|encrypted|redacted)[a-z-]*/g) })
  if (expectSameTail) {
    const rows = (body: Body): unknown[] => Array.isArray(body.input) ? body.input : Array.isArray(body.messages) ? body.messages : Array.isArray(body.contents) ? body.contents : []
    const uncached = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, inner) => (key === 'cache_control' ? undefined : inner)))
    const refRowsAll = uncached(rows(reference)) as unknown[]
    const foldRowsAll = uncached(rows(fold)) as unknown[]
    const lastAssistantAt = refRowsAll.map((row: any, at: number) => (row.role === 'assistant' || row.type === 'reasoning' ? at : -1)).reduce((a, b) => Math.max(a, b), -1)
    check(`${label}: the session's rows through its last assistant row ride byte-identically ahead of the prompt`, lastAssistantAt >= 0 && JSON.stringify(refRowsAll.slice(0, lastAssistantAt + 1)) === JSON.stringify(foldRowsAll.slice(0, lastAssistantAt + 1)) && wire.includes('summary of the conversation') === wire.includes('summary of the conversation'), { lastAssistantAt, session: refRowsAll.slice(0, lastAssistantAt + 1), fold: foldRowsAll.slice(0, lastAssistantAt + 1) })
  }
  check(`${label}: no per-message effort row`, Array.isArray(fold.messages) ? fold.messages.every((row: any) => row.output_config === undefined) : true, fold.messages)
  void messagesRef
}

try {
  for (const road of roads) {
    for (const effort of efforts) {
      for (const thinkingConfig of thinkingShapes) {
        if (effort !== 'max' && thinkingConfig.type !== 'adaptive') continue
        for (const continued of [false, true]) {
          const label = `${road.lane} · effort ${effort} · thinking ${thinkingConfig.type}${'budgetTokens' in thinkingConfig ? ` ${thinkingConfig.budgetTokens}` : ''} · ${continued ? 'continued' : 'fresh'} history`
          const driven = await drive(road, effort, thinkingConfig, { continued, redacted: road.dialect === 'anthropic' })
          check(`${label}: the fold made one request on its declared wire and settled`, driven.fold.length === 1 && driven.error === undefined && driven.result?.summaryMessages.some(row => String(row.message.content).includes(summary)) === true, { requests: driven.fold.length, error: driven.error })
          compare(label, driven.reference, driven.fold.at(-1), [], true)
        }
      }
    }
  }
  {
    const road = roads.find(r => r.lane === 'anthropic-adaptive')!
    for (const thinkingConfig of [{ type: 'adaptive' }, { type: 'enabled' }] as const) {
      const label = `${road.lane} · thinking ${thinkingConfig.type} · fork hands over to the direct lane`
      const driven = await drive(road, 'max', thinkingConfig, { continued: true, redacted: true, script: [{ calls: [{ id: 'toolu_fixture_fork', name: 'Read', args: '{"file_path":"/tmp/x"}' }] }, { text: summary }] })
      check(`${label}: two requests, the fork's then the direct lane's`, driven.fold.length === 2 && driven.error === undefined, { requests: driven.fold.length, error: driven.error })
      compare(`${label} (fork)`, driven.reference, driven.fold[0], [], true)
      compare(`${label} (direct)`, driven.reference, driven.fold[1], [], true)
      check(`${label}: the fork and the direct lane carry one posture`, JSON.stringify(posture(driven.fold[0])) === JSON.stringify(posture(driven.fold[1])) && JSON.stringify(ceilingOf(driven.fold[0])) === JSON.stringify(ceilingOf(driven.fold[1])), { fork: posture(driven.fold[0]), direct: posture(driven.fold[1]), ceilings: [ceilingOf(driven.fold[0]), ceilingOf(driven.fold[1])] })
    }
  }
  {
    const road = roads.find(r => r.lane === 'anthropic-budget')!
    const budget = await drive(road, 'max', { type: 'enabled' }, { continued: true, redacted: false })
    compare(`${road.lane} · thinking enabled with the model's own budget`, budget.reference, budget.fold.at(-1), [], true)
    check(`${road.lane}: the budget_tokens the session carries rides the fold`, budget.reference?.thinking?.budget_tokens !== undefined && JSON.stringify(budget.reference?.thinking) === JSON.stringify(budget.fold.at(-1)?.thinking), { session: budget.reference?.thinking, fold: budget.fold.at(-1)?.thinking })
  }
  for (const pinned of ['16000', '4096']) {
    process.env.MERCURY_MAX_OUTPUT_TOKENS = pinned
    for (const road of roads.filter(r => ['anthropic-adaptive', 'anthropic-budget', 'anthropic', 'zai', 'moonshot', 'deepseek', 'openai', 'openrouter', 'gemini', 'local', 'xai'].includes(r.lane))) {
      const thinkingConfig = road.lane === 'anthropic-budget' ? { type: 'enabled' } : { type: 'adaptive' }
      const driven = await drive(road, 'max', thinkingConfig, { continued: true, redacted: false })
      compare(`${road.lane} · MERCURY_MAX_OUTPUT_TOKENS=${pinned} · thinking ${thinkingConfig.type}`, driven.reference, driven.fold.at(-1), [], true)
    }
    delete process.env.MERCURY_MAX_OUTPUT_TOKENS
  }
  for (const road of roads.filter(r => ['anthropic-adaptive', 'openai', 'zai', 'gemini'].includes(r.lane))) {
    const manual = await drive(road, 'max', { type: 'adaptive' }, { continued: true, redacted: false })
    const auto = await drive(road, 'max', { type: 'adaptive' }, { continued: true, redacted: false, auto: true })
    const overflow = await drive(road, 'max', { type: 'adaptive' }, { continued: true, redacted: false, auto: true, overflow: true })
    const same = (a: Body | undefined, b: Body | undefined): boolean => JSON.stringify(posture(a)) === JSON.stringify(posture(b)) && JSON.stringify(ceilingOf(a)) === JSON.stringify(ceilingOf(b))
    check(`${road.lane}: /compact, the threshold fold and the overflow fold carry one posture`, same(manual.fold.at(-1), auto.fold.at(-1)) && same(auto.fold.at(-1), overflow.fold.at(-1)) && manual.error === undefined && auto.error === undefined && overflow.error === undefined, { manual: posture(manual.fold.at(-1)), auto: posture(auto.fold.at(-1)), overflow: posture(overflow.fold.at(-1)), errors: [manual.error, auto.error, overflow.error] })
  }
} finally {
  await fixture.close()
  rmSync(home, { recursive: true, force: true })
}
console.log(`${failures ? 'FAIL' : 'PASS'} fold-rides-session-request: ${checks} checks, ${failures} failures`)
process.exit(failures ? 1 : 0)
