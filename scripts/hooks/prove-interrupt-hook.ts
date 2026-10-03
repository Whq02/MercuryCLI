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

const { HOOK_EVENTS } = await import('../../src/utils/hooks/contract.ts')
const { SettingsSchema } = await import('../../src/utils/settings/types.ts')
const { parseSettingsFile } = await import('../../src/utils/settings/settings.ts')
const { updateHooksConfigSnapshot } = await import('../../src/utils/hooks/hooksConfigSnapshot.ts')
const { query } = await import('../../src/query.ts')
const { ask } = await import('../../src/rows/turn.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createUserMessage, INTERRUPT_MESSAGE } = await import('../../src/utils/messages.ts')
const { abortWithCut, turnCutWhy, turnCutOf } = await import('../../src/utils/messages/turnCut.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { createFileStateCacheWithSizeLimit, READ_FILE_STATE_CACHE_SIZE } = await import('../../src/utils/fileStateCache.ts')
const toolHooks = (await import('../../src/services/tools/toolHooks.ts')) as { INTERRUPT_FAILURE_HOOK_BUDGET_MS?: unknown }

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
  writeFileSync(SETTINGS, JSON.stringify(hooks === null ? {} : { events: { hooks } }))
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

function makeProbeTool(spec: { gate?: Promise<void>; onStart?: () => void; answersAbort?: boolean } = {}): Record<string, unknown> {
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
        if (ctx.abortController.signal.aborted) {
          throw spec.answersAbort ? Object.assign(new Error('probe tool aborted'), { name: 'AbortError' }) : new Error('probe tool aborted')
        }
      }
      return { data: 'probe tool ran' }
    },
  }
}

type Driven = { messages: Array<Record<string, unknown>>; terminal: { reason: string } | undefined; api: FixtureApi; abort: AbortController; settledAt: number }

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
  let settledAt = 0
  try {
    for (;;) {
      const r = await gen.next()
      if (r.done) {
        terminal = r.value as { reason: string }
        settledAt = Date.now()
        break
      }
      messages.push(r.value as Record<string, unknown>)
    }
  } finally {
    await api.close()
  }
  return { messages, terminal, api, abort, settledAt }
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
  const parsed = SettingsSchema().safeParse({ events: { hooks: observers } })
  check(
    'SettingsSchema accepts an events.hooks.Interrupt entry',
    parsed.success,
    parsed.success ? '' : `the schema refused it: ${parsed.error.issues.map(issue => `${issue.message} at ${issue.path.join('.')}`).join('; ')}`,
  )
  wire(observers)
  const loaded = parseSettingsFile(SETTINGS)
  check(
    'the settings loader keeps the Interrupt hook (no salvage warning names it)',
    loaded.errors.length === 0 && loaded.settings?.events?.hooks?.Interrupt !== undefined,
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
  const conversation: Array<Record<string, unknown>> = []
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
      mutableMessages: conversation as never,
    })) {
      out.push(msg as Record<string, unknown>)
    }
  } finally {
    await api.close()
  }
  const result = out.at(-1) as { type?: string; status?: string } | undefined
  check('the rows stream ends on an interrupted outcome and the interruption line lands in the conversation', result?.type === 'outcome' && result.status === 'interrupted' && conversation.some(m => j(m).includes(INTERRUPT_MESSAGE)), j({ result, rows: out.map(m => m.type) }))
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

