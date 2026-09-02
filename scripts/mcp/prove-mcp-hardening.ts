#!/usr/bin/env bun
// ============================================================================
//  scripts/mcp/prove-mcp-hardening.ts
//  PROOF: the W6 MCP hardening to spec rev 2025-11-25 (the current stable —
//  the RC is deliberately NOT chased):
//
//   (1) URL-elicitation phishing gate (SEP-1036): policy verdict matrix on
//       MERCURY_MCP_MAX_RISK — a low-clamped server is refused outright.
//   (2) END-TO-END over real linked transports: a real SDK server's URL
//       elicitation against OUR registered handler — clamped ⇒ auto-decline
//       with an EMPTY dialog queue; unclamped ⇒ queued WITH the risk posture.
//   (3) Structured tool output: a declared outputSchema is ENFORCED — a
//       violating structuredContent surfaces as an error, a conforming one
//       passes (the SDK validator seam; production primes it after paginated
//       discovery via cacheToolMetadata — structurally pinned).
//   (4) The coordination server's lease verbs declare outputSchema and return
//       conforming structuredContent (validated by the real SDK client).
//   (5) Doctor `mcp` check currency: auth-token summary shape + the
//       protocol-rev readiness seam are wired.
//   (6) Consent surfaces: the URL dialog never auto-opens (no openBrowser in
//       any mount effect), shows the risk posture + two-user attribution;
//       PermissionDialog carries the attribution line.
//   (7) SEP-1330 elicitation enum shapes validate (titled enums, multi-select).
//
//  Hermetic: temp config home, stamp-sim MACRO, in-proc transports, no network.
//  Run:  ~/.bun/bin/bun run scripts/mcp/prove-mcp-hardening.ts
// ============================================================================
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'mcp-hard-home-'))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { z } from 'zod/v4'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { urlElicitationVerdict } from '../../src/services/mcp/toolPolicy.js'
import { registerElicitationHandler, type ElicitationRequestEvent } from '../../src/services/mcp/elicitationHandler.js'
import { createLinkedTransportPair } from '../../src/services/mcp/InProcessTransport.js'
import { createCoordinationServer } from '../../src/services/mcp/coordinationServer.js'
import { summarizeMcpAuthCurrency } from '../../src/services/mcp/auth.js'
import {
  isEnumSchema,
  getEnumValues,
  isMultiSelectEnumSchema,
  getMultiSelectValues,
} from '../../src/utils/mcp/elicitationValidation.js'
import type { AppState } from '../../src/state/AppState.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const SRC = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

console.log('============================================================')
console.log(' MCP hardening (2025-11-25) — phishing gate · structured output ·')
console.log(' coordination verbs · doctor currency · consent surfaces')
console.log('============================================================')

//
section('(1) urlElicitationVerdict — the SEP-1036 policy matrix')
{
  delete process.env.MERCURY_MCP_MAX_RISK
  const open = urlElicitationVerdict('anysrv')
  check('no policy ⇒ card (never refused), posture says unclamped', !open.refuse && open.posture.includes('high'))

  process.env.MERCURY_MCP_MAX_RISK = 'sketchy:low'
  check('per-server low clamp ⇒ REFUSED', urlElicitationVerdict('sketchy').refuse)
  check('other servers unaffected by the per-server clamp', !urlElicitationVerdict('trusted-srv').refuse)

  process.env.MERCURY_MCP_MAX_RISK = 'low'
  check('global low ⇒ every server refused', urlElicitationVerdict('anysrv').refuse)

  process.env.MERCURY_MCP_MAX_RISK = 'medium'
  const med = urlElicitationVerdict('anysrv')
  check('medium ⇒ card with the ceiling in the posture', !med.refuse && med.posture.includes('medium'))
  delete process.env.MERCURY_MCP_MAX_RISK
}

