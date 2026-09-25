#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { z } from 'zod/v4'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.MERCURY_TOOL_SEARCH
delete process.env.MERCURY_TOOL_DEFER

const { runToolUse } = await import('../../src/services/tools/toolExecution.ts')
const { subscribeToolStart } = await import('../../src/services/run/effectObserver.ts')
const toolModule = await import('../../src/Tool.ts')
const { findToolByName, getEmptyToolPermissionContext } = toolModule
const closestToolByName = (toolModule as { closestToolByName?: (tools: unknown, name: string) => { name: string } | undefined }).closestToolByName
const suggestionBound = (toolModule as { TOOL_NAME_SUGGESTION_MAX_DISTANCE?: number }).TOOL_NAME_SUGGESTION_MAX_DISTANCE
const { getAllBaseTools } = await import('../../src/tools.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title)
}
const j = (v: unknown): string => JSON.stringify(v)

const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the tool-name recovery proof exceeded 60s')
  process.exit(1)
}, 60_000)
guard.unref?.()

const starts: Array<{ toolName: string }> = []
subscribeToolStart(e => starts.push(e as never))

type FakeTool = Record<string, unknown> & { name: string }
function makeTool(name: string, over: Record<string, unknown> = {}): FakeTool {
  return {
    name,
    isMcp: false,
    inputSchema: z.object({}).passthrough(),
    checkPermissions: async () => ({ behavior: 'allow', updatedInput: undefined }),
    mapToolResultToToolResultBlockParam: (data: unknown, id: string) => ({
      type: 'tool_result',
      content: typeof data === 'string' ? data : j(data),
      tool_use_id: id,
    }),
    call: async () => ({ data: `${name} ran` }),
    ...over,
  }
}

function makeContext(tools: FakeTool[], messages: unknown[]): Record<string, unknown> {
  const appState = {
    toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'default' as never },
    denialTracking: undefined,
    sessionHooks: new Map(),
    mcp: { clients: [], tools: [], commands: [], resources: {} },
  }
  return {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    messages,
    agentType: undefined,
    agentId: undefined,
    toolDecisions: new Map(),
    readFileState: new Map(),
    options: { tools, mcpClients: [], isNonInteractiveSession: true },
  }
}

const ASSISTANT = { uuid: 'uuid-name', requestId: 'req_name', message: { id: 'msg_name' } } as never
const ALLOW = async (_t: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input })

type Block = { type: string; content?: unknown; is_error?: boolean }
type Outcome = { text: string; isError: boolean; started: string[] }
async function call(tools: FakeTool[], name: string, messages: unknown[] = []): Promise<Outcome> {
  starts.length = 0
  const ctx = makeContext(tools, messages)
  let result: Block | undefined
  for await (const update of runToolUse(
    { type: 'tool_use', id: 'toolu_name', name, input: {} } as never,
    ASSISTANT,
    ALLOW as never,
    ctx as never,
  )) {
    const content = (update as { message?: { message?: { content?: Block[] } } }).message?.message?.content
    const block = Array.isArray(content) ? content.find(b => b.type === 'tool_result') : undefined
    if (block !== undefined) result = block
  }
  const text = String(result?.content ?? '').replace(/^<tool_use_error>/, '').replace(/<\/tool_use_error>$/, '')
  return { text, isError: result?.is_error === true, started: starts.map(s => s.toolName) }
}

const admission = (names: string[]): unknown[] => [
  {
    type: 'user',
    uuid: 'uuid-admit',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_admit', content: names.map(n => ({ type: 'tool_reference', tool_name: n })) }],
    },
  },
]

const ROSTER = (): FakeTool[] => [
  makeTool('Read'),
  makeTool('Bash'),
  makeTool('Grep'),
  makeTool('Glob'),
  makeTool('Edit'),
  makeTool('ToolSearch'),
  makeTool('WebFetch', { shouldDefer: true }),
  makeTool('mcp__filesys__read_file', { isMcp: true }),
]

const BARE_TAIL = "It is not in this session's tool list — call one of the tools you were given (a ToolSearch query loads a deferred tool when one is offered)."

console.log('============================================================')
console.log(' Tool-name recovery — the fold, the suggestion, the bound')
console.log('============================================================')