section("§7 THE ESC'S OWN BUDGET: the ended tool's PostToolUseFailure hook cannot hold the settle past the cut budget")
{
  const BUDGET_MS = 1500
  const SLACK_MS = 1000
  const HOOK_TIMEOUT_S = 4
  const PID = join(PROJ, 'failure-hook-pid')
  const FAILURE_MARK = join(PROJ, 'failure-mark')
  const failureHook = (command: string, timeout: number): unknown => ({
    PostToolUseFailure: [{ matcher: TOOL, hooks: [{ type: 'command', command, timeout }] }],
  })
  const sleeper = `echo $$ > "${PID}"; exec sleep 60`
  const pidAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const failureRows = (driven: Driven): Array<Record<string, unknown>> =>
    driven.messages
      .filter(m => m.type === 'attachment')
      .map(m => m.attachment as Record<string, unknown>)
      .filter(a => a.hookEvent === 'PostToolUseFailure')
  const runEsc = async (id: string): Promise<Driven & { cutAt: number }> => {
    const gate = makeGate()
    let cutAt = 0
    const driven = await drive({
      turns: [{ kind: 'tool_use', name: TOOL, input: {}, id }],
      tools: [makeProbeTool({ gate: gate.promise, answersAbort: true })],
      cut: async (abort, _api, toolStarted) => {
        await toolStarted
        cutAt = Date.now()
        abort.abort()
      },
    })
    return { ...driven, cutAt }
  }

  const budget = toolHooks.INTERRUPT_FAILURE_HOOK_BUDGET_MS
  check(`toolHooks.ts names the cut's budget: INTERRUPT_FAILURE_HOOK_BUDGET_MS is ${BUDGET_MS}`, budget === BUDGET_MS, `the export is ${j(budget)}`)

  wire(failureHook(sleeper, HOOK_TIMEOUT_S))
  rmSync(PID, { force: true })
  const slow = await runEsc('toolu_interrupt_5')
  const settleMs = slow.settledAt - slow.cutAt
  const pid = existsSync(PID) ? Number(readFileSync(PID, 'utf8').trim()) : NaN
  console.log(`  measured: the Esc settled ${settleMs}ms after the cut (the hook sleeps 60s under a ${HOOK_TIMEOUT_S}s timeout; the budget is ${BUDGET_MS}ms)`)
  check("the turn ended as 'aborted_tools'", slow.terminal?.reason === 'aborted_tools', j(slow.terminal))
  check('the failure hook ran for the ended call (it wrote its pid)', Number.isInteger(pid) && pid > 0, existsSync(PID) ? readFileSync(PID, 'utf8') : `no pid file at ${PID}`)
  check(
    "the Esc settled within the cut budget, not the hook's own timeout",
    settleMs < HOOK_TIMEOUT_S * 1000 && settleMs <= BUDGET_MS + SLACK_MS,
    `settled ${settleMs}ms after the Esc: the cut waited for the operator's hook (a 60s sleep under a ${HOOK_TIMEOUT_S}s timeout) — the budget is ${BUDGET_MS}ms`,
  )
  await sleep(200)
  check('the hook was ended at the budget: its process is gone', Number.isInteger(pid) && !pidAlive(pid), `pid ${pid} is still alive`)
  const slowRows = failureRows(slow)
  check(
    "the cut's transcript records the hook's end as its cancelled row under the PostToolUseFailure name",
    slowRows.some(a => a.type === 'hook_cancelled' && a.hookName === `PostToolUseFailure:${TOOL}`),
    `the rows: ${j(slowRows.map(a => ({ type: a.type, hookName: a.hookName, stderr: a.stderr })))}`,
  )
  check('no follow-up model call after the Esc', slow.api.messageRequests().length === 1, `${slow.api.messageRequests().length}`)

  wire(failureHook(sleeper, 1))
  rmSync(PID, { force: true })
  const clocked = await runEsc('toolu_interrupt_6')
  const clockedMs = clocked.settledAt - clocked.cutAt
  console.log(`  measured: with the hook's own timeout at 1s the Esc settled ${clockedMs}ms after the cut`)
  check("a hook timeout shorter than the budget still bounds it: the settle came inside the budget's window", clockedMs <= BUDGET_MS + SLACK_MS, `settled ${clockedMs}ms after the Esc`)
  check(
    "and the transcript records the hook's own timeout, not the budget's cancellation",
    failureRows(clocked).some(a => a.type === 'hook_non_blocking_error' && /timed out after 1s/.test(String(a.stderr))) && !failureRows(clocked).some(a => a.type === 'hook_cancelled'),
    j(failureRows(clocked).map(a => ({ type: a.type, stderr: a.stderr }))),
  )

  wire(failureHook(appendRecord(FAILURE_MARK), HOOK_TIMEOUT_S))
  rmSync(FAILURE_MARK, { force: true })
  const quick = await runEsc('toolu_interrupt_7')
  const quickMs = quick.settledAt - quick.cutAt
  const quickRecords = await waitForRecords(FAILURE_MARK, 1)
  console.log(`  measured: with a hook that answers at once the Esc settled ${quickMs}ms after the cut`)
  check(
    'a quick hook lands whole inside the budget: one record, is_interrupt true, naming the ended call',
    quickRecords.length === 1 && quickRecords[0]?.hook_event_name === 'PostToolUseFailure' && quickRecords[0]?.is_interrupt === true && quickRecords[0]?.tool_name === TOOL,
    j(quickRecords),
  )
  check('the quick hook was never cut: no cancelled row, the settle inside the budget', quickMs < BUDGET_MS && !failureRows(quick).some(a => a.type === 'hook_cancelled'), j({ settleMs: quickMs, rows: failureRows(quick).map(a => a.type) }))
}

wire(null)
rmSync(HOME, { recursive: true, force: true })
rmSync(PROJ, { recursive: true, force: true })
console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
console.log(failures === 0 ? 'INTERRUPT HOOK GREEN' : `${failures} INTERRUPT HOOK FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
