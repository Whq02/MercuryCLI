import { strict as assert } from 'node:assert'

export const XAI_FIXTURE_API_KEY = 'xai-inference-fixture-not-a-real-key'
export const XAI_FIXTURE_MANAGEMENT_KEY = 'xai-management-fixture-not-a-real-key'
export const XAI_FIXTURE_NOW = Date.UTC(2026, 8, 30, 12, 34, 56)

export function xaiUsageFixture() {
  const requests: Array<{ path: string; method: string }> = []
  const state = {
    status: 200,
    partial: false,
    prepaidOnly: false,
    malformed: false,
    balanceCents: '-1234',
    hold: undefined as Promise<void> | undefined,
    hitUsage: undefined as (() => void) | undefined,
  }
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname
      requests.push({ path, method: req.method })
      const auth = req.headers.get('authorization')
      if (path === '/inference/v1/models') {
        assert.equal(auth, `Bearer ${XAI_FIXTURE_API_KEY}`)
        return Response.json({ data: [{ id: 'grok-4.7' }] })
      }
      if (path === '/inference/v1/api-key') {
        assert.equal(auth, `Bearer ${XAI_FIXTURE_API_KEY}`)
        assert.equal(req.method, 'GET')
        return Response.json({ team_id: 'team-fixture', api_key_id: 'id-not-stored', redacted_api_key: 'not-for-display' })
      }
      assert.equal(auth, `Bearer ${XAI_FIXTURE_MANAGEMENT_KEY}`)
      const base = '/v1/billing/teams/team-fixture'
      assert.ok(path.startsWith(base + '/'), 'only documented billing paths')
      if (state.status !== 200) return Response.json({ error: 'fixture refusal' }, { status: state.status })
      if (path === base + '/prepaid/balance') {
        assert.equal(req.method, 'GET')
        return Response.json({ changes: [{ teamId: 'team-fixture', changeOrigin: 'PURCHASE', topupStatus: 'SUCCEEDED', amount: { val: state.balanceCents } }], total: { val: state.balanceCents } })
      }
      if (path === base + '/postpaid/invoice/preview') {
        assert.equal(req.method, 'GET')
        return Response.json({ coreInvoice: { lines: [], amountBeforeVat: '1500', vatCost: '300', amountAfterVat: '1800', prepaidCredits: { val: state.balanceCents }, prepaidCreditsUsed: { val: '600' } }, effectiveSpendingLimit: state.prepaidOnly ? '0' : '10000', defaultCredits: '0', billingCycle: { year: 2026, month: 9 } })
      }
      if (path === base + '/postpaid/spending-limits') {
        assert.equal(req.method, 'GET')
        assert.equal(state.prepaidOnly, false)
        return Response.json({ spendingLimits: { hardSlAuto: { val: '12500' }, effectiveHardSl: { val: '12500' }, softSl: { val: '10000' }, effectiveSl: { val: '10000' } } })
      }
      if (path === base + '/usage') {
        assert.equal(req.method, 'POST')
        assert.match(req.headers.get('content-type') ?? '', /application\/json/)
        const body = await req.json() as { analyticsRequest: Record<string, unknown> }
        assert.deepEqual(body.analyticsRequest, {
          timeRange: { startTime: '2026-09-01 00:00:00', endTime: '2026-09-30 12:34:56', timezone: 'Etc/GMT' },
          timeUnit: 'TIME_UNIT_DAY', values: [{ name: 'usd', aggregation: 'AGGREGATION_SUM' }], groupBy: [], filters: [],
        })
        state.hitUsage?.()
        await state.hold
        return Response.json(state.malformed ? { timeSeries: [{ dataPoints: [{ values: ['bad'] }] }], limitReached: false } : {
          timeSeries: [{ group: [], groupLabels: [], dataPoints: [{ timestamp: '2026-09-01T00:00:00Z', values: [12.25] }, { timestamp: '2026-09-02T00:00:00Z', values: [8.75] }] }], limitReached: state.partial,
        })
      }
      return new Response('undocumented path', { status: 404 })
    },
  })
  const base = `http://127.0.0.1:${server.port}`
  const env = { XAI_API_KEY: XAI_FIXTURE_API_KEY, XAI_MANAGEMENT_API_KEY: XAI_FIXTURE_MANAGEMENT_KEY, MERCURY_XAI_API_BASE: `${base}/inference/v1`, MERCURY_XAI_MANAGEMENT_API_BASE: base }
  return { env, state, requests, stop: () => server.stop(true) }
}