section('§1 a case miss folds onto the advertised name and executes as the real tool')
{
  const lower = await call(ROSTER(), 'read')
  check('`read` executes as Read (no refusal)', !lower.isError && lower.text === 'Read ran', j(lower))
  check('…and the start observation names the canonical tool', lower.started.join(',') === 'Read', j(lower.started))
  const shout = await call(ROSTER(), 'BASH')
  check('`BASH` executes as Bash', !shout.isError && shout.text === 'Bash ran', j(shout))
  const mixed = await call(ROSTER(), 'gReP')
  check('`gReP` executes as Grep', !mixed.isError && mixed.text === 'Grep ran', j(mixed))
}

section('§2 an MCP-prefixed name folds the same way')
{
  const mcp = await call(ROSTER(), 'MCP__Filesys__Read_File')
  check('`MCP__Filesys__Read_File` executes as mcp__filesys__read_file', !mcp.isError && mcp.text === 'mcp__filesys__read_file ran', j(mcp))
  check('…observed under the canonical MCP name', mcp.started.join(',') === 'mcp__filesys__read_file', j(mcp.started))
}

section('§3 no fold fits: the refusal names the closest advertised tool inside the bound')
{
  const grep = await call(ROSTER(), 'grep_tool')
  check('`grep_tool` is refused', grep.isError && grep.text.startsWith('No such tool available: grep_tool'), grep.text)
  check('…with "did you mean `Grep`"', /[Dd]id you mean `Grep`\?/.test(grep.text), grep.text)
  check('…and nothing ran', grep.started.length === 0, j(grep.started))
  const typo = await call(ROSTER(), 'Raed')
  check('`Raed` (two edits) is refused naming `Read`', typo.isError && /[Dd]id you mean `Read`\?/.test(typo.text), typo.text)
  const bsh = await call(ROSTER(), 'Bsh')
  check('`Bsh` (one edit) is refused naming `Bash`', bsh.isError && /[Dd]id you mean `Bash`\?/.test(bsh.text), bsh.text)
  const readFile = await call(ROSTER(), 'read_file')
  check('`read_file` (the right head, a generic tail) is refused naming `Read`', readFile.isError && /[Dd]id you mean `Read`\?/.test(readFile.text), readFile.text)
  const loaded = await call(ROSTER(), 'grep_tool')
  check('a suggestion for a loaded tool names no ToolSearch road', !/select:/.test(loaded.text), loaded.text)
}

section('§4 the closest tool is deferred: the suggestion carries the load road the tool-search hint speaks')
{
  const unadmitted = await call(ROSTER(), 'web_fetch')
  check('`web_fetch` is refused naming `WebFetch`', unadmitted.isError && /[Dd]id you mean `WebFetch`\?/.test(unadmitted.text), unadmitted.text)
  check('…and, unadmitted, names the ToolSearch select road', /ToolSearch/.test(unadmitted.text) && /select:WebFetch/.test(unadmitted.text), unadmitted.text)
  const admitted = await call(ROSTER(), 'web_fetch', admission(['WebFetch']))
  check('once admitted, the same miss still names `WebFetch`', admitted.isError && /[Dd]id you mean `WebFetch`\?/.test(admitted.text), admitted.text)
  check('…without the load road', !/select:WebFetch/.test(admitted.text), admitted.text)
}

section('§5 a miss beyond the bound keeps today\'s refusal wording, with no suggestion')
{
  const far = await call(ROSTER(), 'NoSuchTool')
  check('`NoSuchTool` is refused with the bare sentence', far.isError && far.text === `No such tool available: NoSuchTool. ${BARE_TAIL}`, far.text)
  check('…and no "did you mean"', !/did you mean/i.test(far.text), far.text)
  const frob = await call(ROSTER(), 'Frobnicate')
  check('`Frobnicate` is refused with no suggestion', frob.isError && !/did you mean/i.test(frob.text) && frob.text.endsWith(BARE_TAIL), frob.text)
  const empty = await call(ROSTER(), '')
  check('an empty name is refused with no suggestion', empty.isError && !/did you mean/i.test(empty.text), empty.text)
}

