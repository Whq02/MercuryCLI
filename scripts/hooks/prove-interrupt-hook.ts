#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'interrupt-hook-home-')))
const PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'interrupt-hook-proj-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
delete process.env.ANTHROPIC_BASE_URL
delete process.env.MERCURY_EFFORT_LEVEL
delete process.env.MERCURY_BARE
delete process.env.NODE_ENV

import { z } from 'zod/v4'
import { startFixtureApi, type FixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setOriginalCwd(PROJ)
bootstrap.setProjectRoot(PROJ)
bootstrap.setIsInteractive(false)
bootstrap.setSessionTrustAccepted(true)
const { setCwd } = await import('../../src/utils/Shell.ts')
setCwd(PROJ)

const { HOOK_EVENTS } = await import('../../src/entrypoints/sdk/coreTypes.ts')
const { HOOK_EVENTS_SCHEMA_TUPLE } = await import('../../src/entrypoints/sdk/coreSchemas.ts')
const { SettingsSchema } = await import('../../src/utils/settings/types.ts')
const { parseSettingsFile } = await import('../../src/utils/settings/settings.ts')
const { updateHooksConfigSnapshot } = await import('../../src/utils/hooks/hooksConfigSnapshot.ts')
const { query } = await import('../../src/query.ts')
const { ask } = await import('../../src/QueryEngine.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createUserMessage, INTERRUPT_MESSAGE } = await import('../../src/utils/messages.ts')
const { abortWithCut, turnCutWhy, turnCutOf } = await import('../../src/utils/messages/turnCut.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { createFileStateCacheWithSizeLimit, READ_FILE_STATE_CACHE_SIZE } = await import('../../src/utils/fileStateCache.ts')

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail !== '' ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title)
}
const j = (v: unknown): string => JSON.stringify(v)
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the interrupt-hook proof exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

const MARK = join(PROJ, 'interrupt-mark')
const MARK_TIMEOUT = join(PROJ, 'interrupt-mark-timeout')
const SETTINGS = join(HOME, 'settings.json')
const TOOL = 'InterruptProbeTool'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type HookRecord = Record<string, unknown> & { tools?: unknown }
const recordsOf = (path: string): HookRecord[] =>
  existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter(line => line.trim() !== '')
        .map(line => JSON.parse(line) as HookRecord)
    : []
const waitForRecords = async (path: string, count: number): Promise<HookRecord[]> => {
  const by = Date.now() + 8_000
  while (Date.now() < by) {
    const records = recordsOf(path)
    if (records.length >= count) return records
    await sleep(25)
  }
  return recordsOf(path)
}
const appendRecord = (path: string): string => `cat >> "${path}"; printf '\\n' >> "${path}"`
const wire = (hooks: unknown): void => {
  writeFileSync(SETTINGS, JSON.stringify(hooks === null ? {} : { hooks }))
  updateHooksConfigSnapshot()
}
const clearMarks = (): void => {
  rmSync(MARK, { force: true })
  rmSync(MARK_TIMEOUT, { force: true })
}
const observers = {
  Interrupt: [
    { hooks: [{ type: 'command', command: appendRecord(MARK) }] },
    { matcher: 'idle-timeout', hooks: [{ type: 'command', command: appendRecord(MARK_TIMEOUT) }] },
  ],
}
const blocker = {
  Interrupt: [{ hooks: [{ type: 'command', command: `${appendRecord(MARK)}; echo 'the hook says no' >&2; exit 2` }] }],
}

function makeGate(): { open: () => void; promise: Promise<void> } {
  let open!: () => void
  const promise = new Promise<void>(resolve => {
    open = resolve
  })
  return { open, promise }
}

function makeProbeTool(spec: { gate?: Promise<void>; onStart?: () => void } = {}): Record<string, unknown> {
  return {
    name: TOOL,
    isMcp: false,
    inputSchema: z.object({}).passthrough(),
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    interruptBehavior: () => 'cancel' as const,
    checkPermissions: async () => ({ behavior: 'allow', updatedInput: {} }),
    description: async () => 'interrupt probe tool',
    prompt: async () => 'interrupt probe tool prompt',
    mapToolResultToToolResultBlockParam: (data: unknown, id: string) => ({
      type: 'tool_result',
      content: typeof data === 'string' ? data : j(data),
      tool_use_id: id,
    }),
    call: async (_input: unknown, ctx: { abortController: AbortController }) => {
      spec.onStart?.()
      if (spec.gate) {
        await Promise.race([
          spec.gate,
          new Promise<void>(resolve => {
            if (ctx.abortController.signal.aborted) return resolve()
            ctx.abortController.signal.addEventListener('abort', () => resolve(), { once: true })
          }),
        ])
        if (ctx.abortController.signal.aborted) throw new Error('probe tool aborted')
      }
      return { data: 'probe tool ran' }
    },
  }
}

type Driven = { messages: Array<Record<string, unknown>>; terminal: { reason: string } | undefined; api: FixtureApi; abort: AbortController }

async function drive(opts: {
  turns: ScriptedTurn[]
  tools?: Array<Record<string, unknown>>
  cut?: (abort: AbortController, api: FixtureApi, toolStarted: Promise<void>) => Promise<void>
}): Promise<Driven> {
  const api = await startFixtureApi(opts.turns)
  process.env.ANTHROPIC_BASE_URL = api.url
  const abort = new AbortController()
  let toolStartedResolve!: () => void
  const toolStarted = new Promise<void>(resolve => {
    toolStartedResolve = resolve
  })
  let state: Record<string, unknown> = {
    toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'default' as const },
    sessionHooks: new Map(),
    tasks: {},
    todos: {},
    agentNameRegistry: new Map(),
    mcp: { clients: [], tools: [], commands: [], resources: {} },
    fileHistory: { snapshots: new Map(), fileVersions: new Map() },
    attribution: {},
  }
  const tools = opts.tools ?? []
  const toolUseContext: Record<string, unknown> = {
    abortController: abort,
    getAppState: () => state,
    setAppState: (f: (p: Record<string, unknown>) => Record<string, unknown>) => {
      state = f(state)
    },
    messages: [],
    readFileState: createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE),
    toolDecisions: new Map(),
    nestedMemoryAttachmentTriggers: new Set<string>(),
    loadedNestedMemoryPaths: new Set<string>(),
    dynamicSkillDirTriggers: new Set<string>(),
    discoveredSkillNames: new Set<string>(),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    options: {
      commands: [],
      tools,
      mcpClients: [],
      mcpResources: {},
      mainLoopModel: 'claude-opus-4-8',
      thinkingConfig: { type: 'disabled' as const },
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [], allAgents: [] },
      debug: false,
      verbose: false,
    },
  }
  for (const tool of tools) {
    const inner = tool.call as (input: unknown, ctx: unknown) => Promise<unknown>
    tool.call = async (input: unknown, ctx: unknown) => {
      toolStartedResolve()
      return inner(input, ctx)
    }
  }
  if (opts.cut) void opts.cut(abort, api, toolStarted)
  const gen = query({
    messages: [createUserMessage({ content: 'Probe the interrupt.' })],
    systemPrompt: asSystemPrompt(['You are an interrupt probe. Reply tersely.']),
    userContext: {},
    systemContext: {},
    canUseTool: (async () => ({ behavior: 'allow', updatedInput: {} })) as never,
    toolUseContext: toolUseContext as never,
    querySource: 'sdk',
  } as never)
  const messages: Array<Record<string, unknown>> = []
  let terminal: { reason: string } | undefined
  try {
    for (;;) {
      const r = await gen.next()
      if (r.done) {
        terminal = r.value as { reason: string }
        break
      }
      messages.push(r.value as Record<string, unknown>)
    }
  } finally {
    await api.close()
  }
  return { messages, terminal, api, abort }
}

