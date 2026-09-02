#!/usr/bin/env bun
// ============================================================================
//  scripts/mcp/prove-mcp-tool-estate.ts — what an MCP server declares is what
//  the model is told, and what the model calls is what the server ran.
//
//  Drives the REAL client (src/services/mcp/client.ts) over a real stdio
//  transport against the awkward fixture server (_fixture-estate-server.mjs,
//  its own process), then the REAL executor (services/tools/toolOrchestration
//  → toolExecution) over the discovered tools, and pins:
//
//    D  discovery — dotted, dashed and non-ASCII names project into the
//       qualified grammar; the awkward schema (enum · nullable · anyOf ·
//       array-of-object · additionalProperties:false) is installed verbatim
//       as the wire schema while the zod form accepts anything; an over-long
//       description truncates with a marker after the provenance header;
//       annotations drive read-only/concurrency/destructive; every projected
//       name fits the strictest wire grammar Mercury speaks (64 chars, the
//       OpenAI-family function name) and the Anthropic one (128).
//    I  invocation — a plain call round-trips; awkward arguments reach the
//       server verbatim (nulls and unknown keys included); an isError result
//       is an is_error tool_result carrying the server's text; an image
//       result is an image block the transcript can carry; an embedded
//       resource surfaces its text; structured content arrives as JSON; a
//       slow call aborted mid-flight settles error-shaped within the abort,
//       never hangs; a server that dies mid-call settles as an error result
//       and a fresh connect brings it back; a form elicitation in a
//       non-interactive session is answered (declined) without hanging.
//    P  policy — under MERCURY_MCP_MAX_RISK=low a destructive-hinted tool is
//       withheld from discovery.
//
//  Hermetic: scratch config home; the fixture is spawned by the client; no
//  network. Run: ~/.bun/bin/bun run scripts/mcp/prove-mcp-tool-estate.ts
// ============================================================================
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'mcp-estate-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_DAEMON_DIR = join(SCRATCH, 'daemon')
process.env.MERCURY_TEAMS_DIR = join(SCRATCH, 'teams')
delete process.env.MERCURY_MCP_MAX_RISK
delete process.env.MERCURY_MCP_UNTRUSTED_HARDENING
delete process.env.MERCURY_MCP_TRUSTED_SERVERS
if (process.env.NODE_ENV === 'test') delete process.env.NODE_ENV
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
let checks = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  checks++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (s: string): void => console.log(`\n── ${s} ──`)
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — mcp tool estate prover exceeded 120s')
  process.exit(1)
}, 120_000)
watchdog.unref?.()

const FIXTURE = join(import.meta.dir, '_fixture-estate-server.mjs')
const SERVER = 'estate-fixture'

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const mcp = await import('../../src/services/mcp/client.ts')
const { runTools } = await import('../../src/services/tools/toolOrchestration.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createAssistantMessage } = await import('../../src/utils/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { toolToAPISchema, getEmptyToolPermissionContext } = await import('../../src/utils/api.ts').then(async api => ({
  toolToAPISchema: api.toolToAPISchema,
  getEmptyToolPermissionContext: (await import('../../src/Tool.ts')).getEmptyToolPermissionContext,
}))
type AnyMsg = Record<string, unknown> & { type?: string }
type Tool = import('../../src/Tool.ts').Tool

const stdioConfig = (name: string) =>
  ({ type: 'stdio', command: process.execPath, args: [FIXTURE], env: {}, scope: 'local', name }) as never

async function connect(name: string): Promise<Record<string, unknown>> {
  await mcp.clearServerCache(name, stdioConfig(name))
  const client = (await mcp.connectToServer(name, stdioConfig(name))) as unknown as Record<string, unknown>
  return client
}

function makeCtx(tools: readonly unknown[], client: unknown): { ctx: Record<string, unknown>; abort: AbortController } {
  let appState: Record<string, unknown> = {
    ...(getDefaultAppState() as unknown as Record<string, unknown>),
    effortValue: 'high',
  }
  const abort = new AbortController()
  const ctx: Record<string, unknown> = {
    abortController: abort,
    options: {
      commands: [],
      tools,
      mainLoopModel: 'claude-opus-4-8',
      thinkingConfig: { type: 'disabled' },
      mcpClients: [client],
      mcpResources: {},
      isNonInteractiveSession: true,
      debug: false,
      verbose: false,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    getAppState: () => appState,
    setAppState: (f: (prev: never) => never): void => {
      appState = f(appState as never) as unknown as Record<string, unknown>
    },
    messages: [],
    readFileState: createFileStateCacheWithSizeLimit(100),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    agentId: undefined,
  }
  return { ctx, abort }
}
const allowAll = (async (_tool: unknown, input: Record<string, unknown>) =>
  ({ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'rig' } })) as never

type Settled = { id: string; content: unknown; text: string; isError: boolean }
async function call(
  tools: readonly Tool[],
  client: unknown,
  name: string,
  input: unknown,
  abortAfterMs?: number,
): Promise<{ result: Settled | undefined; threw: string | undefined; elapsedMs: number }> {
  const { ctx, abort } = makeCtx(tools, client)
  const id = `tu_${name.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}`
  const parent = createAssistantMessage({ content: [{ type: 'tool_use', id, name, input }] as never })
  if (abortAfterMs !== undefined) setTimeout(() => abort.abort(), abortAfterMs)
  const started = Date.now()
  let result: Settled | undefined
  let threw: string | undefined
  try {
    for await (const update of runTools([{ type: 'tool_use', id, name, input }] as never, [parent], allowAll, ctx as never)) {
      const m = update.message as AnyMsg | undefined
      if (!m || m.type !== 'user') continue
      const content = (m.message as { content?: unknown } | undefined)?.content
      if (!Array.isArray(content)) continue
      for (const b of content as AnyMsg[]) {
        if (b.type !== 'tool_result' || b.tool_use_id !== id) continue
        const raw = b.content
        result = {
          id,
          content: raw,
          text: typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map(x => String((x as AnyMsg).text ?? '')).join('') : '',
          isError: b.is_error === true,
        }
      }
    }
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error)
  }
  return { result, threw, elapsedMs: Date.now() - started }
}