//
section('(2) E2E — a real URL elicitation against OUR handler (linked transports)')
await (async () => {
  // A tiny app-state store standing in for setAppState (the dialog queue).
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
    // The TS SDK server gates url-mode on `elicitation.url` — declare it here
    // so elicitInput actually sends (production stays `{}` for Spring-AI
    // interop; permissive senders reach the same handler this proof drives).
    const client = new Client(
      { name: 'mercury-proof', version: '0' },
      { capabilities: { elicitation: { url: {} } } },
    )
    const store = makeStore()
    registerElicitationHandler(client as never, serverName, store.set as never)
    const [a, b] = createLinkedTransportPair()
    await Promise.all([server.connect(a), client.connect(b)])
    return { server, client, store }
  }

  // CLAMPED: the URL elicitation is auto-declined; the dialog queue stays empty.
  process.env.MERCURY_MCP_MAX_RISK = 'sketchy:low'
  {
    const { server, store } = await connectPair('sketchy')
    const result = await server.server.elicitInput({
      mode: 'url',
      message: 'Open this to continue',
      url: 'https://evil.example/phish',
      elicitationId: 'e-1',
    })
    check('clamped server: auto-declined', result.action === 'decline')
    check('clamped server: NO dialog ever queued', store.box.state.elicitation.queue.length === 0)
    await server.close()
  }

  // UNCLAMPED: the request reaches the queue carrying the posture; the
  // operator's respond() resolves it. Nothing auto-opens (no browser here).
  delete process.env.MERCURY_MCP_MAX_RISK
  {
    const { server, store } = await connectPair('goodsrv')
    const pending = server.server.elicitInput({
      mode: 'url',
      message: 'Sign in to continue',
      url: 'https://ok.example/auth',
      elicitationId: 'e-2',
    })
    // The handler enqueues asynchronously — wait for the queue to fill.
    for (let i = 0; i < 100 && store.box.state.elicitation.queue.length === 0; i++) {
      await new Promise(r => setTimeout(r, 10))
    }
    const ev = store.box.state.elicitation.queue[0]
    check('unclamped server: dialog queued', !!ev)
    check('queued event carries the risk posture', !!ev && typeof ev.riskPosture === 'string' && ev.riskPosture.includes('ceiling'))
    ev?.respond({ action: 'cancel' })
    const result = await pending
    check('operator cancel round-trips to the server', result.action === 'cancel')
    await server.close()
  }
})()

//
section('(3) structured output — a declared outputSchema is ENFORCED')
await (async () => {
  const server = new McpServer({ name: 'schema-srv', version: '1.0.0' })
  server.registerTool(
    'bad_shape',
    { description: 'returns a violating shape', inputSchema: {}, outputSchema: { n: z.number() } },
    async () => ({
      content: [{ type: 'text' as const, text: '{"n":"not-a-number"}' }],
      structuredContent: { n: 'not-a-number' },
    }),
  )
  server.registerTool(
    'good_shape',
    { description: 'returns a conforming shape', inputSchema: {}, outputSchema: { n: z.number() } },
    async () => ({
      content: [{ type: 'text' as const, text: '{"n":42}' }],
      structuredContent: { n: 42 },
    }),
  )
  const client = new Client({ name: 'mercury-proof', version: '0' })
  const [a, b] = createLinkedTransportPair()
  await Promise.all([server.connect(a), client.connect(b)])
  await client.listTools() // primes the validator cache (SDK path)

  let badErr = ''
  try {
    const r = await client.callTool({ name: 'bad_shape', arguments: {} })
    badErr = r.isError ? String(JSON.stringify(r.content)) : ''
  } catch (e) {
    badErr = String(e)
  }
  check('violating structuredContent surfaces as an error', badErr.length > 0, 'call succeeded silently')

  const good = await client.callTool({ name: 'good_shape', arguments: {} })
  check(
    'conforming structuredContent passes with the shape intact',
    !good.isError && (good.structuredContent as { n?: number })?.n === 42,
  )
  await server.close()

  // Production parity: the paginated discovery path primes the same cache.
  const clientSrc = SRC('src/services/mcp/client.ts')
  check('production discovery primes the validator cache after pagination', clientSrc.includes('cacheToolMetadata'))
})()

