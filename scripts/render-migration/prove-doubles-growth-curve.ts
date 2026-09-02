#!/usr/bin/env bun
// ============================================================================
//  scripts/render-migration/prove-doubles-growth-curve.ts — the
//  doubled-replies test on the PRODUCT path (spec 10
//  B1 acceptance).
//
//  A LONG scripted session on each wire dialect (Anthropic messages · OpenAI
//  Responses · chat-completions), driven through the REAL model runtime, the
//  REAL turn machine, and the REAL REPL consumption seam:
//
//    queryEvents → legacyYieldsOf → handleMessageFromStream →
//    appendRowWithIdentity → the transcript store's array →
//    the Messages.tsx projection stages (normalize · filter · reorder ·
//    group · receipts · collapse) → renderables.
//
//  Every user turn t answers with a parallel tool round (1/2/5 calls,
//  rotating) and then a settled reply carrying the delimited needle ⟦Rt⟧.
//  After every turn, TWO censuses over needles 1..t:
//    · RECORD census — occurrences among transcript assistant rows;
//    · PROJECTION census — occurrences among renderable rows.
//  The law: every needle counts EXACTLY 1 at EVERY turn index (the curve is
//  flat at 1). A rising curve is the operator's doubled-replies defect.
//  Also armed: E10 flatness (no duplicate renderable uuid at any commit).
//
//  The needle is delimited (⟦R7⟧ never matches inside ⟦R17⟧ — the engine
//  lane's census lesson) and the census validates itself with a control: a
//  deliberately double-appended copy (distinct uuid) must be CAUGHT.
//
//  Run: ~/.bun/bin/bun run scripts/render-migration/prove-doubles-growth-curve.ts
//       [--turns N] [--lanes anthropic,responses,chat]
// ============================================================================
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — doubles growth-curve prover exceeded 280s')
  process.exit(1)
}, 280_000)
watchdog.unref?.()

const argTurns = ((): number => {
  const at = process.argv.indexOf('--turns')
  return at >= 0 ? Math.max(3, Number(process.argv[at + 1]) || 0) : 40
})()

// ── env hygiene BEFORE any src import ───────────────────────────────────────
delete process.env.NODE_ENV
for (const ambient of [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'MERCURY_OAUTH_TOKEN',
  'MERCURY_SCRIPTED_STREAM',
  'MERCURY_SIMPLE',
  'GOOGLE_API_KEY',
  'DISABLE_COMPACT',
  'DISABLE_AUTO_COMPACT',
  'MERCURY_RENDER_ENGINE',
]) {
  delete process.env[ambient]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'doubles-curve-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'doubles-curve-daemon-'))
process.env.MERCURY_TEAMS_DIR = mkdtempSync(join(tmpdir(), 'doubles-curve-teams-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

// ── the loopback fixture: three dialects, one server ────────────────────────
type ScriptedCall = { id: string; name: string; args: string }
type Turn = { calls: ScriptedCall[] } | { text: string }
type Body = Record<string, unknown>
type Dialect = 'anthropic' | 'responses' | 'chat'

let script: { turns: Turn[] } = { turns: [{ text: 'idle' }] }
let requestOrdinal = 0
const captured: Array<{ dialect: Dialect; path: string; body: Body }> = []

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const evt = (name: string, obj: unknown): string => `event: ${name}\n${sse(obj)}`

function anthropicSse(turn: Turn): string {
  const usage = { input_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 3 }
  const out: string[] = [
    evt('message_start', { type: 'message_start', message: { id: `msg_${requestOrdinal}`, type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage } }),
  ]
  if ('calls' in turn) {
    turn.calls.forEach((call, index) => {
      out.push(evt('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } }))
      out.push(evt('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: call.args } }))
      out.push(evt('content_block_stop', { type: 'content_block_stop', index }))
    })
    out.push(evt('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage }))
  } else {
    out.push(evt('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
    out.push(evt('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: turn.text } }))
    out.push(evt('content_block_stop', { type: 'content_block_stop', index: 0 }))
    out.push(evt('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage }))
  }
  out.push(evt('message_stop', { type: 'message_stop' }))
  return out.join('')
}

function responsesSse(turn: Turn): string {
  const out: string[] = [sse({ type: 'response.created', response: { id: `resp_${requestOrdinal}` } })]
  if ('calls' in turn) {
    turn.calls.forEach((call, index) => {
      const itemId = `fc_${requestOrdinal}_${index}`
      out.push(sse({ type: 'response.output_item.added', item: { type: 'function_call', id: itemId, call_id: call.id, name: call.name, arguments: '' } }))
      out.push(sse({ type: 'response.function_call_arguments.delta', item_id: itemId, delta: call.args }))
      out.push(sse({ type: 'response.output_item.done', item: { type: 'function_call', id: itemId, call_id: call.id, name: call.name, arguments: call.args } }))
    })
  } else {
    out.push(sse({ type: 'response.output_text.delta', delta: turn.text }))
    out.push(sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: turn.text }] } }))
  }
  out.push(sse({ type: 'response.completed', response: { id: `resp_${requestOrdinal}`, usage: { input_tokens: 8, output_tokens: 3, input_tokens_details: { cached_tokens: 0 } } } }))
  return out.join('')
}

function chatSse(turn: Turn): string {
  const out: string[] = []
  if ('calls' in turn) {
    turn.calls.forEach((call, index) => {
      out.push(sse({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta: { ...(index === 0 ? { role: 'assistant' } : {}), tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: call.args } }] }, finish_reason: null }] }))
    })
    out.push(sse({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 } }))
  } else {
    out.push(sse({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: turn.text }, finish_reason: null }] }))
    out.push(sse({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 } }))
  }
  out.push('data: [DONE]\n\n')
  return out.join('')
}