const cutShape = (driven: Driven): string =>
  j({
    terminal: driven.terminal,
    rows: driven.messages
      .filter(m => m.type === 'user' || m.type === 'assistant')
      .map(m => {
        const message = m.message as { role?: string; content?: unknown }
        return { type: m.type, role: message.role, content: message.content, isMeta: m.isMeta, toolUseResult: m.toolUseResult }
      }),
  })

const commonFields = (record: HookRecord, label: string): void => {
  check(`${label}: hook_event_name is Interrupt`, record.hook_event_name === 'Interrupt', j(record.hook_event_name))
  check(`${label}: session_id is the session's own`, record.session_id === bootstrap.getSessionId(), j({ got: record.session_id, want: bootstrap.getSessionId() }))
  check(`${label}: transcript_path names the session's transcript`, typeof record.transcript_path === 'string' && record.transcript_path.includes(String(record.session_id)), j(record.transcript_path))
  check(`${label}: cwd is the working directory`, record.cwd === PROJ, j({ got: record.cwd, want: PROJ }))
  check(`${label}: permission_mode is the session's mode`, record.permission_mode === 'default', j(record.permission_mode))
  check(`${label}: turn_id is the run's own id (a uuid)`, typeof record.turn_id === 'string' && UUID.test(record.turn_id), j(record.turn_id))
}

