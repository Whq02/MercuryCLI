#!/usr/bin/env bun
// ============================================================================
//  prove-coordinator-role-mint — a coordinator turn mints a COORDINATOR
//  receipt (silent-internal), and no receipt ever decides a row's label.
//
//  The loop under proof (re-trued under the verdict-word removal, COORDKEYS):
//  a GPT row is 'ready' on credential + catalogue facts ALONE — the
//  qualification-receipt store never paints a row or status line. The first
//  real coordinator turn still settles on the native OpenAI runtime and the
//  settlement seam still mints a receipt in the ROLE the call tags
//  (querySource 'concourse_coordinator' → 'coordinator') — the store feeds
//  the mission policy selector and /router status diagnostics, and keeps a
//  dropped-from-catalogue model's display name findable.
//
//    §1 the coordinator's OWN call path (liveCoordinatorCallModel — the real
//       persona behind the identity floor, the real tool roster) settles
//       against a loopback Responses fixture; the wire carries the exact
//       model id, the floor BEFORE the persona, and the declared tools.
//    §2 the settlement mints {gpt-5.6-sol · coordinator}, CURRENT.
//    §3 the registry reads the row 'ready'; lineup members the LANDED live
//       catalogue does not serve carry that catalogue's words verbatim.
//    §4 the contrast: a side-question call on the same model mints
//       'primary', and the coordinator receipt stands beside it.
//
//  Endpoint bases: the OpenAI API base pins to the loopback fixture; every
//  other base pins dead (ANTHROPIC_BASE_URL + dummy token, the ChatGPT and
//  auth bases, local probes off). Nothing here can reach a live service.
//
//  Run: ~/.bun/bin/bun run scripts/switchboard/prove-coordinator-role-mint.ts
// ============================================================================
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures = 1
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

// ── env hygiene BEFORE any src import ───────────────────────────────────────
const scratch = mkdtempSync(join(tmpdir(), 'coordinator-role-mint-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) {
  process.env[spelling] = home
}
for (const key of ['ANTHROPIC_API_KEY', 'MERCURY_OAUTH_TOKEN', 'ZAI_API_KEY']) {
  delete process.env[key]
}
delete process.env.NODE_ENV
process.env.MERCURY_EVOLUTION_LEDGER = '0'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_CREW_DIR = join(scratch, 'crew')
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.ANTHROPIC_AUTH_TOKEN = 'fixture-token'
process.env.MERCURY_OPENAI_CHATGPT_BASE = 'http://127.0.0.1:1'
process.env.MERCURY_OPENAI_AUTH_BASE = 'http://127.0.0.1:1'
process.env.OPENAI_API_KEY = 'sk-fixture-coordinator-mint'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

// ── the loopback Responses fixture (GET /models + POST /responses) ──────────
type Captured = { url: string; body?: Record<string, unknown> }
const captured: Captured[] = []
const MODELS_BODY = {
  models: [
    {
      slug: 'gpt-5.6-sol',
      display_name: 'GPT-5.6-Sol',
      supported_reasoning_levels: [
        { effort: 'low', description: 'Fast responses with lighter reasoning' },
        { effort: 'medium', description: 'Balances speed and reasoning depth' },
        { effort: 'high', description: 'Greater reasoning depth' },
      ],
      default_reasoning_level: 'low',
      visibility: 'list',
      priority: 1,
      context_window: 272_000,
      input_modalities: ['text', 'image'],
      supported_in_api: true,
    },
  ],
}
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const responsesSse = (): string =>
  [
    sse({ type: 'response.created', response: { id: 'resp_mint_1' } }),
    sse({ type: 'response.output_text.delta', delta: 'ok' }),
    sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] } }),
    sse({ type: 'response.completed', response: { id: 'resp_mint_1', usage: { input_tokens: 12, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } } }),
  ].join('')

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const url = req.url ?? ''
    let body: Record<string, unknown> | undefined
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    } catch {
      body = undefined
    }
    if (req.method === 'GET' && url.startsWith('/models')) {
      captured.push({ url })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(MODELS_BODY))
      return
    }
    if (req.method === 'POST' && url === '/responses') {
      captured.push({ url, body })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(responsesSse())
      return
    }
    captured.push({ url })
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const port = typeof address === 'object' && address ? address.port : 0
process.env.MERCURY_OPENAI_API_BASE = `http://127.0.0.1:${port}`

console.log('============================================================')
console.log(' coordinator role mint — the first real turn qualifies the row')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const q = await import('../../src/services/providers/openai/qualificationStore.ts')
const { MERCURY_IDENTITY_FLOOR } = await import('../../src/prompt/mercuryContract.ts')
const { COORDINATOR_CONTRACT, COORDINATOR_CONTRACT_VERSION } = await import('../../src/services/concourse/coordinatorLane.ts')
const { liveCoordinatorCallModel } = await import('../../src/services/concourse/coordinatorCall.ts')
const { coordinatorToolSet } = await import('../../src/services/concourse/coordinatorTools.ts')
const { composeCoordinatorModelRegistry, coordinatorModelStatusLabel } = await import('../../src/services/concourse/coordinatorModels.ts')

const MODEL = 'gpt-5.6-sol'
const coordinatorReceipts = () => q.readQualificationReceipts().filter(r => r.receipt.modelId === MODEL && r.receipt.role === 'coordinator')

