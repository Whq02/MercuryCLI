import { strict as assert } from 'node:assert'

export const XAI_GROK_PROXY_MODELS_REPLY = {
  object: 'list',
  data: [
    { id: 'grok-4.7', object: 'model', owned_by: 'xAI', model: 'grok-4.7', model_family: 'xai', name: 'Grok 4.7', description: 'fixture frontier model', context_window: 256000, context_windows: [256000, 1000000], auto_compact_threshold_percent: 80, system_prompt_label: 'Grok 4.7', api_backend: 'responses', reasoning_effort: 'high', supports_reasoning_effort: true, reasoning_efforts: [{ id: 'xhigh', value: 'xhigh', label: 'Extra High', description: 'fixture', default: false }, { id: 'high', value: 'high', label: 'High', description: 'fixture', default: true }, { id: 'low', value: 'low', label: 'Low', description: 'fixture', default: false }], supports_backend_search: true, compactions_remaining: 1, compaction_at_tokens: true },
    { id: 'grok-imagine-fixture', object: 'model', owned_by: 'xAI', model: 'grok-imagine-fixture', model_family: 'xai', name: 'Grok Imagine', api_backend: 'image' },
  ],
}

export const XAI_GROK_PROXY_BILLING_REPLY = {
  config: {
    currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-09-27T20:25:36.625288+00:00', end: '2026-10-04T20:25:36.625288+00:00' },
    creditUsagePercent: 100,
    onDemandCap: { val: 0 },
    onDemandUsed: { val: 0 },
    productUsage: [{ product: 'GrokImagine', usagePercent: 96 }],
    isUnifiedBillingUser: true,
    prepaidBalance: { val: 0 },
    topUpMethod: 'TOP_UP_METHOD_SAVED_PAYMENT_METHOD',
    billingPeriodStart: '2026-09-27T20:25:36.625288+00:00',
    billingPeriodEnd: '2026-10-04T20:25:36.625288+00:00',
  },
}

export function xaiAuthFixture() {
  const state = { polls: 0, refreshes: 0, starts: 0, deny: false, slow: true, failRefresh: false, billingStatus: 200, billingMalformed: false, prepaidCents: 0 as number | string, onToken: undefined as (() => void) | undefined, tokenHold: undefined as Promise<void> | undefined }
  const token = 'fixture-grok-access-not-real'
  const rotated = 'fixture-grok-access-rotated-not-real'
  const seen: Array<{ path: string; bearer: string | null; headers: Record<string, string> }> = []
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const url = new URL(req.url)
    const path = url.pathname
    seen.push({ path, bearer: req.headers.get('authorization'), headers: Object.fromEntries(req.headers.entries()) })
    assert.ok(!/opencode|openclaw|hermes/i.test(req.headers.get('user-agent') ?? ''))
    if (path === '/v1/models') {
      assert.fail('a Grok subscription never lists on the API-key base')
    }
    if (path === '/proxy/v1/models') {
      assert.ok([`Bearer ${token}`, `Bearer ${rotated}`].includes(req.headers.get('authorization') ?? ''))
      return Response.json(XAI_GROK_PROXY_MODELS_REPLY)
    }
    if (path === '/proxy/v1/billing') {
      assert.ok([`Bearer ${token}`, `Bearer ${rotated}`].includes(req.headers.get('authorization') ?? ''))
      assert.equal(url.searchParams.get('format'), 'credits')
      assert.equal(req.method, 'GET')
      assert.equal(req.headers.get('x-grok-client-mode'), 'cli')
      assert.ok(req.headers.get('x-grok-client-version'))
      if (state.billingStatus !== 200) return Response.json({ error: 'fixture refusal' }, { status: state.billingStatus })
      if (state.billingMalformed) return Response.json({ nothing: true })
      return Response.json({ ...XAI_GROK_PROXY_BILLING_REPLY, config: { ...XAI_GROK_PROXY_BILLING_REPLY.config, prepaidBalance: { val: state.prepaidCents } } })
    }
    const form = new URLSearchParams(await req.text())
    assert.equal(form.get('client_id'), 'b1a00492-073a-47ea-816f-4c329264a828')
    assert.equal(form.has('client_secret'), false)
    if (path === '/oauth2/device/code') {
      state.starts++
      assert.equal(form.get('scope'), 'openid profile email offline_access grok-cli:access api:access')
      assert.equal(form.get('referrer'), 'mercury')
      return Response.json({ device_code: 'fixture-device', user_code: 'GROK-TEST', verification_uri: `${url.origin}/verify`, expires_in: 300, interval: 1 })
    }
    assert.equal(path, '/oauth2/token')
    if (form.get('grant_type') === 'refresh_token') {
      state.refreshes++
      assert.equal(form.get('refresh_token'), 'fixture-refresh')
      state.onToken?.()
      await state.tokenHold
      return state.failRefresh ? Response.json({ error: 'invalid_grant' }, { status: 400 }) : Response.json({ access_token: rotated, refresh_token: 'fixture-rotated-refresh', expires_in: 3600 })
    }
    assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code')
    assert.equal(form.get('device_code'), 'fixture-device')
    state.polls++
    if (state.deny) return Response.json({ error: 'access_denied' }, { status: 400 })
    if (state.slow && state.polls < 3) return Response.json({ error: state.polls === 1 ? 'authorization_pending' : 'slow_down' }, { status: 400 })
    state.onToken?.()
    await state.tokenHold
    const id = `fixture.${Buffer.from(JSON.stringify({ email: 'fixture@example.invalid' })).toString('base64url')}.fixture`
    return Response.json({ access_token: token, refresh_token: 'fixture-refresh', id_token: id, expires_in: 3600 })
  } })
  const base = `http://127.0.0.1:${server.port}`
  return { state, token, rotated, seen, env: { MERCURY_XAI_AUTH_BASE: base, MERCURY_XAI_API_BASE: `${base}/v1`, MERCURY_XAI_GROK_PROXY_BASE: `${base}/proxy/v1` }, stop: () => server.stop(true) }
}
