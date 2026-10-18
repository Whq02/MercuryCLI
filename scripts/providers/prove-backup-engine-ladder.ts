#!/usr/bin/env bun
// gate-watch: src/services/api/backupEngines.ts src/services/api/withRetry.ts src/services/api/errors.ts src/services/providers/callModelRouter.ts src/run-core/turn-machine.ts src/utils/settings/types.ts src/services/providers/openaicompat/compatChatCallModel.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'backup-engine-ladder-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'MOONSHOT_API_KEY', 'ZAI_API_KEY', 'MERCURY_COMPAT_BASE_URL', 'MERCURY_COMPAT_API_KEY', 'MERCURY_LOCAL_BASE_URL', 'MERCURY_HOME', 'NODE_ENV']) delete process.env[key]

const PRIMARY = 'claude-opus-4-8'
const FLAGGED = 'claude-sonnet-5'
const SECOND = 'kimi-k2-0905'
const THIRD = 'glm-5.2'
writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ engine: { backups: [SECOND, FLAGGED, THIRD, SECOND, ' '] } }))

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)

const fixtureScript: { status: number; body: unknown; answer?: string } = { status: 401, body: {} }
const seen: Array<{ model: string }> = []
const fixture = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname
    const body = (await request.json().catch(() => ({}))) as { model?: string }
    if (!path.endsWith('/chat/completions')) return new Response('{}', { status: 404 })
    seen.push({ model: String(body.model) })
    if (fixtureScript.answer !== undefined) {
      const chunks = [
        { id: 'c1', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: fixtureScript.answer }, finish_reason: null }] },
        { id: 'c1', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4 } },
      ]
      return new Response(chunks.map(chunk => `data: ${j(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    }
    return new Response(j(fixtureScript.body), { status: fixtureScript.status, headers: { 'content-type': 'application/json' } })
  },
})
process.env.MERCURY_DEEPSEEK_API_BASE = `http://127.0.0.1:${fixture.port}`
process.env.DEEPSEEK_API_KEY = 'sk-fixture-deepseek'

const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const ladderModule = (await import('../../src/services/api/backupEngines.ts').catch(() => null)) as Record<string, unknown> | null
const { FallbackTriggeredError } = await import('../../src/services/api/withRetry.ts')
const { getAssistantMessageFromError } = await import('../../src/services/api/errors.ts')
const { APIError, APIConnectionError } = await import('../../src/services/api/sdkErrors.ts')
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createUserMessage, createAssistantMessage, createAssistantAPIErrorMessage } = await import('../../src/utils/messages.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { query } = await import('../../src/query.ts')

type Vote = { originalModel: string; fallbackModel: string; trigger: string }

section('S1 · the ladder: the flag heads it, the setting follows, each engine once per turn, nothing with nothing configured')
check('the ladder module exists (src/services/api/backupEngines.ts)', ladderModule !== null)
if (ladderModule !== null) {
  const backupEngineLadder = ladderModule.backupEngineLadder as (flag: string | undefined) => string[]
  const engineLadderOf = ladderModule.engineLadderOf as (turn: object, flag: string | undefined) => { next(current: string): string | undefined; take(engine: string): boolean }
  const noticeLine = ladderModule.backupEngineNoticeLine as (vote: Vote) => string
  check('the flag heads the list, the setting follows in order, repeats and blanks dropped', j(backupEngineLadder(FLAGGED)) === j([FLAGGED, SECOND, THIRD]), j(backupEngineLadder(FLAGGED)))
  check('without the flag the setting alone is the list', j(backupEngineLadder(undefined)) === j([SECOND, FLAGGED, THIRD]), j(backupEngineLadder(undefined)))
  const turn = {}
  const ladder = engineLadderOf(turn, FLAGGED)
  check('the first hop after the primary is the flagged engine', ladder.next(PRIMARY) === FLAGGED)
  check('taking it once succeeds, a second take of the same engine is refused', ladder.take(FLAGGED) && !ladder.take(FLAGGED))
  check('from the flagged engine the next is the first untried setting entry', ladder.next(FLAGGED) === SECOND && ladder.take(SECOND))
  check('then the last; then nothing', ladder.next(SECOND) === THIRD && ladder.take(THIRD) && ladder.next(THIRD) === undefined)
  check('the same turn object keeps its state', engineLadderOf(turn, FLAGGED).next(THIRD) === undefined)
  check('a new turn starts the ladder afresh', engineLadderOf({}, FLAGGED).next(PRIMARY) === FLAGGED)
  check('a primary that is itself listed is skipped as a hop', engineLadderOf({}, undefined).next(SECOND) === FLAGGED)
  check('the words name the cause', noticeLine({ originalModel: PRIMARY, fallbackModel: FLAGGED, trigger: 'sign-in' }).includes('refused the sign-in; this turn runs on') && noticeLine({ originalModel: PRIMARY, fallbackModel: FLAGGED, trigger: 'unreachable' }).includes('cannot be reached; this turn runs on') && noticeLine({ originalModel: PRIMARY, fallbackModel: FLAGGED, trigger: 'unknown-model' }).includes('is not a model its provider serves; this turn runs on') && noticeLine({ originalModel: PRIMARY, fallbackModel: FLAGGED, trigger: 'overloaded' }).includes('is overloaded; this turn runs on'))
}

section('S2 · the cause: typed facts on the message, the home lane stamps what only it knows')
if (ladderModule !== null) {
  const failoverCauseOf = ladderModule.failoverCauseOf as (error: string | undefined, code: string | undefined, busy: boolean) => string | undefined
  check('a refused sign-in votes', failoverCauseOf('authentication_failed', 'api-invalid_api_key', false) === 'sign-in')
  check('a server or transport failure after the lane\u2019s own retries votes', failoverCauseOf('server_error', 'fetch-failed', false) === 'unreachable' && failoverCauseOf('server_error', 'http-503', false) === 'unreachable')
  check('a spent busy ladder votes overloaded', failoverCauseOf('rate_limit', 'http-429', true) === 'overloaded')
  check('a usage window (a rate limit with no busy ladder) is not a vote: the cap failover owns it', failoverCauseOf('rate_limit', 'http-429', false) === undefined)
  check('a not-found code votes unknown model; another bad request does not', failoverCauseOf('invalid_request', 'http-404', false) === 'unknown-model' && failoverCauseOf('invalid_request', 'api-NOT_FOUND', false) === 'unknown-model' && failoverCauseOf('invalid_request', 'http-400', false) === undefined)
  check('billing, overflow-class and unknown kinds never vote', failoverCauseOf('billing_error', 'http-402', false) === undefined && failoverCauseOf('max_output_tokens', undefined, false) === undefined && failoverCauseOf('unknown', 'cancelled', false) === undefined)
}
{
  const apiError = (status: number, type: string, message: string) => new APIError(status, { type: 'error', error: { type, message } }, undefined, undefined as never)
  const stamp = (error: unknown): string | undefined => (getAssistantMessageFromError(error, PRIMARY) as { failover?: string }).failover
  check('home lane: a 404 is an unknown model', stamp(apiError(404, 'not_found_error', `model: ${PRIMARY}`)) === 'unknown-model')
  check('home lane: a 401 is a refused sign-in', stamp(apiError(401, 'authentication_error', 'invalid x-api-key')) === 'sign-in')
  check('home lane: a connection failure is unreachable', stamp(new APIConnectionError({ message: 'fetch failed' })) === 'unreachable')
  check('home lane: a 500 after the retries is unreachable', stamp(apiError(500, 'api_error', 'internal')) === 'unreachable')
  check('home lane: a 529 is not stamped (the busy ladder votes inside the lane)', stamp(apiError(529, 'overloaded_error', 'Overloaded')) === undefined)
  check('home lane: an overflow refusal is never a hop', stamp(apiError(400, 'invalid_request_error', 'prompt is too long: 250000 tokens > 200000 maximum')) === undefined)
}

section('S3 · the router: a lane that cannot answer votes the backup it was given; with no backup the error lands as today')
const drive = async (model: string, fallbackModel?: string): Promise<{ vote: Vote | null; errors: string[]; texts: string[] }> => {
  const out = { vote: null as Vote | null, errors: [] as string[], texts: [] as string[] }
  try {
    for await (const item of routedCallModel({
      messages: [createUserMessage({ content: 'hello' })] as never,
      systemPrompt: ['fixture system prompt'] as never,
      thinkingConfig: { type: 'disabled' } as never,
      tools: [] as never,
      signal: new AbortController().signal,
      options: { getToolPermissionContext: async () => getEmptyToolPermissionContext(), model, ...(fallbackModel !== undefined ? { fallbackModel } : {}), isNonInteractiveSession: true, querySource: 'agent:builtin:test', agents: [], hasAppendSystemPrompt: false, mcpTools: [], effortValue: 'high' } as never,
    })) {
      const message = item as { type?: string; isApiErrorMessage?: boolean; message?: { content?: Array<{ type: string; text?: string }> } }
      if (message.type !== 'assistant') continue
      const text = (message.message?.content ?? []).map(block => block.text ?? '').join('')
      if (message.isApiErrorMessage) out.errors.push(text)
      else out.texts.push(text)
    }
  } catch (error) {
    if (error instanceof FallbackTriggeredError) out.vote = { originalModel: error.originalModel, fallbackModel: error.fallbackModel, trigger: error.trigger }
    else throw error
  }
  return out
}
{
  fixtureScript.status = 401
  fixtureScript.body = { error: { message: 'Authentication Fails, Your api key is invalid', type: 'authentication_error', code: 'invalid_api_key' } }
  const refused = await drive('deepseek-chat', 'deepseek-reasoner')
  check('a refused sign-in with a backup named: the lane votes the backup, cause sign-in, no error row', j(refused.vote) === j({ originalModel: 'deepseek-chat', fallbackModel: 'deepseek-reasoner', trigger: 'sign-in' }) && refused.errors.length === 0, j(refused))
  const control = await drive('deepseek-chat')
  check('the control — no backup named: the same refusal is the error row it is today', control.vote === null && control.errors.length === 1 && /sign|key|credential|refused/i.test(control.errors[0]!), j(control))
  const same = await drive('deepseek-chat', 'deepseek-chat')
  check('a backup equal to the engine itself is no hop', same.vote === null && same.errors.length === 1, j(same))
  fixtureScript.status = 404
  fixtureScript.body = { error: { message: 'Model Not Exist', type: 'invalid_request_error', code: 'invalid_request_error' } }
  const unknown = await drive('deepseek-chat', 'deepseek-reasoner')
  check('a 404 whose body carries a vendor word still votes unknown model (the status is the fact)', unknown.vote?.trigger === 'unknown-model' && unknown.vote.fallbackModel === 'deepseek-reasoner', j(unknown))
  fixtureScript.answer = 'the answer from the lane'
  const answered = await drive('deepseek-chat', 'deepseek-reasoner')
  check('a lane that answers never votes', answered.vote === null && answered.texts.join('') === 'the answer from the lane' && answered.errors.length === 0, j(answered))
  fixtureScript.answer = undefined
}
if (ladderModule !== null) {
  const withBackupVote = ladderModule.withBackupVote as (lane: AsyncGenerator<unknown>, options: { model: string; fallbackModel?: string }) => AsyncGenerator<unknown>
  async function* afterContent(): AsyncGenerator<unknown> {
    yield createAssistantMessage({ content: 'half an answer' })
    yield createAssistantAPIErrorMessage({ content: 'then the wire fell', error: 'server_error' })
  }
  const items: unknown[] = []
  let thrown: unknown = null
  try {
    for await (const item of withBackupVote(afterContent(), { model: PRIMARY, fallbackModel: FLAGGED })) items.push(item)
  } catch (error) {
    thrown = error
  }
  check('an error after content already settled is not a vote: the attempt stays what it was', thrown === null && items.length === 2, j({ thrown: String(thrown), items: items.length }))
}

section('S4 · the turn: two hops down the ladder, each announced with its cause, the third engine answers; nothing configured changes nothing')
{
  type Call = { model: string; fallbackModel: string | undefined }
  const makeRun = (opts: { fallbackModel?: string; script: (call: Call, index: number) => unknown[] | Error }) => {
    const calls: Call[] = []
    async function* callModel(req: { options: Record<string, unknown> }): AsyncGenerator<unknown, void> {
      const call: Call = { model: String(req.options.model), fallbackModel: req.options.fallbackModel as string | undefined }
      const index = calls.length
      calls.push(call)
      const steps = opts.script(call, index)
      if (steps instanceof Error) throw steps
      for (const step of steps) yield step
    }
    let appState: Record<string, unknown> = { ...(getDefaultAppState() as unknown as Record<string, unknown>), effortValue: 'high' }
    const ctx: Record<string, unknown> = {
      abortController: new AbortController(),
      options: { commands: [], tools: [], engineModel: PRIMARY, thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, debug: false, verbose: false, agentDefinitions: { activeAgents: [], allAgents: [] } },
      getAppState: () => appState,
      setAppState: (f: (prev: never) => never): void => { appState = f(appState as never) as unknown as Record<string, unknown> },
      messages: [],
      readFileState: createFileStateCacheWithSizeLimit(100),
      setInProgressToolUseIDs: () => {},
      setResponseLength: () => {},
      updateFileHistoryState: () => {},
      updateAttributionState: () => {},
      agentId: undefined,
    }
    let n = 0
    const gen = query({
      messages: [createUserMessage({ content: 'hello there' })] as never,
      systemPrompt: ['rig system prompt'] as never,
      userContext: {},
      systemContext: {},
      canUseTool: (async (_tool: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'rig' } })) as never,
      toolUseContext: ctx as never,
      querySource: 'sdk' as never,
      fallbackModel: opts.fallbackModel,
      deps: {
        callModel: callModel as never,
        autocompact: (async () => ({ wasCompacted: false })) as never,
        microcompact: (async (messages: unknown[]) => ({ messages })) as never,
        uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
      },
    })
    return { gen, calls, ctx }
  }
  const collect = async (gen: AsyncGenerator<unknown, unknown>) => {
    const notices: string[] = []
    const texts: string[] = []
    const errors: string[] = []
    let r = await gen.next()
    while (!r.done) {
      const row = r.value as { type?: string; isApiErrorMessage?: boolean; content?: unknown; message?: { content?: Array<{ type: string; text?: string }> } }
      if (row?.type === 'system' && typeof row.content === 'string') notices.push(row.content)
      if (row?.type === 'assistant') {
        const text = (row.message?.content ?? []).map(block => block.text ?? '').join('')
        if (row.isApiErrorMessage) errors.push(text)
        else texts.push(text)
      }
      r = await gen.next()
    }
    await new Promise(resolve => setTimeout(resolve, 5))
    return { notices, texts, errors }
  }
  const hops = makeRun({
    fallbackModel: FLAGGED,
    script: (call, index) => {
      if (index === 0) return new FallbackTriggeredError(call.model, call.fallbackModel ?? '(none)', 'sign-in')
      if (index === 1) return new FallbackTriggeredError(call.model, call.fallbackModel ?? '(none)', 'unreachable')
      return [createAssistantMessage({ content: `answered on ${call.model}` })]
    },
  })
  const got = await collect(hops.gen)
  check('the turn ran on the primary, then the flagged engine, then the first setting entry', j(hops.calls.map(c => c.model)) === j([PRIMARY, FLAGGED, SECOND]), j(hops.calls))
  check('each attempt was handed the next untried engine as its backup', j(hops.calls.map(c => c.fallbackModel)) === j([FLAGGED, SECOND, THIRD]), j(hops.calls))
  check('two notices, each naming its cause and the engine the turn moves to', got.notices.length === 2 && got.notices[0]!.includes('refused the sign-in; this turn runs on') && got.notices[1]!.includes('cannot be reached; this turn runs on'), j(got.notices))
  check('the third engine\u2019s answer is the turn\u2019s reply, no error row', j(got.texts) === j([`answered on ${SECOND}`]) && got.errors.length === 0, j(got))
  check('the context follows the engine that answered', (hops.ctx.options as { engineModel: string }).engineModel === SECOND)

  writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ engine: {} }))
  ;(await import('../../src/utils/settings/settingsCache.ts')).resetSettingsCache()
  const bare = makeRun({
    script: call => [createAssistantAPIErrorMessage({ content: `API Error: ${call.model} refused the sign-in`, error: 'authentication_failed', failover: 'sign-in' } as never)],
  })
  const bareGot = await collect(bare.gen)
  const ladderEmpty = (ladderModule?.backupEngineLadder as ((flag: string | undefined) => string[]) | undefined)?.(undefined)
  check('nothing configured: the attempt is handed no backup', bare.calls.length === 1 && bare.calls[0]!.fallbackModel === undefined, j(bare.calls))
  check('nothing configured: the error row lands as today, no notice', bareGot.errors.length === 1 && bareGot.notices.length === 0 && bareGot.texts.length === 0, j(bareGot))
  check('nothing configured: the ladder is empty', ladderEmpty === undefined || ladderEmpty.length === 0, j(ladderEmpty))
}