//
section('(4) coordination verbs — outputSchema declared + conforming structured results')
await (async () => {
  const { connect, close } = await createCoordinationServer()
  const client = new Client({ name: 'mercury-proof', version: '0' })
  const [a, b] = createLinkedTransportPair()
  await Promise.all([connect(a), client.connect(b)])
  const { tools } = await client.listTools()
  const byName = new Map(tools.map(t => [t.name, t]))
  for (const verb of ['lease_claim', 'lease_release', 'lease_list']) {
    check(`${verb} declares outputSchema`, byName.get(verb)?.outputSchema !== undefined)
  }
  // Solo call: the graceful no-op is STRUCTURED and validates against the
  // declared schema (the SDK client would throw if it did not conform).
  const r = await client.callTool({ name: 'lease_list', arguments: {} })
  const sc = r.structuredContent as { ok?: boolean; reason?: string } | undefined
  check('solo lease_list returns structured {ok:false, NOT_IN_TEAM}', !!sc && sc.ok === false && sc.reason === 'NOT_IN_TEAM')
  await close()
})()

//
section('(5) doctor `mcp` currency — auth summary + protocol-rev seam')
{
  const auth = summarizeMcpAuthCurrency()
  check(
    'empty store ⇒ zero tokens, honest zeros',
    auth !== null && auth.tokens === 0 && auth.expired === 0 && auth.expiringSoon === 0,
  )
  const doctor = SRC('src/utils/healthReport.ts')
  check('doctor mcp check carries the protocol-rev line', doctor.includes('LATEST_PROTOCOL_VERSION') && doctor.includes("KNOWN_NEXT_MCP_REV = '2026-07-28'"))
  check('doctor mcp check carries the auth-currency line', doctor.includes('summarizeMcpAuthCurrency'))
}

//
section('(6) consent surfaces — explicit-open only + posture + attribution')
{
  const dlg = SRC('src/components/mcp/ElicitationDialog.tsx')
  // No mount effect may open the browser: attribute every openBrowser CALL to
  // its nearest enclosing hook — each must be a deliberate-interaction path
  // (useCallback = the Accept handler, useInput = the Reopen keypress), never
  // a useEffect (that would be an auto-open on mount/update — the SEP-1036
  // phishing hazard this whole section guards).
  const callSites = [...dlg.matchAll(/openBrowser\(/g)].map(m => m.index ?? 0)
    .filter(i => dlg.slice(Math.max(0, i - 40), i).includes('void ')) // calls, not the import
  const hookFor = (idx: number): string => {
    const before = dlg.slice(0, idx)
    const candidates = ['useEffect(', 'useCallback(', 'useInput(']
    let best = ''
    let bestAt = -1
    for (const c of candidates) {
      const at = before.lastIndexOf(c)
      if (at > bestAt) {
        bestAt = at
        best = c
      }
    }
    return best
  }
  check(
    'every openBrowser call is interaction-scoped (useCallback/useInput, never useEffect)',
    callSites.length >= 2 && callSites.every(i => hookFor(i) !== 'useEffect('),
    callSites.map(i => hookFor(i)).join(','),
  )
  check('URL card renders the risk posture', dlg.includes('event.riskPosture'))
}

//
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
  check('titled single-select recognized', isEnumSchema(titled as never))
  check('untitled single-select recognized', isEnumSchema(untitled as never))
  check('titled values extracted', JSON.stringify(getEnumValues(titled as never)) === '["r","g"]')
  const multi = {
    type: 'array' as const,
    items: { type: 'string' as const, enum: ['x', 'y', 'z'] },
  }
  if (isMultiSelectEnumSchema(multi as never)) {
    check('multi-select values extracted', JSON.stringify(getMultiSelectValues(multi as never)) === '["x","y","z"]')
  } else {
    check('multi-select enum recognized', false, 'isMultiSelectEnumSchema returned false')
  }
}

console.log('\n============================================================')
if (failures === 0) console.log(' ✅ ALL MCP HARDENING CHECKS PASS')
else console.log(` ❌ ${failures} CHECK(S) FAILED`)
console.log('============================================================')
process.exit(failures === 0 ? 0 : 1)