section('§6 the exact road is untouched')
{
  const exact = await call(ROSTER(), 'Read')
  check('`Read` executes as Read', !exact.isError && exact.text === 'Read ran' && exact.started.join(',') === 'Read', j(exact))
  const twins = (): FakeTool[] => [...ROSTER(), makeTool('Foo'), makeTool('foo')]
  const upper = await call(twins(), 'Foo')
  check('with `Foo` and `foo` both advertised, `Foo` runs Foo', !upper.isError && upper.text === 'Foo ran', j(upper))
  const lowerTwin = await call(twins(), 'foo')
  check('…and `foo` runs foo', !lowerTwin.isError && lowerTwin.text === 'foo ran', j(lowerTwin))
  const ambiguous = await call(twins(), 'FOO')
  check('…and `FOO`, a fold that fits two, is refused rather than guessed', ambiguous.isError && ambiguous.text.startsWith('No such tool available: FOO'), j(ambiguous))
}

section('§7 the lookup laws in src/Tool.ts')
{
  const tools = ROSTER() as never
  check('findToolByName: exact first', findToolByName(tools, 'Read')?.name === 'Read')
  check('findToolByName: the fold on a miss', findToolByName(tools, 'read')?.name === 'Read')
  check('findToolByName: the fold reaches an MCP name', findToolByName(tools, 'MCP__FILESYS__READ_FILE')?.name === 'mcp__filesys__read_file')
  check('findToolByName: a separator difference is not a fold', findToolByName(tools, 'web_fetch') === undefined)
  const aliased = [makeTool('SendUserMessage', { aliases: ['Brief'] })] as never
  check('findToolByName: an alias folds too', findToolByName(aliased, 'brief')?.name === 'SendUserMessage')
  const twins = [makeTool('Foo'), makeTool('foo')] as never
  check('findToolByName: two advertised names that fold to one keep the exact road only', findToolByName(twins, 'Foo')?.name === 'Foo' && findToolByName(twins, 'foo')?.name === 'foo' && findToolByName(twins, 'FOO') === undefined)
  check('closestToolByName is exported from src/Tool.ts', typeof closestToolByName === 'function')
  check('the bound is one named constant, a small integer', Number.isInteger(suggestionBound) && (suggestionBound as number) >= 1 && (suggestionBound as number) <= 3, String(suggestionBound))
  if (typeof closestToolByName === 'function') {
    check('closest: `grep_tool` → Grep', closestToolByName(tools, 'grep_tool')?.name === 'Grep')
    check('closest: `web_fetch` → WebFetch', closestToolByName(tools, 'web_fetch')?.name === 'WebFetch')
    check('closest: `WebFetchTool` → WebFetch', closestToolByName(tools, 'WebFetchTool')?.name === 'WebFetch')
    check('closest: `Globb` → Glob', closestToolByName(tools, 'Globb')?.name === 'Glob')
    check('closest: `mcp__filesys__read_fil` → the MCP name', closestToolByName(tools, 'mcp__filesys__read_fil')?.name === 'mcp__filesys__read_file')
    check('closest: `NoSuchTool` → nothing', closestToolByName(tools, 'NoSuchTool') === undefined)
    check('closest: `Frobnicate` → nothing', closestToolByName(tools, 'Frobnicate') === undefined)
    check('closest: an empty name → nothing', closestToolByName(tools, '') === undefined)
    check('closest: a one-letter head is no evidence (`s_fetch` → nothing)', closestToolByName(tools, 's_fetch') === undefined)
    check('closest: an empty roster → nothing', closestToolByName([] as never, 'Read') === undefined)
  }
}

section('§8 the live catalogue: no two built-in names fold to one, so the fold is never ambiguous for a built-in')
{
  const names = getAllBaseTools().map(t => t.name)
  const folded = new Map<string, string[]>()
  for (const name of names) {
    const key = name.toLowerCase()
    folded.set(key, [...(folded.get(key) ?? []), name])
  }
  const collisions = [...folded.values()].filter(group => group.length > 1)
  check(`the ${names.length} built-in names fold to ${folded.size} distinct keys`, collisions.length === 0, j(collisions))
}

console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS — tool-name recovery' : `  ${failures} FAILURE(S) — tool-name recovery`)
process.exit(failures === 0 ? 0 : 1)
