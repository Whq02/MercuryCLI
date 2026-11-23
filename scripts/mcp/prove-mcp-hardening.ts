#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'mcp-hard-home-'))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { z } from 'zod/v4'
import { Client } from '@modelcontextprotocol/client'
import { McpServer } from '@modelcontextprotocol/server'
import { urlElicitationVerdict } from '../../src/integrations/mcp-shapes/toolPolicy.js'
import { registerElicitationHandler, type ElicitationRequestEvent } from '../../src/integrations/mcp/elicitationHandler.js'
import { createLinkedTransportPair } from '../../src/integrations/mcp/InProcessTransport.js'
import { createMercuryServer } from '../../src/integrations/mcp/mercuryServer.js'
import { summarizeMcpAuthCurrency } from '../../src/integrations/mcp/auth.js'
import {
  isEnumSchema,
  getEnumValues,
  isMultiSelectEnumSchema,
  getMultiSelectValues,
} from '../../src/integrations/mcp/elicitationValidation.js'
import type { AppState } from '../../src/screen/app-state/AppState.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' MCP hardening — phishing gate · structured output ·')
console.log(' lease verbs · health currency · consent surfaces')
console.log('============================================================')

section('(1) urlElicitationVerdict — the SEP-1036 policy matrix')
{
  delete process.env.MERCURY_MCP_MAX_RISK
  const open = urlElicitationVerdict('anysrv')
  check('no policy ⇒ card (never refused), posture says unclamped', !open.refuse && open.posture.includes('high'), 'urlElicitationVerdict in src/integrations/mcp-shapes/toolPolicy.ts must not refuse without MERCURY_MCP_MAX_RISK and must name the high ceiling in posture')

  process.env.MERCURY_MCP_MAX_RISK = 'sketchy:low'
  check('per-server low clamp ⇒ REFUSED', urlElicitationVerdict('sketchy').refuse, 'urlElicitationVerdict in src/integrations/mcp-shapes/toolPolicy.ts must refuse a server clamped low by a server:low entry in MERCURY_MCP_MAX_RISK')
  check('other servers unaffected by the per-server clamp', !urlElicitationVerdict('trusted-srv').refuse, 'urlElicitationVerdict in src/integrations/mcp-shapes/toolPolicy.ts must apply a server:low clamp only to the named server')

  process.env.MERCURY_MCP_MAX_RISK = 'low'
  check('global low ⇒ every server refused', urlElicitationVerdict('anysrv').refuse, 'urlElicitationVerdict in src/integrations/mcp-shapes/toolPolicy.ts must refuse every server when MERCURY_MCP_MAX_RISK is low')

  process.env.MERCURY_MCP_MAX_RISK = 'medium'
  const med = urlElicitationVerdict('anysrv')
  check('medium ⇒ card with the ceiling in the posture', !med.refuse && med.posture.includes('medium'), 'urlElicitationVerdict in src/integrations/mcp-shapes/toolPolicy.ts must allow a card at medium and name the medium ceiling in posture')
  delete process.env.MERCURY_MCP_MAX_RISK
}

section('(2) E2E — a real URL elicitation against OUR handler (linked transports)')
await (async () => {
  const makeStore = () => {
    const box = { state: { elicitation: { queue: [] as ElicitationRequestEvent[] } } }
    return {
      box,
      set: (f: (prev: AppState) => AppState) => {
        box.state = f(box.state as unknown as AppState) as unknown as typeof box.state
      },
    }
  }

  const connectPair = async (serverName: string) => {
    const server = new McpServer({ name: serverName, version: '1.0.0' })
    const client = new Client(
      { name: 'mercury-proof', version: '0' },
      { capabilities: { elicitation: { form: {}, url: {} } } },
    )
    const store = makeStore()
    registerElicitationHandler(client as never, serverName, store.set as never)
    const [a, b] = createLinkedTransportPair()
    await Promise.all([server.connect(a), client.connect(b)])
    return { server, client, store }
  }

  process.env.MERCURY_MCP_MAX_RISK = 'sketchy:low'
  {
    const { server, store } = await connectPair('sketchy')
    const result = await server.server.elicitInput({
      mode: 'url',
      message: 'Open this to continue',
      url: 'https://evil.example/phish',
      elicitationId: 'e-1',
    })
    check('clamped server: auto-declined', result.action === 'decline', `action=${result.action} (registerElicitationHandler in src/integrations/mcp/elicitationHandler.ts must answer decline when urlElicitationVerdict refuses)`)
    check('clamped server: NO dialog ever queued', store.box.state.elicitation.queue.length === 0, 'registerElicitationHandler in src/integrations/mcp/elicitationHandler.ts must not queue an elicitation event for a refused server')
    await server.close()
  }

  delete process.env.MERCURY_MCP_MAX_RISK
  {
    const { server, store } = await connectPair('goodsrv')
    const pending = server.server.elicitInput({
      mode: 'url',
      message: 'Sign in to continue',
      url: 'https://ok.example/auth',
      elicitationId: 'e-2',
    })
    for (let i = 0; i < 100 && store.box.state.elicitation.queue.length === 0; i++) {
      await new Promise(r => setTimeout(r, 10))
    }
    const ev = store.box.state.elicitation.queue[0]
    check('unclamped server: dialog queued', !!ev, 'registerElicitationHandler in src/integrations/mcp/elicitationHandler.ts must queue a url elicitation event for an unclamped server')
    check('queued event carries the risk posture', !!ev && typeof ev.riskPosture === 'string' && ev.riskPosture.includes('ceiling'), 'registerElicitationHandler in src/integrations/mcp/elicitationHandler.ts must set riskPosture from urlElicitationVerdict on the queued event')
    ev?.respond({ action: 'cancel' })
    const result = await pending
    check('operator cancel round-trips to the server', result.action === 'cancel', `action=${result.action} (the respond callback of the queued event in src/integrations/mcp/elicitationHandler.ts must return the operator action to the server)`)
    await server.close()
  }
})()

