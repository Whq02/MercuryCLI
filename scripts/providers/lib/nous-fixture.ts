export const NOUS_FIXTURE_API_KEY = 'sk-nous-fixture-not-a-real-key-0123456789'
export const NOUS_FIXTURE_NOW = Date.UTC(2026, 9, 9, 7, 30, 0)
export const NOUS_FIXTURE_FILLER_ROWS = 28

export const NOUS_FIXTURE_INVALID_KEY_MESSAGE = 'Your API key is invalid, blocked or out of funds. Please go visit the portal to sort that out: https://portal.nousresearch.com '
export const NOUS_FIXTURE_RETIRED_MESSAGE = 'This model has been retired. Please select a different model to continue!'
export const NOUS_FIXTURE_KEY_NOT_ACCOUNT = 'API key is not associated with a user account'

type Row = Record<string, unknown>

function row(id: string, extra: Row = {}): Row {
  return {
    id,
    canonical_slug: id,
    name: extra.name ?? id,
    created: extra.created ?? 1791000000,
    description: '',
    context_length: extra.context_length ?? 200000,
    architecture: { modality: 'text->text', input_modalities: extra.input_modalities ?? ['text'], output_modalities: ['text'], tokenizer: 'Other' },
    pricing: extra.pricing ?? { prompt: '0.0000030000', completion: '0.0000150000', input_cache_read: '0.0000003000' },
    top_provider: { context_length: extra.context_length ?? 200000, max_completion_tokens: extra.max_completion_tokens ?? null, is_moderated: false },
    per_request_limits: null,
    supported_parameters: extra.supported_parameters ?? ['max_tokens', 'stop', 'temperature', 'tool_choice', 'tools', 'top_p'],
    default_parameters: {},
    aliases: [id],
    ...(extra.reasoning !== undefined ? { reasoning: extra.reasoning } : {}),
  }
}

export function nousFixtureModels(): Row[] {
  const filler = Array.from({ length: NOUS_FIXTURE_FILLER_ROWS }, (_, i) => row(`fixture/filler-${String(i + 1).padStart(2, '0')}`, { created: 1790000000 - i }))
  return [
    row('stepfun/step-5-preview', { name: 'StepFun: Step 5 Preview', created: 1791462849, context_length: 1000000, max_completion_tokens: 64000, supported_parameters: ['max_tokens', 'reasoning', 'reasoning_effort', 'tools', 'tool_choice'], reasoning: { mandatory: true, supported_efforts: ['high', 'medium', 'low'], default_effort: 'medium' } }),
    row('anthropic/claude-sonnet-4.6', { name: 'Claude Sonnet 4.6', created: 1791300000, context_length: 1000000, supported_parameters: ['max_tokens', 'stop', 'temperature', 'tool_choice', 'tools', 'top_p'] }),
    row('anthropic/claude-sonnet-4.6:batch', { name: 'Claude Sonnet 4.6 (batch)', created: 1791300000, context_length: 1000000 }),
    row('openai/gpt-5.5-pro', { name: 'OpenAI: GPT-5.5 Pro', created: 1791200000, context_length: 1050000, max_completion_tokens: 128000, input_modalities: ['text', 'image'], supported_parameters: ['max_tokens', 'reasoning', 'reasoning_effort', 'tools', 'tool_choice'], reasoning: { mandatory: true, supported_efforts: ['xhigh', 'high', 'medium'], default_effort: 'medium' } }),
    row('~anthropic/claude-sonnet-latest', { name: 'Anthropic: Claude Sonnet Latest', created: 1789400000, context_length: 1000000, max_completion_tokens: 128000, input_modalities: ['text', 'image'], supported_parameters: ['max_tokens', 'reasoning', 'reasoning_effort', 'tools', 'tool_choice'], reasoning: { mandatory: false, supported_efforts: ['max', 'xhigh', 'high', 'medium', 'low'], default_effort: 'high' } }),
    row('deepseek/deepseek-v4-pro', { name: 'DeepSeek: DeepSeek V4 Pro 0423', created: 1791100000, context_length: 1048576, max_completion_tokens: 393216, supported_parameters: ['max_tokens', 'reasoning', 'tools', 'tool_choice'], reasoning: { mandatory: false, supported_efforts: ['xhigh', 'high'], default_effort: 'high' } }),
    row('fixture/chat-only', { name: 'Fixture: chat only', created: 1791050000, context_length: 32768, supported_parameters: ['max_tokens', 'temperature'] }),
    ...filler,
  ]
}

export function nousFixtureAccount(): Row {
  return {
    user: { id: 'user-fixture', email: 'fixture@example.invalid', privy_did: 'did:privy:fixture', account_tier: 'registered' },
    organisation: { id: 'org-fixture', slug: 'fixture-org', name: 'Fixture Org' },
    subscription: { plan: 'Plus', tier: 2, monthly_charge: 20, monthly_credits: 20, current_period_end: '2026-11-01T00:00:00.000Z', credits_remaining: 12.5, rollover_credits: 0 },
    paid_service_access: {
      allowed: true,
      paid_access: true,
      reason: null,
      organisation_id: 'org-fixture',
      has_active_subscription: true,
      active_subscription_is_paid: true,
      subscription_tier: 2,
      subscription_monthly_charge: 20,
      subscription_credits_remaining: 12.5,
      purchased_credits_remaining: 30,
      total_usable_credits: 42.5,
      member_spend_cap_exceeded: false,
      member_spend_cap_usd: 100,
      member_spend_usd: 7.25,
      member_spend_cap_remaining_usd: 92.75,
    },
    tool_access: { enabled: true, coverage: {} },
    account_tier: 'registered',
    managed_tools: true,
  }
}

