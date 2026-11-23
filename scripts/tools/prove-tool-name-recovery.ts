#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { z } from 'zod/v4'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.MERCURY_TOOL_SEARCH
delete process.env.MERCURY_TOOL_DEFER

const { runToolUse } = await import('../../src/engine/tool-dispatch/toolExecution.ts')
const { subscribeToolStart } = await import('../../src/engine/run-owner/effectObserver.ts')
const toolModule = await import('../../src/tools/kit/tool.ts')
const { findToolByName, getEmptyToolPermissionContext } = toolModule
const closestToolByName = (toolModule as { closestToolByName?: (tools: unknown, name: string) => { name: string } | undefined }).closestToolByName
const suggestionBound = (toolModule as { TOOL_NAME_SUGGESTION_MAX_DISTANCE?: number }).TOOL_NAME_SUGGESTION_MAX_DISTANCE
const { getAllBaseTools } = await import('../../src/tools/kit/toolList.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title)
}
const j = (v: unknown): string => JSON.stringify(v)
const FOLD_HINT = ' | change the case fold in findToolByName (src/tools/kit/tool.ts) or how runToolUse resolves the requested name (src/engine/tool-dispatch/toolExecution.ts)'
const SUGGEST_HINT = ' | change closestToolByName (src/tools/kit/tool.ts) or the unknown-tool refusal text built in runToolUse (src/engine/tool-dispatch/toolExecution.ts)'
const LOOKUP_HINT = 'change findToolByName, closestToolByName or TOOL_NAME_SUGGESTION_MAX_DISTANCE in src/tools/kit/tool.ts'

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

const BARE_TAIL = "It is not in this session's tool list — call one of the tools you were given: Read, Bash, Grep, Glob, Edit, ToolSearch, WebFetch, mcp__filesys__read_file (a ToolSearch query loads a deferred tool when one is offered)."

console.log('============================================================')
console.log(' Tool-name recovery — the fold, the suggestion, the bound')
console.log('============================================================')

section('§1 a case miss folds onto the advertised name and executes as the real tool')
{
  const lower = await call(ROSTER(), 'read')
  check('`read` executes as Read (no refusal)', !lower.isError && lower.text === 'Read ran', j(lower) + FOLD_HINT)
  check('…and the start observation names the canonical tool', lower.started.join(',') === 'Read', j(lower.started) + FOLD_HINT)
  const shout = await call(ROSTER(), 'BASH')
  check('`BASH` executes as Bash', !shout.isError && shout.text === 'Bash ran', j(shout) + FOLD_HINT)
  const mixed = await call(ROSTER(), 'gReP')
  check('`gReP` executes as Grep', !mixed.isError && mixed.text === 'Grep ran', j(mixed) + FOLD_HINT)
}

section('§2 an MCP-prefixed name folds the same way')
{
  const mcp = await call(ROSTER(), 'MCP__Filesys__Read_File')
  check('`MCP__Filesys__Read_File` executes as mcp__filesys__read_file', !mcp.isError && mcp.text === 'mcp__filesys__read_file ran', j(mcp) + FOLD_HINT)
  check('…observed under the canonical MCP name', mcp.started.join(',') === 'mcp__filesys__read_file', j(mcp.started) + FOLD_HINT)
}

section('§3 no fold fits: the refusal names the closest advertised tool inside the bound')
{
  const grep = await call(ROSTER(), 'grep_tool')
  check('`grep_tool` is refused', grep.isError && grep.text.startsWith('No such tool available: grep_tool'), grep.text + SUGGEST_HINT)
  check('…with "did you mean `Grep`"', /[Dd]id you mean `Grep`\?/.test(grep.text), grep.text + SUGGEST_HINT)
  check('…and nothing ran', grep.started.length === 0, j(grep.started) + SUGGEST_HINT)
  const typo = await call(ROSTER(), 'Raed')
  check('`Raed` (two edits) is refused naming `Read`', typo.isError && /[Dd]id you mean `Read`\?/.test(typo.text), typo.text + SUGGEST_HINT)
  const bsh = await call(ROSTER(), 'Bsh')
  check('`Bsh` (one edit) is refused naming `Bash`', bsh.isError && /[Dd]id you mean `Bash`\?/.test(bsh.text), bsh.text + SUGGEST_HINT)
  const readFile = await call(ROSTER(), 'read_file')
  check('`read_file` (the right head, a generic tail) is refused naming `Read`', readFile.isError && /[Dd]id you mean `Read`\?/.test(readFile.text), readFile.text + SUGGEST_HINT)
  const loaded = await call(ROSTER(), 'grep_tool')
  check('a suggestion for a loaded tool names no ToolSearch road', !/select:/.test(loaded.text), loaded.text + SUGGEST_HINT)
}