const OPENAI_MODELS_BODY = {
  models: [
    {
      slug: 'gpt-5.6-sol',
      display_name: 'GPT-5.6-Sol',
      supported_reasoning_levels: [{ effort: 'low', description: 'low' }, { effort: 'high', description: 'high' }],
      default_reasoning_level: 'low',
      visibility: 'list',
      priority: 1,
      context_window: 272_000,
      input_modalities: ['text', 'image'],
      supported_in_api: true,
    },
  ],
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    let body: Body = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Body
    } catch {
      body = {}
    }
    if (req.method === 'GET' && path.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(path.startsWith('/openai/') ? JSON.stringify(OPENAI_MODELS_BODY) : JSON.stringify({ object: 'list', data: [{ id: 'fixture-local', object: 'model', owned_by: 'fixture' }] }))
      return
    }
    const dialect: Dialect | undefined = path.endsWith('/v1/messages') ? 'anthropic' : path.endsWith('/responses') ? 'responses' : path.endsWith('/chat/completions') ? 'chat' : undefined
    if (req.method === 'POST' && dialect !== undefined) {
      captured.push({ dialect, path, body })
      const turn = script.turns[requestOrdinal] ?? { text: 'script exhausted' }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(dialect === 'anthropic' ? anthropicSse(turn) : dialect === 'responses' ? responsesSse(turn) : chatSse(turn))
      requestOrdinal++
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const port = typeof address === 'object' && address ? address.port : 0
const base = `http://127.0.0.1:${port}`

Object.assign(process.env, {
  ANTHROPIC_BASE_URL: base,
  ANTHROPIC_AUTH_TOKEN: 'fixture-token',
  MERCURY_LOCAL_BASE_URL: base,
  MERCURY_COMPAT_BASE_URL: `${base}/v1`,
  MERCURY_COMPAT_API_KEY: 'fixture-compat-key',
  MERCURY_OPENROUTER_API_BASE: `${base}/openrouter/api/v1`,
  MERCURY_OPENROUTER_AUTH_BASE: `${base}/openrouter/auth`,
  OPENROUTER_API_KEY: 'fixture-openrouter-key',
  MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
  MERCURY_OPENAI_CHATGPT_BASE: `${base}/openai/chatgpt`,
  MERCURY_OPENAI_AUTH_BASE: `${base}/openai/auth`,
  OPENAI_API_KEY: 'fixture-openai-key',
})

console.log('============================================================')
console.log(' doubled-replies growth curve — the REPL seam, every dialect')
console.log(`  turns per lane: ${argTurns}`)
console.log('============================================================')

// ── src imports (after env) ─────────────────────────────────────────────────
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { queryEvents } = await import('../../src/query.ts')
const { legacyYieldsOf } = await import('../../src/run-core/project-legacy.ts')
const { productionDeps } = await import('../../src/query/deps.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { appendRowWithIdentity } = await import('../../src/utils/messages/appendRow.ts')
const { handleMessageFromStream, isDroppedLateStreamFrame } = await import('../../src/utils/messages/streaming.ts')
const { normalizeMessages } = await import('../../src/utils/messages/normalize.ts')
const { isNotEmptyMessage } = await import('../../src/utils/messages/text.ts')
const { reorderMessagesInUI } = await import('../../src/utils/messages/uiOrder.ts')
const { applyGrouping } = await import('../../src/utils/groupToolUses.ts')
const { injectTurnReceipts, isTurnBoundary } = await import('../../src/utils/cockpit/turnReceipt.ts')
const { collapseReadSearchGroups } = await import('../../src/utils/collapseReadSearch.ts')
const { collapseTeammateShutdowns } = await import('../../src/utils/collapseTeammateShutdowns.ts')
const { collapseHookSummaries } = await import('../../src/utils/collapseHookSummaries.ts')
const { collapseBackgroundBashNotifications } = await import('../../src/utils/collapseBackgroundBashNotifications.ts')
const { renderableSearchText } = await import('../../src/utils/transcriptSearch.ts')
const { shouldShowUserMessage, findLastCompactBoundaryIndex } = await import('../../src/utils/messages.ts')
const { isNullRenderingAttachment } = await import('../../src/components/messages/nullRenderingAttachments.ts')
const { RecordFold } = await import('../../src/render-engine/cockpit/recordFold.ts')
const { CockpitLedger } = await import('../../src/render-engine/cockpit/cockpitLedger.ts')
type AnyMsg = Record<string, unknown> & { type?: string; uuid?: string }
type AnyRunEvent = Record<string, unknown> & { kind: string; callId?: string; withheld?: boolean; message?: AnyMsg }

// ── the rig tool ────────────────────────────────────────────────────────────
const EchoTool = {
  name: 'EchoTool',
  async description() {
    return 'EchoTool rig tool'
  },
  async prompt() {
    return 'EchoTool rig tool'
  },
  inputSchema: z.object({ text: z.string() }),
  userFacingName: () => 'EchoTool',
  isEnabled: () => true,
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  isMcp: false,
  needsPermissions: () => false,
  async validateInput() {
    return { result: true }
  },
  async call(input: { text: string }) {
    return { data: `echo:${input.text}` }
  },
  mapToolResultToToolResultBlockParam: (data: unknown, toolUseId: string) => ({
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: String(data),
  }),
} as never
const TOOLS = [EchoTool]

function makeCtx(model: string): Record<string, unknown> {
  let appState: Record<string, unknown> = {
    ...(getDefaultAppState() as unknown as Record<string, unknown>),
    effortValue: 'high',
  }
  return {
    abortController: new AbortController(),
    options: {
      commands: [],
      tools: TOOLS,
      mainLoopModel: model,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
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
}

// ── the REPL consumption seam, replicated with the REAL functions ───────────
type StreamingToolUseT = { index: number; contentBlock: { id: string }; unparsedToolInput: string }

/** One UI session: the transcript array fed exactly the way REPL.tsx feeds
 *  its store (appendRowWithIdentity; tombstone removal; compact-boundary
 *  retention is out of scope — autocompact is disabled in this drive).
 *  With a fold installed, the runEvent path mirrors the REPL's engine-
 *  mounted block verbatim: settlements fold by durable coordinates before
 *  the legacy projection; retractions free their coordinates. */
class UiSession {
  transcript: AnyMsg[] = []
  streamingToolUses: StreamingToolUseT[] = []
  streamingText: string | null = null
  fold: InstanceType<typeof RecordFold> | null = null

  private onMessage = (message: AnyMsg): void => {
    this.transcript = appendRowWithIdentity(this.transcript as never, message as never) as AnyMsg[]
  }
  private onTombstone = (message: AnyMsg): void => {
    this.transcript = this.transcript.filter(m => m.uuid !== message.uuid)
  }

  /** The REPL loop body: fold (when engaged) then project then consume. */
  consumeRunEvent(runEventIn: AnyRunEvent, aborted: boolean): void {
    let runEvent = runEventIn
    if (this.fold && runEvent.kind === 'assistant_settled' && runEvent.withheld !== true) {
      const uuid = runEvent.message?.uuid
      if (typeof uuid === 'string') {
        const folded = this.fold.ingestSettlement(String(runEvent.callId), uuid)
        if (folded.outcome === 'refolded') {
          runEvent = { ...runEvent, message: { ...runEvent.message, uuid: folded.uuid } }
        }
      }
    } else if (this.fold && runEvent.kind === 'assistant_retracted') {
      const uuid = runEvent.message?.uuid
      if (typeof uuid === 'string') this.fold.retractByUuid(uuid)
    }
    for (const event of legacyYieldsOf(runEvent as never)) {
      this.consume(event, aborted)
    }
  }

  consume(event: unknown, aborted: boolean): void {
    if (isDroppedLateStreamFrame(event as { type: string }, aborted)) return
    handleMessageFromStream(
      event as never,
      this.onMessage as never,
      () => {},
      () => {},
      (f: (prev: StreamingToolUseT[]) => StreamingToolUseT[]) => {
        this.streamingToolUses = f(this.streamingToolUses)
      },
      this.onTombstone as never,
      () => {},
      () => {},
      (f: (prev: string | null) => string | null) => {
        this.streamingText = f(this.streamingText)
      },
    )
  }
}

/** The Messages.tsx projection stages (2–8), run with the REAL stage
 *  functions over the transcript — fullscreen shape (the cockpit), verbose
 *  off, no brief tools, no synthetic streaming rows (censuses run settled). */
function projectRenderables(transcript: AnyMsg[]): AnyMsg[] {
  const normalized = normalizeMessages(transcript as never).filter(isNotEmptyMessage as never) as AnyMsg[]
  let working = normalized
  // Stage 2 (fullscreen keeps everything above the boundary — the cockpit).
  void findLastCompactBoundaryIndex
  // Stage 3: hidden rows.
  working = working.filter(message => {
    if (message.type === 'progress') return false
    if (message.type === 'attachment' && isNullRenderingAttachment(message as never)) return false
    if (message.type === 'user' && !shouldShowUserMessage(message as never, false)) return false
    return true
  })
  // Stage 4: display order (no synthetic streaming rows at settle).
  working = reorderMessagesInUI(working as never, [] as never) as AnyMsg[]
  // Stages 7–8.
  let collapsed = applyGrouping(working as never, TOOLS as never, false).messages as AnyMsg[]
  collapsed = injectTurnReceipts(collapsed as never) as AnyMsg[]
  collapsed = collapseReadSearchGroups(collapsed as never, TOOLS as never) as AnyMsg[]
  collapsed = collapseTeammateShutdowns(collapsed as never) as AnyMsg[]
  collapsed = collapseHookSummaries(collapsed as never) as AnyMsg[]
  collapsed = collapseBackgroundBashNotifications(collapsed as never, false) as AnyMsg[]
  return collapsed
}

// Delimited (⟦r7⟧ never matches inside ⟦r17⟧) and lowercase-stable: the
// projection's search text is lowered, the record census reads raw bytes —
// one spelling must count in both.
const needle = (t: number): string => `⟦r${t}⟧`

function countRecord(transcript: AnyMsg[], n: string): number {
  let count = 0
  for (const m of transcript) {
    if (m.type !== 'assistant') continue
    const content = (m.message as { content?: unknown } | undefined)?.content
    if (!Array.isArray(content)) continue
    for (const b of content as AnyMsg[]) {
      if (b.type === 'text' && typeof b.text === 'string') {
        count += b.text.split(n).length - 1
      }
    }
  }
  return count
}

function countProjection(renderables: AnyMsg[], n: string): number {
  let count = 0
  for (const r of renderables) {
    const text = renderableSearchText(r as never)
    count += text.split(n).length - 1
  }
  return count
}

/** E10 flatness: no duplicate renderable uuid. */
function duplicateUuids(renderables: AnyMsg[]): string[] {
  const seen = new Set<string>()
  const dups: string[] = []
  for (const r of renderables) {
    const id = String(r.uuid ?? '')
    if (seen.has(id)) dups.push(id)
    seen.add(id)
  }
  return dups
}

// ── one long session per lane ───────────────────────────────────────────────
const PARALLEL_ROTATION = [1, 2, 5]

async function driveLane(lane: string, model: string, foldOn: boolean): Promise<void> {
  section(`${lane} · ${model} · ${argTurns} turns · fold ${foldOn ? 'ENGAGED' : 'off (today’s path)'}`)
  const ui = new UiSession()
  if (foldOn) ui.fold = new RecordFold()
  let capturedSettlement: AnyRunEvent | null = null
  const deps = productionDeps()
  // The settled-row ledger fed the way Messages.tsx feeds it (every committed
  // projection, receipts as turn boundaries), tripwires LOUD: a divergence
  // between the frozen prefix and a later projection is a projection fault.
  const ledgerViolations: string[] = []
  const ledger = new CockpitLedger(120, { onViolation: d => ledgerViolations.push(d) })
  let worstOffence: { turn: number; needleTurn: number; layer: string; count: number } | null = null
  let flatnessOffence: { turn: number; dups: string[] } | null = null
  let curveMax = 1

  for (let t = 1; t <= argTurns; t++) {
    const k = PARALLEL_ROTATION[(t - 1) % PARALLEL_ROTATION.length]!
    const calls: ScriptedCall[] = Array.from({ length: k }, (_, i) => ({
      id: `call_t${t}_${i}`,
      name: 'EchoTool',
      args: JSON.stringify({ text: `t${t}c${i}` }),
    }))
    script = { turns: [{ calls }, { text: `reply ${needle(t)} settles turn ${t} whole` }] }
    requestOrdinal = 0

    const ctx = makeCtx(model)
    const controller = (ctx as { abortController: AbortController }).abortController
    ui.transcript = appendRowWithIdentity(
      ui.transcript as never,
      createUserMessage({ content: `user turn ${t}` }) as never,
    ) as AnyMsg[]
    const canUseTool = (async (_tool: unknown, input: Record<string, unknown>) => ({
      behavior: 'allow',
      updatedInput: input,
      decisionReason: { type: 'other', reason: 'rig' },
    })) as never
    try {
      const gen = queryEvents({
        messages: ui.transcript.slice() as never,
        systemPrompt: ['fixture system prompt'] as never,
        userContext: {},
        systemContext: {},
        canUseTool,
        toolUseContext: ctx as never,
        querySource: 'sdk' as never,
        deps: {
          callModel: deps.callModel,
          autocompact: (async () => ({ wasCompacted: false })) as never,
          microcompact: (async (messages: unknown[]) => ({ messages })) as never,
          uuid: deps.uuid,
        },
      } as never)
      ui.fold?.beginRun()
      let r = await gen.next()
      while (!r.done) {
        const runEvent = r.value as AnyRunEvent
        // The control's specimen: the FINAL turn's text settlement (same
        // run as the replay below, so the fold's run term matches).
        if (
          t === argTurns &&
          runEvent.kind === 'assistant_settled' &&
          typeof runEvent.callId === 'string' &&
          JSON.stringify(runEvent.message ?? {}).includes(needle(argTurns))
        ) {
          capturedSettlement = runEvent
        }
        ui.consumeRunEvent(runEvent, controller.signal.aborted)
        r = await gen.next()
      }
    } catch (error) {
      check(`turn ${t} never throws`, false, error instanceof Error ? error.message : String(error))
      break
    }

    // ── censuses at turn t ──────────────────────────────────────────────
    const renderables = projectRenderables(ui.transcript)
    ledger.feed(
      renderables.map(r => ({
        uuid: String(r.uuid),
        kind: String(r.type),
        turnHead: isTurnBoundary(r as never),
        text: renderableSearchText(r as never),
      })),
    )
    for (let j = 1; j <= t; j++) {
      const rec = countRecord(ui.transcript, needle(j))
      const proj = countProjection(renderables, needle(j))
      curveMax = Math.max(curveMax, rec, proj)
      if (rec !== 1 && (worstOffence === null || rec > worstOffence.count)) {
        worstOffence = { turn: t, needleTurn: j, layer: 'record', count: rec }
      }
      if (proj !== 1 && (worstOffence === null || proj > worstOffence.count)) {
        worstOffence = { turn: t, needleTurn: j, layer: 'projection', count: proj }
      }
    }
    const dups = duplicateUuids(renderables)
    if (dups.length > 0 && flatnessOffence === null) flatnessOffence = { turn: t, dups }
    if (t % 10 === 0 || t === argTurns) {
      console.log(`  · turn ${t}: transcript ${ui.transcript.length} rows, projection ${renderables.length} renderables, curve max ${curveMax}`)
    }
  }

  check(
    `[${lane}] the occurrences-per-needle curve is CONSTANT 1 across all ${argTurns} turn indices (record + projection)`,
    worstOffence === null,
    worstOffence ? `at turn ${worstOffence.turn}, needle ⟦r${worstOffence.needleTurn}⟧ counted ${worstOffence.count} in the ${worstOffence.layer}` : '',
  )
  check(
    `[${lane}] E10 flatness: no duplicate renderable uuid at any commit`,
    flatnessOffence === null,
    flatnessOffence ? `turn ${flatnessOffence.turn}: ${flatnessOffence.dups.slice(0, 3).join(', ')}` : '',
  )
  if (foldOn) {
    check(`[${lane}] the natural drive needed zero refolds (today’s path is clean)`, ui.fold!.refolds() === 0, String(ui.fold!.refolds()))
  }
  {
    const report = ledger.report()
    check(
      `[${lane}] E1/E2/E10 ledger: the stable prefix froze across the session with zero divergences and zero flatness drops`,
      ledgerViolations.length === 0 && report.divergences === 0 && report.flatnessDrops === 0 && report.settledCount > 0,
      `settled=${report.settledCount} divergences=${report.divergences} drops=${report.flatnessDrops} ${ledgerViolations.slice(0, 2).join(' | ')}`,
    )
  }

  // ── THE RE-PRESENTATION CONTROL (the fold's acceptance, on the REAL event
  // shape): the final turn's text settlement re-presented under a fresh
  // attempt with a fresh uuid — the wire-replay class. The uuid law alone
  // APPENDS it (a second visible copy); the fold REFOLDS it onto the first
  // mint's row and the census stays at 1.
  if (capturedSettlement !== null) {
    const round = String(capturedSettlement.callId).split('.')[0]
    const replay: AnyRunEvent = {
      ...capturedSettlement,
      callId: `${round}.c99`,
      message: { ...capturedSettlement.message, uuid: `replayed-${lane}-0000` },
    }
    const n = needle(argTurns)
    const before = countRecord(ui.transcript, n)
    ui.consumeRunEvent(replay, false)
    const after = countRecord(ui.transcript, n)
    const afterProj = countProjection(projectRenderables(ui.transcript), n)
    if (foldOn) {
      check(
        `[${lane}] FOLD: the re-presented settlement refolds — census stays 1 (record + projection), refolds() counts 1`,
        before === 1 && after === 1 && afterProj === 1 && ui.fold!.refolds() === 1,
        `before=${before} after=${after} proj=${afterProj} refolds=${ui.fold!.refolds()}`,
      )
    } else {
      check(
        `[${lane}] CONTROL: without the fold the uuid law appends the re-presentation — census counts 2 (the class the fold kills)`,
        before === 1 && after === 2 && afterProj === 2,
        `before=${before} after=${after} proj=${afterProj}`,
      )
    }
  } else {
    check(`[${lane}] captured the final turn's settlement for the control`, false)
  }

  // ── the census CONTROL: a planted double must be caught ───────────────────
  const planted = ui.transcript.slice()
  const firstAssistant = planted.find(
    m =>
      m.type === 'assistant' &&
      Array.isArray((m.message as { content?: unknown })?.content) &&
      ((m.message as { content: AnyMsg[] }).content).some(b => b.type === 'text' && String(b.text).includes(needle(1))),
  )
  if (firstAssistant) {
    const copy = JSON.parse(JSON.stringify(firstAssistant)) as AnyMsg
    copy.uuid = 'planted-double-uuid-0000'
    planted.push(copy)
    const rec = countRecord(planted, needle(1))
    const proj = countProjection(projectRenderables(planted), needle(1))
    check(`[${lane}] census control: a planted distinct-uuid copy is COUNTED (record 2, projection 2)`, rec === 2 && proj === 2, `rec=${rec} proj=${proj}`)
  } else {
    check(`[${lane}] census control: found the needle-1 assistant row to plant`, false)
  }
}

const LANES: Array<{ lane: string; model: string }> = [
  { lane: 'anthropic', model: 'claude-opus-4-8' },
  { lane: 'openai-responses', model: 'gpt-5.6-sol' },
  { lane: 'openrouter-chat', model: 'openrouter/fixture/model' },
]
const laneFilter = ((): string[] | null => {
  const at = process.argv.indexOf('--lanes')
  return at >= 0 ? String(process.argv[at + 1] ?? '').split(',') : null
})()

for (const { lane, model } of LANES) {
  if (laneFilter && !laneFilter.some(f => lane.includes(f))) continue
  // Leg A: today's path (fold off) — the baseline truth + the control that
  // shows the class the uuid law cannot stop. Leg B: the fold engaged —
  // the same drive flat, the re-presentation refolded.
  await driveLane(lane, model, false)
  await driveLane(lane, model, true)
}

section('cross-lane facts')
check('every model call left through the loopback fixture', captured.length > 0 && captured.every(c => c.path.startsWith('/')), String(captured.length))

server.close()
console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
