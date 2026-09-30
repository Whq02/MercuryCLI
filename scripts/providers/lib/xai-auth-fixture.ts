import { strict as assert } from 'node:assert'

export function xaiAuthFixture() {
  const state = { polls: 0, refreshes: 0, starts: 0, deny: false, slow: true, failRefresh: false, onToken: undefined as (() => void) | undefined, tokenHold: undefined as Promise<void> | undefined }
  const token = 'fixture-grok-access-not-real'
  const rotated = 'fixture-grok-access-rotated-not-real'
  const seen: Array<{ path: string; bearer: string | null }> = []
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const url = new URL(req.url)
    const path = url.pathname
    seen.push({ path, bearer: req.headers.get('authorization') })
    assert.ok(!/opencode|openclaw|hermes/i.test(req.headers.get('user-agent') ?? ''))
    if (path === '/v1/models') {
      assert.ok([`Bearer ${token}`, `Bearer ${rotated}`].includes(req.headers.get('authorization') ?? ''))
      return Response.json({ data: [{ id: 'grok-4.7', created: 7 }] })
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
  return { state, token, rotated, seen, env: { MERCURY_XAI_AUTH_BASE: base, MERCURY_XAI_API_BASE: `${base}/v1` }, stop: () => server.stop(true) }
}