console.log('============================================================')
console.log(' the Interrupt hook event: once per interrupt, on every abort path, never a say in the cut')
console.log('============================================================')

section('§1 THE VOCABULARY: Interrupt is a hook event the schema accepts')
{
  check("HOOK_EVENTS carries 'Interrupt'", (HOOK_EVENTS as readonly string[]).includes('Interrupt'), j(HOOK_EVENTS))
  check('the schema tuple in coreSchemas.ts agrees element-wise', j(HOOK_EVENTS) === j(HOOK_EVENTS_SCHEMA_TUPLE), j({ types: HOOK_EVENTS, schema: HOOK_EVENTS_SCHEMA_TUPLE }))
  const parsed = SettingsSchema().safeParse({ hooks: observers })
  check(
    'SettingsSchema accepts a hooks.Interrupt entry',
    parsed.success,
    parsed.success ? '' : `the schema refused it: ${parsed.error.issues.map(issue => `${issue.message} at ${issue.path.join('.')}`).join('; ')}`,
  )
  wire(observers)
  const loaded = parseSettingsFile(SETTINGS)
  check(
    'the settings loader keeps the Interrupt hook (no salvage warning names it)',
    loaded.errors.length === 0 && loaded.settings?.hooks?.Interrupt !== undefined,
    j(loaded.errors.map(error => error.message ?? error)),
  )
}

section('§2 ESC MID-TOOL: the hook receives the fields once, the tools array names the ended call')
{
  wire(observers)
  clearMarks()
  const gate = makeGate()
  const driven = await drive({
    turns: [
      { kind: 'tool_use', name: TOOL, input: {}, id: 'toolu_interrupt_1' },
      { kind: 'text', text: 'NEVER REACHED.' },
    ],
    tools: [makeProbeTool({ gate: gate.promise })],
    cut: async (abort, _api, toolStarted) => {
      await toolStarted
      abort.abort()
    },
  })
  check("the turn ended as 'aborted_tools'", driven.terminal?.reason === 'aborted_tools', j(driven.terminal))
  const records = await waitForRecords(MARK, 1)
  check('the Interrupt hook ran exactly once', records.length === 1, records.length === 0 ? `the hook never ran: no record at ${MARK}` : `${records.length} records`)
  const record = records[0] ?? {}
  commonFields(record, 'esc')
  check("reason is turnCut's word for the operator's stop", record.reason === 'operator', j(record.reason))
  check('tools names the tool call the interrupt ended', j(record.tools) === j([TOOL]), j(record.tools))
  check("the operator's stop carries no cut detail", record.detail === undefined, j(record.detail))
  check("the matcher reads the reason: the 'idle-timeout' hook stayed silent", recordsOf(MARK_TIMEOUT).length === 0, j(recordsOf(MARK_TIMEOUT)))
  check('no follow-up model call after the abort', driven.api.messageRequests().length === 1, `${driven.api.messageRequests().length}`)
}

section('§3 THE SDK INTERRUPT MID-STREAM: once, with no tools ended')
{
  wire(observers)
  clearMarks()
  const api = await startFixtureApi([{ kind: 'hang', deltas: ['streaming…'] }])
  process.env.ANTHROPIC_BASE_URL = api.url
  let state: Record<string, unknown> = {
    toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'default' as const },
    sessionHooks: new Map(),
    tasks: {},
    todos: {},
    agentNameRegistry: new Map(),
    mcp: { clients: [], tools: [], commands: [], resources: {} },
    fileHistory: { snapshots: new Map(), fileVersions: new Map() },
    attribution: {},
  }
  const abortController = new AbortController()
  void api.messageRequestStarted(1).then(async () => {
    await sleep(150)
    abortController.abort()
  })
  const out: Array<Record<string, unknown>> = []
  try {
    for await (const msg of ask({
      commands: [],
      prompt: 'Reply once.',
      cwd: PROJ,
      tools: [] as never,
      mcpClients: [],
      canUseTool: (async () => ({ behavior: 'allow', updatedInput: {} })) as never,
      getAppState: (() => state) as never,
      setAppState: ((f: (p: Record<string, unknown>) => Record<string, unknown>) => {
        state = f(state)
      }) as never,
      getReadFileCache: () => createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE),
      setReadFileCache: () => {},
      abortController,
    })) {
      out.push(msg as Record<string, unknown>)
    }
  } finally {
    await api.close()
  }
  const result = out.at(-1) as { type?: string; subtype?: string } | undefined
  check('the SDK stream ends on a result frame after the interruption row', result?.type === 'result' && out.some(m => j(m).includes(INTERRUPT_MESSAGE)), j({ result, rows: out.map(m => m.type) }))
  check('exactly one model call (no post-abort continuation)', api.messageRequests().length === 1, `${api.messageRequests().length}`)
  const records = await waitForRecords(MARK, 1)
  check('the Interrupt hook ran exactly once', records.length === 1, records.length === 0 ? `the hook never ran: no record at ${MARK}` : `${records.length} records`)
  const record = records[0] ?? {}
  commonFields(record, 'sdk')
  check("reason is 'operator'", record.reason === 'operator', j(record.reason))
  check('tools is empty: the stream had announced no call', j(record.tools) === '[]', j(record.tools))
}

