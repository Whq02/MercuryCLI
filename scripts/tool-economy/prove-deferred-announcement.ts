#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

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

delete process.env.NODE_ENV
for (const k of ['ANTHROPIC_BASE_URL', 'MERCURY_TOOL_SEARCH', 'MERCURY_TOOL_DEFER', 'MERCURY_TOOL_DEFER_PROBE', 'MERCURY_MODEL', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_CHATGPT_BASE']) {
  delete process.env[k]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'deferred-announcement-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_DAP_ADAPTERS = JSON.stringify({ fixture: { command: 'true', args: [], connect: 'stdio' } })
process.env.TYPESAFE_API_KEY = 'proof-key-deferred-announcement-not-a-real-key'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { enableConfigs, saveGlobalConfig } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
saveGlobalConfig(config => ({ ...config, jev: { ...(config.jev ?? {}), enabled: true } }))
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { assembleToolPool, getAllBaseTools } = await import('../../src/tools.ts')
const { ToolSearchTool } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.ts')
const { formatDeferredToolLine } = await import('../../src/tools/ToolSearchTool/prompt.ts')
const { getDeferredToolsDeltaAttachment, DEFERRED_TOOLS_ANNOUNCEMENT_HEAD, SERVER_SEARCH_ANNOUNCEMENT_HEAD } = await import('../../src/utils/attachments/deltas.ts')
const { normalizeAttachmentForAPI } = await import('../../src/utils/messages/attachmentText.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
type Tool = import('../../src/Tool.ts').Tool
type Message = import('../../src/types/message.ts').Message
type Attachment = import('../../src/utils/attachments/types.ts').Attachment

const HEAD = 'Deferred tools: offered in this session, but their definitions are not loaded. To call one, first load it with ToolSearch — query "select:<name>", or "select:<name>,<name>" for several — then call it.'
const SPEC_BODY = [
  'Deferred tools: offered in this session, but their definitions are not loaded. To call one, first load it with ToolSearch — query "select:<name>", or "select:<name>,<name>" for several — then call it.',
  'ApolloReview — present the completed Apollo pre-flight spec for review',
  'AskUserQuestion — ask the user structured multiple-choice questions',
  'AstEdit — structural code rewrite by syntax pattern across files, dry-run diff then apply',
  'Browser — drive a real browser: the native playwright puppeteer selenium alternative for end-to-end e2e…',
  'Checkpoint — checkpoint / mark context state before an exploration, rewindable',
  'Computer — computer use: see the screen, drive the mouse and keyboard, screenshot the desktop, click type…',
  'ContextLeft — how much context window is left: tokens used, window, tokens before autocompact',
  'Correct — correct project memory supersede amend retract',
  'Debug — real debugger via DAP: launch/attach, breakpoints (conditional/hit-count/logpoints), function…',
  'EnterWorktree — switch this session into an isolated git worktree',
  'ExitWorktree — end the worktree session and return to the original directory',
  'Git — typed local git work graph: status diff hunks conflicts commit plans, atomic stale-safe multi-commit…',
  'Inspect — inspect Mercury work-graph objects by mercury:// ref (runs, receipts, tasks, crews, workflows…',
  'JevEval — Jev second opinion: rank hypotheses, judge calls, check proposals',
  'Journey — run and verify a local application end to end: start services, request loopback http, assert status…',
  'Launch — unified launch profiles: list/inspect/debug/run/test/build from .vscode launch.json, python tests…',
  "LspCodeAction — list and apply the language server's quick fixes, refactors and source actions at a position",
  'LspFormat — format a file or a range of its lines, or organize its imports, through the language server',
  'LspMoveFile — move or rename a file or directory and update its imports through the language server',
  'LspMoveSymbol — move a top-level declaration into another file and rewrite its imports (TypeScript, JavaScript)',
  'LspRename — rename a symbol in every file through the language server: preview the edits, then apply them',
  'LspRequest — send one raw language-server protocol request and read the raw answer',
  'Monitor — watch, monitor, or keep an eye on a process/log/command — stream each stdout line as a live…',
  'NotebookEdit — edit Jupyter notebook .ipynb cells',
  "ProviderSearch — searches the web through the session provider's own native search",
  'Recall — search project memory with stable ids and provenance',
  'RecordConvention — record a user-stated durable project convention into MERCURY.md or its pointed guide',
  'Reflect — synthesize an answer over recalled memory with citations',
  'Retain — store durable facts into project memory',
  'Rewind — rewind context to the checkpoint, carry a report back',
  'SendMessage — send a note to a running crewmate of this session; it never starts a finished one',
  'Service — named project services: start/observe/wait/logs/stop long-lived processes (web servers, watch…',
  'Sleep — wait / pause / rest for a duration without a shell',
  'Structure — JS/TS AST query by node kind, previewed codemod: imports, calls, declarations, renames, import swaps',
  'TaskStop — kill or stop a running background task',
  'Test — structured test runs: discover, run, rerun failed, run the relevant tests for your changes…',
  'Transaction — see what changed and was checked; finish the work only after a passing check',
  'WebFetch — fetches and extracts content from a URL',
  'WebSearch — searches the web for current information',
  'Workflow — orchestrate subagents with deterministic JavaScript workflow',
  'Workshop — persistent JS/TS code cells with retained state, tool/agent composition (mercury.tool…',
  'mcp__mercury__lease_list',
  'mcp__mercury__lease_release',
  'mcp__mercury__lease_take',
  'mcp__mercury__render_tui',
].join('\n')

function fixtureTool(name: string, opts: { hint?: string; defer?: boolean; mcp?: string } = {}): Tool {
  return {
    name: opts.mcp ? `mcp__${opts.mcp}__${name}` : name,
    ...(opts.mcp ? { isMcp: true, mcpInfo: { serverName: opts.mcp, toolName: name } } : {}),
    ...(opts.defer ? { shouldDefer: true } : {}),
    ...(opts.hint !== undefined ? { searchHint: opts.hint } : {}),
    prompt: async () => `${name}: a fixture tool`,
    description: async () => `${name} fixture`,
    inputSchema: z.object({ path: z.string() }),
    ...(opts.mcp ? { inputJSONSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } : {}),
    isEnabled: () => true,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    userFacingName: () => name,
    call: async () => ({ data: 'fixture' }),
  } as unknown as Tool
}

const rendered = (row: Attachment): string => {
  const out = normalizeAttachmentForAPI(row)
  const content = out[0]?.message.content
  return out.length === 1 && typeof content === 'string' ? content : ''
}
const first = createUserMessage({ content: 'begin' }) as Message
const MODEL = 'claude-sonnet-5-5'

section('§1 the head and the line rule over a fixture pool')
{
  const longHint = 'a hint of exactly one hundred and twelve characters, long enough that the line rule has to cut it at a word boun'
  check('the fixture hint is 112 characters', longHint.length === 112, String(longHint.length))
  const pool: Tool[] = [
    fixtureTool('Read'),
    ToolSearchTool as never,
    fixtureTool('Zeta', { defer: true, hint: 'the last line by name' }),
    fixtureTool('Alpha', { defer: true, hint: '  spaced   out\n\thint  ' }),
    fixtureTool('Bare', { defer: true }),
    fixtureTool('Long', { defer: true, hint: longHint }),
    fixtureTool('Exact', { defer: true, hint: 'x'.repeat(100) }),
    fixtureTool('Punct', { defer: true, hint: `${'word '.repeat(18)}tail: — ,  ${'y'.repeat(30)}` }),
    fixtureTool('Unbroken', { defer: true, hint: 'z'.repeat(130) }),
    fixtureTool('lookup', { mcp: 'fixture' }),
  ]
  const row = getDeferredToolsDeltaAttachment(pool, MODEL, [first])[0] as { type: string; addedNames: string[]; addedLines: string[]; removedNames: string[]; body: string } | undefined
  check('the row is a deferred_tools_delta', row !== undefined && row.type === 'deferred_tools_delta')
  if (row !== undefined) {
    const expectedLines = [
      'Alpha — spaced out hint',
      'Bare',
      'Exact — ' + 'x'.repeat(100),
      'Long — a hint of exactly one hundred and twelve characters, long enough that the line rule has to cut it at…',
      'Punct — ' + 'word '.repeat(18) + 'tail…',
      'Unbroken — ' + 'z'.repeat(100) + '…',
      'Zeta — the last line by name',
      'mcp__fixture__lookup',
    ]
    check('addedNames are the bare names, sorted', row.addedNames.join(',') === ['Alpha', 'Bare', 'Exact', 'Long', 'Punct', 'Unbroken', 'Zeta', 'mcp__fixture__lookup'].join(','), row.addedNames.join(','))
    check('a hint under the limit renders as `Name — hint`, whitespace runs made one space', row.addedLines.includes('Alpha — spaced out hint') && row.addedLines.includes('Zeta — the last line by name'), row.addedLines.join(' | '))
    check('a tool without a hint is its name alone', row.addedLines.includes('Bare'))
    check('a hint of exactly 100 characters is not cut', row.addedLines.includes('Exact — ' + 'x'.repeat(100)))
    check('a 112-character hint is cut at its last space at or before 100 and ends with …', row.addedLines.includes(expectedLines[3]!), row.addedLines.find(line => line.startsWith('Long')) ?? 'no Long line')
    check('trailing spaces, commas, semicolons, colons and dashes are removed before the …', row.addedLines.includes(expectedLines[4]!), row.addedLines.find(line => line.startsWith('Punct')) ?? 'no Punct line')
    check('a hint with no space is cut at 100', row.addedLines.includes(expectedLines[5]!))
    check('the lines are sorted', row.addedLines.join('\n') === expectedLines.join('\n'), row.addedLines.join(' | '))
    check('the body is the head, a newline, then the lines joined by newlines', row.body === `${HEAD}\n${expectedLines.join('\n')}`)
    check('the head is the one the deltas module exports', DEFERRED_TOOLS_ANNOUNCEMENT_HEAD === HEAD)
    const text = rendered(row)
    check('rendered, the text is <system-reminder>\\nDeferred tools: …\\n</system-reminder>', text === `<system-reminder>\n${row.body}\n</system-reminder>` && text.startsWith('<system-reminder>\nDeferred tools: '))
    check('a second turn announces nothing more', getDeferredToolsDeltaAttachment(pool, MODEL, [first, { type: 'attachment', uuid: 'row', timestamp: new Date().toISOString(), attachment: row } as never]).length === 0)
  }
  check('formatDeferredToolLine agrees line by line', formatDeferredToolLine(fixtureTool('Long', { hint: longHint })) === 'Long — a hint of exactly one hundred and twelve characters, long enough that the line rule has to cut it at…' && formatDeferredToolLine(fixtureTool('Bare')) === 'Bare' && formatDeferredToolLine(fixtureTool('Empty', { hint: '   ' })) === 'Empty')
  check('the server-search head keeps its words', SERVER_SEARCH_ANNOUNCEMENT_HEAD.startsWith('The following tools are available in this session but their definitions are not loaded yet.'))
}

section('§2 over the bench roster the body is the specification\'s text byte for byte')
{
  const NAMES = ['Agent', 'Bash', 'Glob', 'Grep', 'Read', 'Edit', 'Write', 'Skill', 'Eval', 'AstSearch', 'ChangeSet', 'LspRead', 'LspRename', 'LspMoveSymbol', 'LspMoveFile', 'LspCodeAction', 'LspFormat', 'LspRequest', 'ToolSearch', 'JevEval', 'Debug', 'Git', 'AstEdit', 'Test', 'Workshop', 'Monitor', 'Checkpoint', 'Rewind', 'ApolloReview', 'AskUserQuestion', 'Browser', 'Computer', 'ContextLeft', 'Correct', 'EnterWorktree', 'ExitWorktree', 'Inspect', 'Journey', 'Launch', 'NotebookEdit', 'ProviderSearch', 'Recall', 'RecordConvention', 'Reflect', 'Retain', 'SendMessage', 'Service', 'Sleep', 'Structure', 'TaskStop', 'Transaction', 'WebFetch', 'WebSearch', 'Workflow']
  const permissionContext = getEmptyToolPermissionContext()
  const pool: Tool[] = [...assembleToolPool(permissionContext, [])]
  const catalogue = getAllBaseTools()
  for (const name of NAMES) {
    if (pool.some(tool => tool.name === name)) continue
    const tool = catalogue.find(item => item.name === name)
    if (tool !== undefined) pool.push(tool)
  }
  const roster: Tool[] = NAMES.flatMap(name => pool.filter(tool => tool.name === name))
  check('the 54 built-ins of the split bench roster are present', roster.length === NAMES.length, NAMES.filter(name => !roster.some(tool => tool.name === name)).join(', '))
  for (const name of ['lease_list', 'lease_release', 'lease_take', 'render_tui']) roster.push(fixtureTool(name, { mcp: 'mercury' }))
  const row = getDeferredToolsDeltaAttachment(roster, MODEL, [first])[0] as { addedNames: string[]; body: string } | undefined
  check('45 tools are announced', row !== undefined && row.addedNames.length === 45, String(row?.addedNames.length))
  check('the body equals the split announcement byte for byte (3,869 bytes; 3,906 wrapped)', row !== undefined && row.body === SPEC_BODY && Buffer.byteLength(row.body, 'utf8') === 3869 && Buffer.byteLength(rendered(row as never), 'utf8') === 3906, row === undefined ? 'no row' : `${Buffer.byteLength(row.body, 'utf8')} bytes; first differing line: ${row.body.split('\n').find((line, i) => line !== SPEC_BODY.split('\n')[i]) ?? 'none'}`)
  if (row !== undefined) {
    for (const name of ['JevEval', 'Debug', 'Git', 'AstEdit', 'Test', 'Workshop', 'Monitor', 'Checkpoint', 'Rewind']) {
      check(`${name} has its line`, row.body.split('\n').some(line => line.startsWith(`${name} — `)))
    }
    check('the four MCP tools are their names alone', ['mcp__mercury__lease_list', 'mcp__mercury__lease_release', 'mcp__mercury__lease_take', 'mcp__mercury__render_tui'].every(name => row.body.split('\n').includes(name)))
    check('no loaded tool has a line', ['Agent', 'Bash', 'Glob', 'Grep', 'Read', 'Edit', 'Write', 'Skill', 'Eval', 'AstSearch', 'ChangeSet', 'LspRead', 'ToolSearch'].every(name => !row.addedNames.includes(name)))
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