//
section('§0 — before any turn: the row is ready with NO label (the verdict-word removal)')
//
{
  const reg = await composeCoordinatorModelRegistry()
  const row = reg.entries.find(e => e.modelId === MODEL)
  check('the store holds NO coordinator receipt yet', coordinatorReceipts().length === 0)
  check(
    "the row reads 'ready' regardless — receipts never decide a label (credential present, catalogue serves it)",
    row?.availability === 'ready',
    JSON.stringify(row),
  )
  check('…with NO label — no qualification word on any row or status line (operator-ruled)', row !== undefined && coordinatorModelStatusLabel(row) === '')
  check('…and the registry is selectable', reg.selectable === true)
}

//
section("§1 — the coordinator's own call path settles against the fixture")
//
const before = captured.length
const proposal = await liveCoordinatorCallModel(
  {
    contractVersion: COORDINATOR_CONTRACT_VERSION,
    contract: COORDINATOR_CONTRACT,
    event: { kind: 'operator-message', messageId: 'mint-1', text: 'say ok' },
    board: { counts: {}, sessions: [], openObligations: [] },
  },
  MODEL,
)
{
  const responses = captured.slice(before).filter(c => c.url === '/responses')
  check('exactly ONE Responses call settled the turn', responses.length === 1, String(responses.length))
  const body = responses[0]?.body ?? {}
  check('the wire carries the exact model id', body.model === MODEL, String(body.model))
  check("the reply is the fixture's text", proposal.reply === 'ok', JSON.stringify(proposal))
  const instructions = typeof body.instructions === 'string' ? body.instructions : ''
  const floorAt = instructions.indexOf('You are the Mercury coordinator')
  const attributionAt = instructions.indexOf('Mercury was not built by the maker of any model it runs')
  const personaAt = instructions.indexOf('Your seat is the Mercury switchboard')
  check('the coordinator floor rides the wire (the seat’s own identity statement)', floorAt >= 0, instructions.slice(0, 160))
  check('the attribution line rides the wire behind it', attributionAt > floorAt, `${floorAt} vs ${attributionAt}`)
  check('the persona rides the wire', personaAt >= 0, instructions.slice(0, 160))
  check('the floor LEADS the persona (the composition stays intact)', floorAt >= 0 && personaAt > floorAt, `${floorAt} vs ${personaAt}`)
  check('exactly ONE identity statement on the wire (no session statement beside the seat’s)', (instructions.match(/^You are /gm) ?? []).length === 1 && !instructions.includes('You are **Mercury**'))
  const declared = coordinatorToolSet().map(d => d.name)
  const wired = Array.isArray(body.tools) ? (body.tools as Array<{ name?: string }>).map(t => t.name) : []
  check('every declared coordinator tool rides the wire', declared.length > 0 && declared.every(n => wired.includes(n)), `${declared.length} declared / ${wired.length} wired`)
}

//
section('§2 — the settlement mints a COORDINATOR receipt (current)')
//
{
  const minted = coordinatorReceipts()
  check('ONE coordinator receipt for the model', minted.length === 1, JSON.stringify(q.readQualificationReceipts().map(r => [r.receipt.modelId, r.receipt.role])))
  check('…CURRENT under the live digests', minted[0]?.current === true, JSON.stringify(minted[0]))
  check("…no 'primary' receipt was minted by the coordinator turn", !q.readQualificationReceipts().some(r => r.receipt.role === 'primary'))
}

//
section("§3 — the registry reads the row 'ready'; the landed catalogue's words ride the rest")
//
{
  const reg = await composeCoordinatorModelRegistry()
  const row = reg.entries.find(e => e.modelId === MODEL)
  check("the qualified row reads 'ready' on the very next read", row?.availability === 'ready', JSON.stringify(row))
  check('…with NO label', row !== undefined && coordinatorModelStatusLabel(row) === '')
  const unserved = reg.entries.filter(e => e.source === 'openai' && e.modelId !== MODEL)
  check(
    "lineup members the LANDED catalogue does not serve read 'provider-unavailable' with the catalogue's words",
    unserved.length > 0 && unserved.every(e => e.availability === 'provider-unavailable' && typeof e.detail === 'string' && e.detail.length > 0),
    JSON.stringify(unserved.map(e => [e.modelId, e.availability, e.detail])),
  )
  check('every GPT row stays selectable (no refusal field)', reg.entries.every(e => !('refusal' in e)) && reg.selectable)
}

//
section("§4 — the contrast: a side question on the same model mints 'primary'")
//
{
  const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
  const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
  const { createUserMessage } = await import('../../src/utils/messages.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
  const stream = routedCallModel({
    messages: [createUserMessage({ content: 'say ok' })],
    systemPrompt: asSystemPrompt([MERCURY_IDENTITY_FLOOR]),
    thinkingConfig: { type: 'disabled' },
    tools: [] as never,
    signal: AbortSignal.timeout(30_000),
    options: {
      model: MODEL,
      querySource: 'side_question',
      agents: [],
      isNonInteractiveSession: true,
      hasAppendSystemPrompt: false,
      mcpTools: [],
      maxOutputTokensOverride: 64,
      enablePromptCaching: false,
      async getToolPermissionContext() {
        return getEmptyToolPermissionContext()
      },
    } as never,
  })
  for await (const _event of stream) {
    // drain — the store is the assertion surface
  }
  const roles = q.readQualificationReceipts().filter(r => r.receipt.modelId === MODEL).map(r => r.receipt.role).sort()
  check("the side question minted 'primary' beside the standing 'coordinator' receipt", roles.join(',') === 'coordinator,primary', roles.join(','))
}

server.close()
rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\n✅ prove-coordinator-role-mint — all checks pass' : '\n❌ prove-coordinator-role-mint — FAILED')
process.exit(failures)