export interface NousFixtureCapture {
  path: string
  method: string
  headers: Record<string, string>
  body?: Record<string, unknown>
}

export function nousFixture() {
  const requests: NousFixtureCapture[] = []
  const state = {
    accountStatus: 200 as number,
    accountBody: undefined as Row | undefined,
    modelsStatus: 200 as number,
    models: nousFixtureModels() as Row[],
    chatStatus: 200 as number,
    toolCall: false,
    reasoningText: 'weighing the fixture question',
    replyText: 'OK from the Portal fixture',
    hold: undefined as Promise<void> | undefined,
  }
  const sse = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const path = url.pathname
      const auth = req.headers.get('authorization')
      const capture: NousFixtureCapture = { path, method: req.method, headers: Object.fromEntries(req.headers.entries()) }
      if (req.method === 'POST') {
        try {
          capture.body = (await req.json()) as Record<string, unknown>
        } catch {
          capture.body = {}
        }
      }
      requests.push(capture)
      if (path === '/v1/models') {
        if (state.modelsStatus !== 200) return new Response('fixture models refusal', { status: state.modelsStatus })
        return Response.json({ data: state.models })
      }
      if (path === '/api/oauth/account') {
        if (auth !== `Bearer ${NOUS_FIXTURE_API_KEY}` || state.accountStatus === 401) {
          return Response.json({ error: 'invalid_token', error_description: NOUS_FIXTURE_KEY_NOT_ACCOUNT }, { status: 401 })
        }
        if (state.accountStatus !== 200) return new Response('fixture portal fault', { status: state.accountStatus })
        return Response.json(state.accountBody ?? nousFixtureAccount())
      }
      if (path === '/v1/chat/completions') {
        if (state.hold) await state.hold
        const body = capture.body ?? {}
        const model = typeof body.model === 'string' ? body.model : ''
        if (model === 'fixture/retired' || /hermes/i.test(model)) {
          return Response.json({ status: 404, message: NOUS_FIXTURE_RETIRED_MESSAGE }, { status: 404 })
        }
        if (!state.models.some(m => m.id === model)) {
          return Response.json({ status: 404, message: `Model '${model}' not found. The requested model does not exist in our configuration or OpenRouter catalog.` }, { status: 404 })
        }
        if (auth !== `Bearer ${NOUS_FIXTURE_API_KEY}` || state.chatStatus === 401) {
          return Response.json({ status: 401, message: NOUS_FIXTURE_INVALID_KEY_MESSAGE }, { status: 401 })
        }
        if (state.chatStatus !== 200) return Response.json({ status: state.chatStatus, message: 'fixture fault' }, { status: state.chatStatus })
        const id = `gen-${Math.floor(NOUS_FIXTURE_NOW / 1000)}-fixture${requests.length}`
        const head = { id, object: 'chat.completion.chunk', created: Math.floor(NOUS_FIXTURE_NOW / 1000), model, provider: 'Fixture' }
        const wantsTool = state.toolCall && Array.isArray(body.tools) && body.tools.length > 0
        const toolName = wantsTool ? ((body.tools as Array<{ function?: { name?: string } }>)[0]?.function?.name ?? 'FixtureRead') : undefined
        const chunks = [
          sse({ ...head, choices: [{ index: 0, delta: { role: 'assistant', reasoning: state.reasoningText }, finish_reason: null }] }),
          sse({ ...head, choices: [{ index: 0, delta: { content: state.replyText }, finish_reason: null }] }),
          ...(wantsTool
            ? [
                sse({ ...head, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_fixture_1', type: 'function', function: { name: toolName, arguments: '{"path":"' } }] }, finish_reason: null }] }),
                sse({ ...head, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'README.md"}' } }] }, finish_reason: null }] }),
                sse({ ...head, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
              ]
            : [sse({ ...head, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })]),
          sse({ ...head, choices: [], usage: { prompt_tokens: 120, completion_tokens: 18, total_tokens: 138, prompt_tokens_details: { cached_tokens: 100 }, cost: 0.00042 } }),
          'data: [DONE]\n\n',
        ]
        return new Response(chunks.join(''), { status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-expose-headers': 'X-Nous-Token-Sharing' } })
      }
      return new Response('undocumented path', { status: 404 })
    },
  })
  const base = `http://127.0.0.1:${server.port}`
  const env = { NOUS_API_KEY: NOUS_FIXTURE_API_KEY, MERCURY_NOUS_API_BASE: `${base}/v1`, MERCURY_NOUS_PORTAL_BASE: base }
  return { base, env, state, requests, stop: () => server.stop(true) }
}