// ── D. discovery ────────────────────────────────────────────────────────────
section('D. discovery — what the server declares is what the model is told')
const client = await connect(SERVER)
t('the fixture connected over stdio', client.type === 'connected', String(client.type))
const tools = (await mcp.fetchToolsForClient(client as never)) as Tool[]
const byServerName = new Map<string, Tool>()
for (const tool of tools) byServerName.set((tool as { mcpInfo?: { toolName: string } }).mcpInfo?.toolName ?? tool.name, tool)
t('every fixture tool was discovered (12)', tools.length === 12, `${tools.length}: ${tools.map(x => x.name).join(', ')}`)
t('a dotted name projects with the dot as an underscore', byServerName.get('plain.echo')?.name === `mcp__${SERVER}__plain_echo`, byServerName.get('plain.echo')?.name)
t('a dashed name keeps its dashes', byServerName.get('awkward-schema-tool')?.name === `mcp__${SERVER}__awkward-schema-tool`, byServerName.get('awkward-schema-tool')?.name)
t('a non-ASCII name projects into the grammar charset', /^mcp__estate-fixture__unicode_[_]+$/.test(byServerName.get('unicode_名前')?.name ?? ''), byServerName.get('unicode_名前')?.name)
const awkward = byServerName.get('awkward-schema-tool')!
const wireSchema = (awkward as { inputJSONSchema?: Record<string, unknown> }).inputJSONSchema
const props = (wireSchema?.properties ?? {}) as Record<string, Record<string, unknown>>
t('the awkward schema is installed verbatim as the wire schema (enum · nullable · anyOf · array-of-object · strict)', wireSchema !== undefined && JSON.stringify(props.mode?.enum) === '["fast","slow","weird"]' && JSON.stringify(props.count?.type) === '["integer","null"]' && Array.isArray(props.choice?.anyOf) && (props.items?.items as { type?: string })?.type === 'object' && wireSchema.additionalProperties === false && JSON.stringify(wireSchema.required) === '["mode"]', JSON.stringify(wireSchema).slice(0, 200))
t('the zod form accepts anything (the server owns validation)', awkward.inputSchema.safeParse({ anything: 1, mode: 7 }).success === true)
const prompt = await awkward.prompt()
t('an over-long description is truncated with a marker, the provenance header intact', prompt.startsWith(`[mcp:${SERVER} ·`) && prompt.includes('[description truncated]') && !prompt.includes('END-OF-DESCRIPTION') && prompt.length <= 2048 + 40, `${prompt.length} chars`)
t('readOnlyHint ⇒ read-only + concurrency-safe; destructiveHint ⇒ destructive', awkward.isReadOnly({}) === true && awkward.isConcurrencySafe({}) === true && (byServerName.get('destructive_op') as { isDestructive?: (i: unknown) => boolean })?.isDestructive?.({}) === true && byServerName.get('boom')?.isReadOnly({}) === false)
t('the user-facing name carries server · title · (MCP)', awkward.userFacingName({}) === `${SERVER} - Awkward (MCP)`, awkward.userFacingName({}))