section('§4 the closest tool is deferred: the suggestion carries the load road the tool-search hint speaks')
{
  const unadmitted = await call(ROSTER(), 'web_fetch')
  check('`web_fetch` is refused naming `WebFetch`', unadmitted.isError && /[Dd]id you mean `WebFetch`\?/.test(unadmitted.text), unadmitted.text + SUGGEST_HINT)
  check('…and, unadmitted, names the ToolSearch select road', /ToolSearch/.test(unadmitted.text) && /select:WebFetch/.test(unadmitted.text), unadmitted.text + ' | the load road comes from loadRoadSentence and buildSchemaNotSentHint in runToolUse (src/engine/tool-dispatch/toolExecution.ts)')
  const admitted = await call(ROSTER(), 'web_fetch', admission(['WebFetch']))
  check('once admitted, the same miss still names `WebFetch`', admitted.isError && /[Dd]id you mean `WebFetch`\?/.test(admitted.text), admitted.text + SUGGEST_HINT)
  check('…without the load road', !/select:WebFetch/.test(admitted.text), admitted.text + ' | an admitted tool must not get the load road: check buildSchemaNotSentHint in runToolUse (src/engine/tool-dispatch/toolExecution.ts)')
}

section('§5 a miss beyond the bound keeps today\'s refusal wording, with no suggestion')
{
  const far = await call(ROSTER(), 'NoSuchTool')
  check('`NoSuchTool` is refused with the bare sentence', far.isError && far.text === `No such tool available: NoSuchTool. ${BARE_TAIL}`, far.text + ' | beyond TOOL_NAME_SUGGESTION_MAX_DISTANCE (src/tools/kit/tool.ts) the refusal must stay the bare sentence built in runToolUse (src/engine/tool-dispatch/toolExecution.ts)')
  check('…and no "did you mean"', !/did you mean/i.test(far.text), far.text + SUGGEST_HINT)
  const frob = await call(ROSTER(), 'Frobnicate')
  check('`Frobnicate` is refused with no suggestion', frob.isError && !/did you mean/i.test(frob.text) && frob.text.endsWith(BARE_TAIL), frob.text + SUGGEST_HINT)
  const empty = await call(ROSTER(), '')
  check('an empty name is refused with no suggestion', empty.isError && !/did you mean/i.test(empty.text), empty.text + SUGGEST_HINT)
}