section("§4 A TYPED CUT: reason and detail carry turnCut's words (a watchdog's stall mid-tool)")
{
  wire(observers)
  clearMarks()
  const gate = makeGate()
  const driven = await drive({
    turns: [{ kind: 'tool_use', name: TOOL, input: {}, id: 'toolu_interrupt_2' }],
    tools: [makeProbeTool({ gate: gate.promise })],
    cut: async (abort, _api, toolStarted) => {
      await toolStarted
      abortWithCut(abort, 'stalled')
    },
  })
  check("the turn ended as 'aborted_tools'", driven.terminal?.reason === 'aborted_tools', j(driven.terminal))
  const records = await waitForRecords(MARK, 1)
  check('the Interrupt hook ran exactly once', records.length === 1, `${records.length} records`)
  const record = records[0] ?? {}
  check("reason is 'idle-timeout'", record.reason === 'idle-timeout', j(record.reason))
  check("detail carries the cut's words from the one table", record.detail === turnCutWhy(turnCutOf('stalled')), j({ got: record.detail, want: turnCutWhy(turnCutOf('stalled')) }))
  const timeoutRecords = await waitForRecords(MARK_TIMEOUT, 1)
  check("the 'idle-timeout' matcher fired this time", timeoutRecords.length === 1 && timeoutRecords[0]?.reason === 'idle-timeout', j(timeoutRecords))
}

section('§5 A BLOCKING EXIT CHANGES NOTHING: the cut is byte-identical with and without the hook')
{
  const runCut = async (): Promise<Driven> => {
    const gate = makeGate()
    return drive({
      turns: [{ kind: 'tool_use', name: TOOL, input: {}, id: 'toolu_interrupt_3' }],
      tools: [makeProbeTool({ gate: gate.promise })],
      cut: async (abort, _api, toolStarted) => {
        await toolStarted
        abort.abort()
      },
    })
  }
  wire(blocker)
  clearMarks()
  const withHook = await runCut()
  const blockedRecords = await waitForRecords(MARK, 1)
  check('the exit-2 hook ran once', blockedRecords.length === 1, `${blockedRecords.length} records`)
  wire(null)
  clearMarks()
  const withoutHook = await runCut()
  await sleep(300)
  check('with no hook wired nothing runs', recordsOf(MARK).length === 0)
  check("both cuts end as 'aborted_tools'", withHook.terminal?.reason === 'aborted_tools' && withoutHook.terminal?.reason === 'aborted_tools', j({ withHook: withHook.terminal, withoutHook: withoutHook.terminal }))
  check('the transcript rows of the cut are byte-identical with and without the blocking hook', cutShape(withHook) === cutShape(withoutHook), `${cutShape(withHook).slice(0, 400)} vs ${cutShape(withoutHook).slice(0, 400)}`)
  check("the hook's stderr reached no row", !withHook.messages.some(m => j(m).includes('the hook says no')))
}

section('§6 A TURN THAT ENDS NORMALLY FIRES NO Interrupt')
{
  wire(observers)
  clearMarks()
  const driven = await drive({
    turns: [
      { kind: 'tool_use', name: TOOL, input: {}, id: 'toolu_interrupt_4' },
      { kind: 'text', text: 'DONE.' },
    ],
    tools: [makeProbeTool()],
  })
  check("the turn ended as 'completed'", driven.terminal?.reason === 'completed', j(driven.terminal))
  await sleep(400)
  check('no Interrupt record was written', recordsOf(MARK).length === 0 && recordsOf(MARK_TIMEOUT).length === 0, j({ mark: recordsOf(MARK), timeout: recordsOf(MARK_TIMEOUT) }))
}

wire(null)
rmSync(HOME, { recursive: true, force: true })
rmSync(PROJ, { recursive: true, force: true })
console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
console.log(failures === 0 ? 'INTERRUPT HOOK GREEN' : `${failures} INTERRUPT HOOK FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