// The wire grammar: every projected function name must fit the strictest
// dialect Mercury speaks (the OpenAI-family 64-character function name —
// chat-completions AND Responses; Gemini's OpenAI surface too) and the
// Anthropic tool-name pattern (128). One over-long name 400s the WHOLE
// request on those wires, so every server tool disappears with it.
const ANTHROPIC_NAME = /^[a-zA-Z0-9_-]{1,128}$/
const OPENAI_NAME = /^[a-zA-Z0-9_-]{1,64}$/
const projected: string[] = []
for (const tool of tools) {
  const schema = (await toolToAPISchema(tool, { getToolPermissionContext: async () => getEmptyToolPermissionContext(), tools, agents: [], allowedAgentTypes: [], model: 'claude-opus-4-8' })) as { name: string }
  projected.push(schema.name)
}
t('every projected name fits the Anthropic tool-name grammar (128)', projected.every(n => ANTHROPIC_NAME.test(n)), projected.filter(n => !ANTHROPIC_NAME.test(n)).join(', '))
t('every projected name fits the OpenAI-family function-name grammar (64) — the over-long tool included', projected.every(n => OPENAI_NAME.test(n)), projected.filter(n => !OPENAI_NAME.test(n)).join(', '))
t('projected names stay unique', new Set(projected).size === projected.length)
const longTool = byServerName.get('a_tool_whose_name_is_deliberately_far_too_long_for_the_openai_wire_grammar')!
t('the over-long tool keeps its server prefix and its real name in mcpInfo', longTool.name.startsWith(`mcp__${SERVER}__`) && (longTool as { mcpInfo?: { toolName: string } }).mcpInfo?.toolName === 'a_tool_whose_name_is_deliberately_far_too_long_for_the_openai_wire_grammar', longTool.name)
{
  const { wireSafeMcpToolName, buildMcpToolName, getToolNameForPermissionCheck, WIRE_TOOL_NAME_MAX, mcpInfoFromString } = await import('../../src/services/mcp/mcpStringUtils.ts')
  const LONG = 'a_tool_whose_name_is_deliberately_far_too_long_for_the_openai_wire_grammar'
  t('wireSafeMcpToolName: a fitting name is the fully-qualified name, unchanged', wireSafeMcpToolName(SERVER, 'plain.echo') === buildMcpToolName(SERVER, 'plain.echo'))
  const shortened = wireSafeMcpToolName(SERVER, LONG)
  t(`wireSafeMcpToolName: an over-long name fits ${WIRE_TOOL_NAME_MAX} and keeps the server prefix whole`, shortened.length <= WIRE_TOOL_NAME_MAX && shortened.startsWith(`mcp__${SERVER}__`) && OPENAI_NAME.test(shortened), shortened)
  t('…deterministically', wireSafeMcpToolName(SERVER, LONG) === shortened)
  t('…and two long siblings that share a prefix never collide', wireSafeMcpToolName(SERVER, `${LONG}_a`) !== wireSafeMcpToolName(SERVER, `${LONG}_b`))
  t('…and the name parser still reads the server from the shortened spelling', mcpInfoFromString(shortened)?.serverName === SERVER)
  const longServer = 'a-server-whose-own-name-is-far-longer-than-the-wire-grammar-allows-for'
  const both = wireSafeMcpToolName(longServer, LONG)
  t('a server segment that leaves no room is shortened the same way, still within the grammar', both.length <= WIRE_TOOL_NAME_MAX && both.startsWith('mcp__') && OPENAI_NAME.test(both), both)
  t('permission rules keep matching the fully-qualified name through mcpInfo', getToolNameForPermissionCheck({ name: shortened, mcpInfo: { serverName: SERVER, toolName: LONG } }) === buildMcpToolName(SERVER, LONG))
}