section('(3) structured output — a declared outputSchema is ENFORCED')
await (async () => {
  const server = new McpServer({ name: 'schema-srv', version: '1.0.0' })
  server.registerTool(
    'bad_shape',
    { description: 'returns a violating shape', inputSchema: z.object({}), outputSchema: z.object({ n: z.number() }) },
    async () => ({
      content: [{ type: 'text' as const, text: '{"n":"not-a-number"}' }],
      structuredContent: { n: 'not-a-number' },
    }),
  )
  server.registerTool(
    'good_shape',
    { description: 'returns a conforming shape', inputSchema: z.object({}), outputSchema: z.object({ n: z.number() }) },
    async () => ({
      content: [{ type: 'text' as const, text: '{"n":42}' }],
      structuredContent: { n: 42 },
    }),
  )
  const client = new Client({ name: 'mercury-proof', version: '0' })
  const [a, b] = createLinkedTransportPair()
  await Promise.all([server.connect(a), client.connect(b)])
  await client.listTools()

  let badErr = ''
  try {
    const r = await client.callTool({ name: 'bad_shape', arguments: {} })
    badErr = r.isError ? String(JSON.stringify(r.content)) : ''
  } catch (e) {
    badErr = String(e)
  }
  check('violating structuredContent surfaces as an error', badErr.length > 0, 'call succeeded silently (the MCP client must validate structuredContent against the declared outputSchema; look at the @modelcontextprotocol/client callTool path and any Mercury wrapper in src/integrations/mcp/client.ts)')

  const good = await client.callTool({ name: 'good_shape', arguments: {} })
  check(
    'conforming structuredContent passes with the shape intact',
    !good.isError && (good.structuredContent as { n?: number })?.n === 42,
    'a conforming structuredContent must pass through the MCP client unchanged; look at the callTool path in src/integrations/mcp/client.ts',
  )
  await server.close()

  const { loggedHeadersOf } = await import('../../src/integrations/mcp/client.js')
  const { getMCPUserAgent } = await import('../../src/models/roads/requestHeaders.js')
  const logged = loggedHeadersOf({ 'User-Agent': getMCPUserAgent(), Authorization: 'Bearer tok-1', 'X-API-Key': 'key-2', Cookie: 'sid=3', 'Proxy-Authorization': 'Basic 4', 'X-Custom-Token': 'tok-5' })
  const overridden = loggedHeadersOf({ 'User-Agent': 'fixture-secret', 'user-agent': 'fixture-secret-two' })
  check('configured User-Agent values are redacted too, regardless of case', Object.values(overridden).every(value => value === '[REDACTED]'), `${JSON.stringify(overridden)} (loggedHeadersOf in src/integrations/mcp/client.ts must redact a configured User-Agent in any case)`)
  check(
    'no credential header VALUE reaches the MCP log: every configured or helper-supplied header is logged by name with its value redacted, whatever its name; only our own User-Agent stays readable (F43A-C7-18)',
    logged['User-Agent'] === getMCPUserAgent() && Object.entries(logged).filter(([key]) => key !== 'User-Agent').every(([, value]) => value === '[REDACTED]') && Object.keys(logged).length === 6,
    `${JSON.stringify(logged)} (loggedHeadersOf in src/integrations/mcp/client.ts must log every header by name with value [REDACTED], except the User-Agent from getMCPUserAgent in src/models/roads/requestHeaders.ts)`,
  )
})()

