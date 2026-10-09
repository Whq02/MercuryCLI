import { strict as assert } from 'node:assert'

export const MISTRAL_FIXTURE_API_KEY = 'proof-key-mistral-inference-fixture-not-a-real-key'
export const MISTRAL_FIXTURE_ADMIN_KEY = 'proof-key-mistral-admin-fixture-not-a-real-key'
export const MISTRAL_FIXTURE_NOW = Date.UTC(2026, 9, 9, 8, 15, 0)

export const MISTRAL_FIXTURE_MODELS = [
  { id: 'mistral-large-4', object: 'model', created: 1_759_708_800, owned_by: 'mistralai', name: 'mistral-large-4', max_context_length: 1_048_576, aliases: ['mistral-large-4-0'], capabilities: { completion_chat: true, function_calling: true, vision: true, reasoning: true, completion_fim: false } },
  { id: 'mistral-medium-3-5', object: 'model', created: 1_745_798_400, owned_by: 'mistralai', max_context_length: 262_144, aliases: ['mistral-medium-latest', 'mistral-medium-3'], capabilities: { completion_chat: true, function_calling: true, vision: true, reasoning: true } },
  { id: 'mistral-small-2603', object: 'model', created: 1_742_083_200, owned_by: 'mistralai', max_context_length: 262_144, aliases: ['mistral-small-latest'], capabilities: { completion_chat: true, function_calling: true, vision: true, reasoning: true } },
  { id: 'mistral-large-2512', object: 'model', created: 1_764_633_600, owned_by: 'mistralai', max_context_length: 262_144, aliases: ['mistral-large-latest'], capabilities: { completion_chat: true, function_calling: true, vision: true, reasoning: false } },
  { id: 'codestral-2508', object: 'model', created: 1_753_833_600, owned_by: 'mistralai', max_context_length: 131_072, aliases: ['codestral-latest'], capabilities: { completion_chat: true, function_calling: true, vision: false, reasoning: false, completion_fim: true } },
  { id: 'mistral-embed', object: 'model', created: 1_702_339_200, owned_by: 'mistralai', max_context_length: 8_192, aliases: [], capabilities: { completion_chat: false, function_calling: false, vision: false, reasoning: false } },
  { id: 'mistral-ocr-2505', object: 'model', created: 1_747_612_800, owned_by: 'mistralai', max_context_length: 16_384, aliases: ['mistral-ocr-latest'], capabilities: { completion_chat: false, ocr: true } },
  { id: 'devstral-2512', object: 'model', created: 1_765_238_400, owned_by: 'mistralai', max_context_length: 262_144, aliases: ['devstral-latest'], deprecation: '2026-05-22T00:00:00Z', capabilities: { completion_chat: true, function_calling: true, vision: false, reasoning: false } },
  { id: 'zai-glm-5-3', object: 'model', created: 1_757_894_400, owned_by: 'zai', max_context_length: 1_048_576, aliases: ['zai-glm-latest'], capabilities: { completion_chat: true, function_calling: true, vision: false, reasoning: true } },
]

export const MISTRAL_FIXTURE_IDENTITY = {
  id: 'user-fixture-0001', email: 'fixture@example.invalid', first_name: 'Fixture', last_name: 'Operator',
  workspace: { id: 'ws-fixture', name: 'Fixture workspace' }, organization: { id: 'org-fixture', name: 'Fixture org' },
}

export function mistralFixture() {
  const requests: Array<{ path: string; method: string; headers: Record<string, string>; body?: Record<string, any> }> = []
  const state = {
    modelsStatus: 200,
    models: MISTRAL_FIXTURE_MODELS as unknown[],
    identityStatus: 200,
    adminStatus: 200,
    adminMalformed: false,
    rateLimitStatus: 200,
    usage: 42.5 as number | null,
    vibeUsage: 2.5 as number | null,
    totalUsage: 45 as number | null,
    usageLimit: 500 as number | null,
    monthlyLimitReached: false,
    noMonthlyLimit: false,
    lastPaymentFailure: false,
    currency: 'EUR',
    requestsPerSecond: 6,
    hold: undefined as Promise<void> | undefined,
    hitAdmin: undefined as (() => void) | undefined,
  }
  const keyOf = (req: Request): string | undefined => {
    const bearer = req.headers.get('authorization')
    if (bearer?.startsWith('Bearer ')) return bearer.slice('Bearer '.length)
    return req.headers.get('x-api-key') ?? undefined
  }
  const refusal = (status: number, message: string, type = 'authentication_error'): Response =>
    Response.json({ object: 'error', message, type, param: null, code: status === 401 ? 'invalid_api_key' : 'forbidden' }, { status })
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const path = url.pathname
      const record: (typeof requests)[number] = { path, method: req.method, headers: Object.fromEntries(req.headers.entries()) }
      requests.push(record)
      const key = keyOf(req)
      if (path === '/v1/models') {
        assert.equal(req.method, 'GET')
        if (state.modelsStatus !== 200) return refusal(state.modelsStatus, 'Unauthorized')
        if (key !== MISTRAL_FIXTURE_API_KEY) return refusal(401, 'Unauthorized')
        return Response.json({ object: 'list', data: state.models })
      }
      if (path === '/v1/users/me') {
        assert.equal(req.method, 'GET')
        if (state.identityStatus !== 200) return refusal(state.identityStatus, 'Unauthorized')
        if (key !== MISTRAL_FIXTURE_API_KEY) return refusal(401, 'Unauthorized')
        return Response.json(MISTRAL_FIXTURE_IDENTITY)
      }
      if (path.startsWith('/v1/admin/')) {
        assert.equal(req.method, 'GET')
        if (key === MISTRAL_FIXTURE_API_KEY) return refusal(401, 'Standard workspace/inference API keys are rejected')
        if (key !== MISTRAL_FIXTURE_ADMIN_KEY) return refusal(401, 'Unauthorized')
        if (path === '/v1/admin/spend-limit') {
          state.hitAdmin?.()
          await state.hold
          if (state.adminStatus !== 200) return refusal(state.adminStatus, 'fixture refusal')
          if (state.adminMalformed) return Response.json({ nothing: true })
          return Response.json({ limits: {
            completion: { no_monthly_limit: state.noMonthlyLimit, monthly_limit_reached: state.monthlyLimitReached, usage: state.usage, vibe_usage: state.vibeUsage, total_usage: state.totalUsage, usage_limit: state.usageLimit },
            last_payment_failure: state.lastPaymentFailure, last_payment_failure_protection: null, currency: state.currency,
          } })
        }
        if (path === '/v1/admin/rate-limit') {
          if (state.rateLimitStatus !== 200) return refusal(state.rateLimitStatus, 'fixture refusal')
          return Response.json({ requests_per_second: state.requestsPerSecond, tokens_limits_by_model: { 'mistral-large-4': { tokens_per_minute: 2_000_000, tokens_per_month: 10_000_000_000 } } })
        }
        return new Response('undocumented path', { status: 404 })
      }
      return new Response('undocumented path', { status: 404 })
    },
  })
  const base = `http://127.0.0.1:${server.port}/v1`
  const env = { MISTRAL_API_KEY: MISTRAL_FIXTURE_API_KEY, MISTRAL_ADMIN_API_KEY: MISTRAL_FIXTURE_ADMIN_KEY, MERCURY_MISTRAL_API_BASE: base }
  return { base, env, state, requests, stop: () => server.stop(true) }
}