// ── I. invocation ───────────────────────────────────────────────────────────
section('I. invocation — what the model calls is what the server ran')
{
  const r = await call(tools, client, byServerName.get('plain.echo')!.name, { text: 'hi' })
  t('a plain call round-trips through the real executor', r.threw === undefined && r.result?.text === 'echo:hi' && !r.result.isError, `threw=${r.threw ?? 'no'} ${JSON.stringify(r.result)}`)
}
{
  const r = await call(tools, client, awkward.name, { mode: 'weird', count: null, items: [{ id: 'a', tags: ['x'] }], choice: 3, unknown_key: { nested: true } })
  const echoed = (() => {
    try {
      return JSON.parse(r.result?.text ?? '{}') as Record<string, unknown>
    } catch {
      return {}
    }
  })()
  t('awkward arguments reach the server verbatim (nulls and unknown keys included)', echoed.mode === 'weird' && echoed.count === null && JSON.stringify(echoed.items) === '[{"id":"a","tags":["x"]}]' && echoed.choice === 3 && JSON.stringify(echoed.unknown_key) === '{"nested":true}', r.result?.text)
}
{
  const r = await call(tools, client, byServerName.get('boom')!.name, {})
  t("an isError result is an is_error tool_result carrying the server's text", r.result?.isError === true && r.result.text.includes('boom failed: the fixture always fails here'), JSON.stringify(r.result))
}
{
  const r = await call(tools, client, byServerName.get('picture')!.name, {})
  const blocks = Array.isArray(r.result?.content) ? (r.result!.content as AnyMsg[]) : []
  const image = blocks.find(b => b.type === 'image') as { source?: { type?: string; media_type?: string; data?: string } } | undefined
  t('an image result is an image block the transcript can carry, beside its caption', image?.source?.type === 'base64' && image.source.media_type === 'image/png' && typeof image.source.data === 'string' && image.source.data.length > 10 && blocks.some(b => b.type === 'text' && String(b.text).includes('a picture')), JSON.stringify(r.result?.content).slice(0, 200))
}
{
  const r = await call(tools, client, byServerName.get('resource_out')!.name, {})
  t('an embedded resource surfaces its text', r.result !== undefined && !r.result.isError && JSON.stringify(r.result.content).includes('resource body'), JSON.stringify(r.result?.content).slice(0, 200))
}
{
  const r = await call(tools, client, byServerName.get('structured')!.name, {})
  t('structured content arrives as JSON text', r.result !== undefined && !r.result.isError && r.result.text.includes('"ok":true'), JSON.stringify(r.result))
}
{
  const r = await call(tools, client, byServerName.get('slow')!.name, { ms: 3000 }, 150)
  t('a slow call aborted mid-flight settles error-shaped within the abort, never hangs', r.threw === undefined && r.result !== undefined && r.result.isError && r.elapsedMs < 2000, `threw=${r.threw ?? 'no'} elapsed=${r.elapsedMs} ${JSON.stringify(r.result)}`)
}
{
  const r = await call(tools, client, byServerName.get('ask')!.name, {})
  t('a form elicitation in a non-interactive session is answered without hanging', r.threw === undefined && r.result !== undefined && r.elapsedMs < 10_000, `threw=${r.threw ?? 'no'} elapsed=${r.elapsedMs} ${JSON.stringify(r.result)}`)
  t('…and the tool reports the harness answer (declined or cancelled, never accepted with invented content)', r.result !== undefined && /answer:.*"action":"(decline|cancel)"/.test(r.result.text) || (r.result?.isError === true), JSON.stringify(r.result))
}
{
  const r = await call(tools, client, byServerName.get('crash')!.name, {})
  t('a server that dies mid-call settles as an error tool_result, the round never rejects', r.threw === undefined && r.result?.isError === true, `threw=${r.threw ?? 'no'} ${JSON.stringify(r.result)}`)
  const again = await connect(SERVER)
  const toolsAgain = (await (async () => {
    ;(mcp.fetchToolsForClient as unknown as { cache: { delete: (k: string) => void } }).cache.delete(SERVER)
    return mcp.fetchToolsForClient(again as never)
  })()) as Tool[]
  const echo = toolsAgain.find(x => (x as { mcpInfo?: { toolName: string } }).mcpInfo?.toolName === 'plain.echo')!
  const r2 = await call(toolsAgain, again, echo.name, { text: 'back' })
  t('a fresh connect brings the server back and a call round-trips again', again.type === 'connected' && r2.result?.text === 'echo:back', `type=${String(again.type)} ${JSON.stringify(r2.result)}`)
  ;(again as { cleanup?: () => Promise<void> }).cleanup?.()
}

// ── P. policy ───────────────────────────────────────────────────────────────
section('P. policy — the allowlist withholds what the operator clamped')
{
  process.env.MERCURY_MCP_MAX_RISK = 'low'
  const clamped = await connect('estate-clamped')
  const clampedTools = (await mcp.fetchToolsForClient(clamped as never)) as Tool[]
  const names = clampedTools.map(x => (x as { mcpInfo?: { toolName: string } }).mcpInfo?.toolName)
  t('under MERCURY_MCP_MAX_RISK=low the destructive-hinted tool is withheld from discovery', !names.includes('destructive_op') && names.includes('awkward-schema-tool'), names.join(', '))
  delete process.env.MERCURY_MCP_MAX_RISK
  ;(clamped as { cleanup?: () => Promise<void> }).cleanup?.()
}

;(client as { cleanup?: () => Promise<void> }).cleanup?.()
rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? `\nALL GREEN (${checks} checks)` : `\n${failures} FAILURE(S) of ${checks}`)
process.exit(failures === 0 ? 0 : 1)