section('§5b a retired spelling fails as an unknown input, and the refusal names the current tools so a resumed session recovers in one step (the field row 2B-05)')
{
  const retired = await call([...ROSTER(), makeTool('Crewmate')], 'Agent')
  check('`Agent` is refused as unknown — no alias, no refusal line of its own', retired.isError && retired.text.startsWith('No such tool available: Agent.') && !/did you mean/i.test(retired.text), retired.text + ' | the retired name must get no alias and no suggestion: check closestToolByName (src/tools/kit/tool.ts) and runToolUse (src/engine/tool-dispatch/toolExecution.ts)')
  check('…and the refusal lists the tools this session was given, the current tool among them', /call one of the tools you were given: [^(]*\bCrewmate\b/.test(retired.text), retired.text + ' | the tool list in the refusal comes from offeredToolNamesClause (src/tools/kit/tool.ts)')
  check('…and nothing ran', retired.started.length === 0, j(retired.started) + FOLD_HINT)
}

section('§6 the exact road is untouched')
{
  const exact = await call(ROSTER(), 'Read')
  check('`Read` executes as Read', !exact.isError && exact.text === 'Read ran' && exact.started.join(',') === 'Read', j(exact) + FOLD_HINT)
  const twins = (): FakeTool[] => [...ROSTER(), makeTool('Foo'), makeTool('foo')]
  const upper = await call(twins(), 'Foo')
  check('with `Foo` and `foo` both advertised, `Foo` runs Foo', !upper.isError && upper.text === 'Foo ran', j(upper) + FOLD_HINT)
  const lowerTwin = await call(twins(), 'foo')
  check('…and `foo` runs foo', !lowerTwin.isError && lowerTwin.text === 'foo ran', j(lowerTwin) + FOLD_HINT)
  const ambiguous = await call(twins(), 'FOO')
  check('…and `FOO`, a fold that fits two, is refused rather than guessed', ambiguous.isError && ambiguous.text.startsWith('No such tool available: FOO'), j(ambiguous) + FOLD_HINT)
}

section('§7 the lookup laws in src/tools/kit/tool.ts')
{
  const tools = ROSTER() as never
  check('findToolByName: exact first', findToolByName(tools, 'Read')?.name === 'Read', LOOKUP_HINT)
  check('findToolByName: the fold on a miss', findToolByName(tools, 'read')?.name === 'Read', LOOKUP_HINT)
  check('findToolByName: the fold reaches an MCP name', findToolByName(tools, 'MCP__FILESYS__READ_FILE')?.name === 'mcp__filesys__read_file', LOOKUP_HINT)
  check('findToolByName: a separator difference is not a fold', findToolByName(tools, 'web_fetch') === undefined, LOOKUP_HINT)
  const aliased = [makeTool('Workflow', { aliases: ['RunWorkflow'] })] as never
  check('findToolByName: an alias folds too', findToolByName(aliased, 'runworkflow')?.name === 'Workflow', LOOKUP_HINT)
  const twins = [makeTool('Foo'), makeTool('foo')] as never
  check('findToolByName: two advertised names that fold to one keep the exact road only', findToolByName(twins, 'Foo')?.name === 'Foo' && findToolByName(twins, 'foo')?.name === 'foo' && findToolByName(twins, 'FOO') === undefined, LOOKUP_HINT)
  check('closestToolByName is exported from src/tools/kit/tool.ts', typeof closestToolByName === 'function', 'export closestToolByName from src/tools/kit/tool.ts')
  check('the bound is one named constant, a small integer', Number.isInteger(suggestionBound) && (suggestionBound as number) >= 1 && (suggestionBound as number) <= 3, String(suggestionBound) + ' | export TOOL_NAME_SUGGESTION_MAX_DISTANCE from src/tools/kit/tool.ts as an integer from 1 to 3')
  if (typeof closestToolByName === 'function') {
    check('closest: `grep_tool` → Grep', closestToolByName(tools, 'grep_tool')?.name === 'Grep', LOOKUP_HINT)
    check('closest: `web_fetch` → WebFetch', closestToolByName(tools, 'web_fetch')?.name === 'WebFetch', LOOKUP_HINT)
    check('closest: `WebFetchTool` → WebFetch', closestToolByName(tools, 'WebFetchTool')?.name === 'WebFetch', LOOKUP_HINT)
    check('closest: `Globb` → Glob', closestToolByName(tools, 'Globb')?.name === 'Glob', LOOKUP_HINT)
    check('closest: `mcp__filesys__read_fil` → the MCP name', closestToolByName(tools, 'mcp__filesys__read_fil')?.name === 'mcp__filesys__read_file', LOOKUP_HINT)
    check('closest: `NoSuchTool` → nothing', closestToolByName(tools, 'NoSuchTool') === undefined, LOOKUP_HINT)
    check('closest: `Frobnicate` → nothing', closestToolByName(tools, 'Frobnicate') === undefined, LOOKUP_HINT)
    check('closest: an empty name → nothing', closestToolByName(tools, '') === undefined, LOOKUP_HINT)
    check('closest: a one-letter head is no evidence (`s_fetch` → nothing)', closestToolByName(tools, 's_fetch') === undefined, LOOKUP_HINT)
    check('closest: an empty roster → nothing', closestToolByName([] as never, 'Read') === undefined, LOOKUP_HINT)
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
  check(`the ${names.length} built-in names fold to ${folded.size} distinct keys`, collisions.length === 0, j(collisions) + ' | rename one tool of each colliding group, since findToolByName (src/tools/kit/tool.ts) folds names by case and would become ambiguous for it')
}

console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS — tool-name recovery' : `  ${failures} FAILURE(S) — tool-name recovery`)
process.exit(failures === 0 ? 0 : 1)