section('(4) the lease verbs — outputSchema declared + conforming structured results')
await (async () => {
  const { connect, close } = await createMercuryServer()
  const client = new Client({ name: 'mercury-proof', version: '0' })
  const [a, b] = createLinkedTransportPair()
  await Promise.all([connect(a), client.connect(b)])
  const { tools } = await client.listTools()
  const byName = new Map(tools.map(t => [t.name, t]))
  for (const verb of ['lease_release', 'lease_list']) {
    check(`${verb} declares outputSchema`, byName.get(verb)?.outputSchema !== undefined, `the ${verb} tool registered by createMercuryServer in src/integrations/mcp/mercuryServer.ts must declare an outputSchema`)
  }
  check('the server serves the project lease verbs and render_tui, and no crew verb', ['lease_take', 'lease_release', 'lease_list', 'render_tui'].every(v => byName.has(v)) && !byName.has('lease_claim') && !byName.has('brief') && !byName.has('coord_say'), `${[...byName.keys()].join(',')} (createMercuryServer in src/integrations/mcp/mercuryServer.ts must register exactly lease_take, lease_release, lease_list and render_tui, with no crew verb)`)
  const r = await client.callTool({ name: 'lease_list', arguments: {} })
  const sc = r.structuredContent as { ok?: boolean; reason?: string } | undefined
  check('lease_list answers structured {ok:true, leases:[]} on a fresh project', !!sc && sc.ok === true && Array.isArray(sc.leases) && sc.leases.length === 0, `${JSON.stringify(sc)} (the lease_list tool in src/integrations/mcp/mercuryServer.ts must return structuredContent {ok:true, leases:[]} when no lease is held)`)
  await close()
})()

section('(5) health `mcp` currency — auth summary + protocol-rev seam')
{
  const auth = summarizeMcpAuthCurrency()
  check(
    'empty store ⇒ zero tokens, honest zeros',
    auth !== null && auth.tokens === 0 && auth.expired === 0 && auth.expiringSoon === 0,
    `${JSON.stringify(auth)} (summarizeMcpAuthCurrency in src/integrations/mcp/auth.ts must return zero tokens, expired and expiringSoon for an empty store)`,
  )
  ;(await import('../../src/platform/settings/config.ts')).enableConfigs()
  const { runtimeChecks } = await import('../../src/platform/health/sections/runtime.ts')
  const { publishMcpConnections } = await import('../../src/screen/cockpit-gauges/mcpGauge.ts')
  const { describeMcpProtocolCurrency } = await import('../../src/integrations/mcp/protocolRevision.ts')
  publishMcpConnections([{ name: 'fixture-srv', type: 'pending' } as never])
  const mcpSays = await runtimeChecks().find(row => row.id === 'mcp')?.run()
  publishMcpConnections([])
  const currency = describeMcpProtocolCurrency()
  check('health mcp check reads the protocol-revision line from its owner', mcpSays?.evidence.startsWith('1 server(s): fixture-srv (starting) · policy ') === true && mcpSays.evidence.includes(` · ${currency.line} · `) && (!currency.behind || mcpSays.status === 'warn'), `${mcpSays?.evidence} (the mcp row of runtimeChecks in src/platform/health/sections/runtime.ts must build its evidence from the connections, the policy and describeMcpProtocolCurrency in src/integrations/mcp/protocolRevision.ts)`)
  check('health mcp check carries the auth-currency line', auth !== null && auth.tokens === 0 && mcpSays?.evidence.endsWith(' · no oauth tokens') === true, `${mcpSays?.evidence} (the mcp row of runtimeChecks in src/platform/health/sections/runtime.ts must end its evidence with the summarizeMcpAuthCurrency line)`)
}


section('(7) SEP-1330 elicitation enum shapes')
{
  const titled = {
    type: 'string' as const,
    title: 'Color',
    oneOf: [
      { const: 'r', title: 'Red' },
      { const: 'g', title: 'Green' },
    ],
  }
  const untitled = { type: 'string' as const, enum: ['a', 'b'] }
  check('titled single-select recognized', isEnumSchema(titled as never), 'isEnumSchema in src/integrations/mcp/elicitationValidation.ts must accept a oneOf of const/title entries')
  check('untitled single-select recognized', isEnumSchema(untitled as never), 'isEnumSchema in src/integrations/mcp/elicitationValidation.ts must accept a string schema with enum')
  check('titled values extracted', JSON.stringify(getEnumValues(titled as never)) === '["r","g"]', 'getEnumValues in src/integrations/mcp/elicitationValidation.ts must return the const values of a oneOf schema')
  const multi = {
    type: 'array' as const,
    items: { type: 'string' as const, enum: ['x', 'y', 'z'] },
  }
  if (isMultiSelectEnumSchema(multi as never)) {
    check('multi-select values extracted', JSON.stringify(getMultiSelectValues(multi as never)) === '["x","y","z"]', 'getMultiSelectValues in src/integrations/mcp/elicitationValidation.ts must return the items enum values')
  } else {
    check('multi-select enum recognized', false, 'isMultiSelectEnumSchema in src/integrations/mcp/elicitationValidation.ts returned false for an array schema whose items carry an enum')
  }
}

console.log('\n============================================================')
if (failures === 0) console.log(' ✅ ALL MCP HARDENING CHECKS PASS')
else console.log(` ❌ ${failures} CHECK(S) FAILED`)
console.log('============================================================')
process.exit(failures === 0 ? 0 : 1)