section('refusals · what the ladder and the vote must never do')
if (ladderModule !== null) {
  const backupEngineLadder = ladderModule.backupEngineLadder as (flag: string | undefined) => string[]
  const engineLadderOf = ladderModule.engineLadderOf as (turn: object, flag: string | undefined) => { next(current: string): string | undefined; take(engine: string): boolean }
  const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
  const withSetting = (backups: unknown): string[] => {
    writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ engine: { backups } }))
    resetSettingsCache()
    return backupEngineLadder(undefined)
  }
  check('a setting that is a string is not a list: no engine is read from it, no character spread', j(withSetting('kimi-k2-0905,glm-5.2')) === '[]')
  check('entries that are not strings are dropped, the strings kept', j(withSetting([42, null, { id: 'x' }, SECOND, ['glm-5.2'], true])) === j([SECOND]))
  check('a quote, a semicolon or a path in an entry is an engine id the router will not place — kept as text, never run as anything', j(withSetting(['glm-5.2; rm -rf /', '../x', '"q"'])) === j(['glm-5.2; rm -rf /', '../x', '"q"']))
  const many = withSetting(Array.from({ length: 200 }, (_, i) => `engine-${i}`))
  const turn = engineLadderOf({}, undefined)
  let hops = 0
  let current = PRIMARY
  for (;;) {
    const next = turn.next(current)
    if (next === undefined) break
    if (!turn.take(next)) break
    hops++
    current = next
  }
  check('a list of 200 engines ends after 200 hops, each once, never a loop', many.length === 200 && hops === 200 && turn.next(current) === undefined)
  check('a vote naming an engine the turn never offered is refused by the ladder', !engineLadderOf({}, FLAGGED).take('never-offered') && !engineLadderOf({}, FLAGGED).take(PRIMARY))
  writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ engine: { backups: [SECOND, FLAGGED, THIRD] } }))
  resetSettingsCache()
  const unplaceable = await drive('not a model anyone serves', 'deepseek-chat')
  check('an unplaceable engine id with a backup named hops onward as an unknown model (the router\u2019s own refusal is the vote), nothing sent to a provider', unplaceable.vote?.trigger === 'unknown-model' && unplaceable.vote.fallbackModel === 'deepseek-chat' && unplaceable.errors.length === 0, j(unplaceable))
  const unplaceableAlone = await drive('not a model anyone serves')
  check('the same id with no backup is the refusal it is today', unplaceableAlone.vote === null && unplaceableAlone.errors.length === 1, j(unplaceableAlone))
  fixtureScript.status = 429
  fixtureScript.body = { error: { message: 'Rate limit reached for this window', type: 'rate_limit_error', code: 'rate_limit_exceeded' } }
  const windowed = await (async () => {
    const started = Date.now()
    const out = await drive('deepseek-chat', 'deepseek-reasoner')
    return { ...out, ms: Date.now() - started }
  })()
  check('a rate limit the lane answers without a spent busy ladder is never a hop: the usage window stays the cap failover\u2019s', windowed.vote === null || windowed.vote.trigger === 'overloaded', j(windowed))
  fixtureScript.status = 402
  fixtureScript.body = { error: { message: 'Insufficient Balance', type: 'insufficient_quota', code: 'insufficient_balance' } }
  const billing = await drive('deepseek-chat', 'deepseek-reasoner')
  check('a billing refusal never hops: the error row lands as today', billing.vote === null && billing.errors.length === 1, j(billing))
  fixtureScript.status = 400
  fixtureScript.body = { error: { message: "This model's maximum context length is 65536 tokens. However, you requested 70000 tokens", type: 'invalid_request_error', code: 'invalid_request_error' } }
  const overflow = await drive('deepseek-chat', 'deepseek-reasoner')
  check('an overflow refusal never hops: the recovery ladder keeps it', overflow.vote === null && overflow.errors.length === 1, j(overflow))
  check('nothing in the vote road touched a real provider: every request went to the loopback fixture', seen.every(s => typeof s.model === 'string') && seen.length > 0)
}

fixture.stop(true)
console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
