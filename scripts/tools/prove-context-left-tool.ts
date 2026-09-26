#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '../..')
process.chdir(ROOT)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
for (const key of ['OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY', 'HF_TOKEN', 'MERCURY_MODEL', 'MERCURY_DISABLE_1M_CONTEXT', 'CLAUDE_EFFORT', 'MERCURY_HOME', 'MERCURY_AUTO_COMPACT', 'MERCURY_COMPACT', 'MERCURY_AUTOCOMPACT_PCT_OVERRIDE', 'MERCURY_BLOCKING_LIMIT_OVERRIDE', 'MERCURY_BARE']) {
  delete process.env[key]
}
const home = process.env.MERCURY_CONFIG_DIR && process.env.MERCURY_CONFIG_DIR.startsWith('/private/tmp/') ? process.env.MERCURY_CONFIG_DIR : mkdtempSync(join(tmpdir(), 'context-left-tool-'))
mkdirSync(home, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_OPENROUTER_API_BASE = 'http://127.0.0.1:1/api/v1'
process.env.MERCURY_DESKTOP_DRIVER = 'none'

const TOOL_NAME = 'ContextLeft'
const TOOL_FILE = 'src/tools/ContextLeftTool/ContextLeftTool.ts'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setCwdState(ROOT)
const { getTools, getAllBaseTools, assembleToolPool } = await import('../../src/tools.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { contextFillView } = await import('../../src/utils/contextFill.ts')
const { isDeferredTool } = await import('../../src/tools/ToolSearchTool/prompt.ts')
const { TOOL_FAMILY_BY_NAME } = await import('../../src/components/mercury-ui/toolGlyphs.ts')
const { ASYNC_AGENT_ALLOWED_TOOLS, ALL_AGENT_DISALLOWED_TOOLS } = await import('../../src/constants/tools.ts')
type Tool = import('../../src/Tool.ts').Tool
type Message = import('../../src/types/message.ts').Message

console.log('============================================================')
console.log(` ${TOOL_NAME} — the model can ask how many tokens remain`)
console.log('============================================================')

section('§1 the catalogue carries the tool by name')
const permissionContext = getEmptyToolPermissionContext()
const offered = getTools(permissionContext) as Tool[]
const tool = offered.find(candidate => candidate.name === TOOL_NAME)
check(`getTools() offers a tool named ${TOOL_NAME}`, tool !== undefined, `offered: ${offered.map(candidate => candidate.name).join(', ')}`)
check(`getAllBaseTools() lists ${TOOL_NAME} unconditionally`, getAllBaseTools().some(candidate => candidate.name === TOOL_NAME))
check(`assembleToolPool() shows ${TOOL_NAME} to the model`, assembleToolPool(permissionContext, []).some(candidate => candidate.name === TOOL_NAME))
check(`${TOOL_NAME} defers like every rare tool — announced name-only, its schema fetched through ToolSearch — so the first request's twelve daily tools stay the whole eager set`, tool !== undefined && isDeferredTool(tool))
const { searchToolsWithKeywords } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.ts')
const deferred = offered.filter(candidate => isDeferredTool(candidate))
const found = await searchToolsWithKeywords('how much context window is left', deferred, offered, 3)
check(`a ToolSearch for the context window finds ${TOOL_NAME} first among the deferred tools`, found[0] === TOOL_NAME, `found: ${found.join(', ')}`)

let mod: typeof import('../../src/tools/ContextLeftTool/ContextLeftTool.ts') | null = null
try {
  mod = await import('../../src/tools/ContextLeftTool/ContextLeftTool.ts')
} catch (error) {
  check('the tool module loads', false, String(error))
}

if (mod === null) {
  console.log(`\n${TOOL_NAME}: ${failures} CHECK(S) FAILED — the tool is absent from this tree`)
  process.exit(1)
}
const subject: Tool = tool ?? (mod.ContextLeftTool as unknown as Tool)

type Usage = { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number }
const usage = (input: number, output: number): Usage => ({ input_tokens: input, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 })
let n = 0
const asst = (id: string, u: Usage | undefined, text: string, stop: string | null = 'end_turn'): Message =>
  ({ type: 'assistant', uuid: `a-${++n}`, timestamp: new Date().toISOString(), message: { id, model: 'fixture-model', role: 'assistant', content: [{ type: 'text', text }], usage: u, stop_reason: stop } }) as never
const user = (text: string): Message =>
  ({ type: 'user', uuid: `u-${++n}`, timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text }] } }) as never
const toolResult = (text: string): Message =>
  ({ type: 'user', uuid: `t-${++n}`, timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: text }] } }) as never
const count = (value: number): string => value.toLocaleString('en-US')

async function answer(messages: Message[], model: string): Promise<import('../../src/tools/ContextLeftTool/ContextLeftTool.ts').ContextLeftOutput> {
  const context = {
    messages,
    options: { mainLoopModel: model, tools: [], commands: [], mcpClients: [], verbose: false, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [] } },
    abortController: new AbortController(),
    getAppState: () => ({}),
    setAppState: () => {},
    readFileState: new Map(),
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  } as never
  const result = await subject.call({}, context, (async () => ({ behavior: 'allow' })) as never, asst('parent', undefined, 'x') as never)
  return result.data
}

const STATED = 'claude-opus-5'
const FALLBACK = 'compat/some-model'

section('§2 a transcript with no response answers unknown, and still names the window with its source')
{
  const messages = [user('hi')]
  const view = contextFillView(messages, STATED)
  const out = await answer(messages, STATED)
  check('the view itself reads unknown for a fresh transcript (usedTokens null)', view.usedTokens === null && view.usedPct === null && view.fillSource === null, JSON.stringify(view))
  check('the answer carries the honest unknown line', out.text.startsWith(mod.CONTEXT_LEFT_UNKNOWN_LINE), out.text)
  check('the answer names the window figure from the view', out.text.includes(`Window: ${count(view.window)} tokens`), out.text)
  check('the answer names the window source in words', /Window: [\d,]+ tokens, [a-z]/.test(out.text) && out.text.includes(mod.windowWords(view)), out.text)
  check('no percent, no token count used, no fold line before the first response', !out.text.includes('%') && !out.text.includes('tokens used') && !out.text.includes('fold'), out.text)
  check('the structured output mirrors the view (nulls stay null)', out.usedTokens === null && out.usedPct === null && out.fillSource === null && out.leftUntilCompactPct === null && out.leftUntilCompactTokens === null && out.window === view.window && out.windowSource === view.windowSource, JSON.stringify(out))
  console.log('    sample:\n      ' + out.text.split('\n').join('\n      '))
  const second = [...messages, asst('resp-0', usage(12_000, 40), 'asking the tool', 'tool_use'), toolResult(out.text)]
  const secondView = contextFillView(second, STATED)
  const again = await answer(second, STATED)
  check('the promise holds: a second call, once the response that made the first call is in the transcript, is measured', secondView.fillSource === 'usage' && again.usedTokens === secondView.usedTokens && again.usedTokens !== null && again.text.includes('measured on the wire') && !again.text.includes('unknown'), again.text)
}

section('§3 wire usage: tokens, percent and the left-until-fold figure equal the view to the token')
{
  const messages = [user('hi'), asst('resp-1', usage(280_000, 10_000), 'answer')]
  const view = contextFillView(messages, STATED)
  const out = await answer(messages, STATED)
  check('the view carries wire usage for this fixture', view.usedTokens !== null && view.fillSource === 'usage' && view.usedPct !== null && view.compactAtPct !== null && view.leftUntilCompactPct !== null, JSON.stringify(view))
  check('usedTokens equals the view', out.usedTokens === view.usedTokens, `${out.usedTokens} vs ${view.usedTokens}`)
  check('usedPct equals the view', out.usedPct === view.usedPct, `${out.usedPct} vs ${view.usedPct}`)
  check('fillSource equals the view', out.fillSource === view.fillSource)
  check('window and windowSource equal the view', out.window === view.window && out.windowSource === view.windowSource)
  check('compactAtPct and leftUntilCompactPct equal the view', out.compactAtPct === view.compactAtPct && out.leftUntilCompactPct === view.leftUntilCompactPct)
  const foldPoint = Math.round((view.compactAtPct! / 100) * view.window)
  check('leftUntilCompactTokens is the fold point (compactAtPct of the window) minus the used count — the view’s own fields, no other source', out.leftUntilCompactTokens === Math.max(0, foldPoint - view.usedTokens!), `${out.leftUntilCompactTokens} vs ${foldPoint} - ${view.usedTokens}`)
  check('used + left = the fold point, to the token', out.usedTokens! + out.leftUntilCompactTokens! === foldPoint)
  check('the text names the used count and the window', out.text.includes(`Context: ${count(view.usedTokens!)} of ${count(view.window)} tokens used (${view.usedPct}%)`), out.text)
  check('the text says the count is measured on the wire', out.text.includes('measured on the wire') && !out.text.includes('estimated'), out.text)
  check('the text names the left-until-fold figure with the view’s percent', out.text.includes(`Left until the fold (autocompact): ${count(out.leftUntilCompactTokens!)} tokens (${view.leftUntilCompactPct}% of the window)`), out.text)
  check('the wire content is the same text', subject.mapToolResultToToolResultBlockParam(out, 'toolu_1').content === out.text)
  console.log('    sample:\n      ' + out.text.split('\n').join('\n      '))
}

section('§4 the tool reads the seated model off the context, never a global')
{
  const messages = [user('hi'), asst('resp-2', usage(50_000, 1_000), 'answer')]
  const a = await answer(messages, STATED)
  const b = await answer(messages, FALLBACK)
  check('two seated models give the two windows the view resolves for them', a.window === contextFillView(messages, STATED).window && b.window === contextFillView(messages, FALLBACK).window && a.window !== b.window, `${a.window} vs ${b.window}`)
}

section('§5 autocompact off: the fold line is absent and the answer says so')
{
  process.env.MERCURY_AUTO_COMPACT = '0'
  const messages = [user('hi'), asst('resp-3', usage(120_000, 2_000), 'answer')]
  const view = contextFillView(messages, STATED)
  const out = await answer(messages, STATED)
  delete process.env.MERCURY_AUTO_COMPACT
  check('the view reads no fold point with autocompact off', view.compactAtPct === null && view.leftUntilCompactPct === null, JSON.stringify(view))
  check('the answer has no left-until-fold figure', out.leftUntilCompactTokens === null && out.leftUntilCompactPct === null && !out.text.includes('Left until the fold'), out.text)
  check('and says autocompact is off', out.text.includes(mod.CONTEXT_LEFT_NO_FOLD_LINE), out.text)
  check('the used count is still reported', out.usedTokens === view.usedTokens && out.text.includes(`${count(view.usedTokens!)} of`), out.text)
  console.log('    sample:\n      ' + out.text.split('\n').join('\n      '))
}

section('§6 a fallback window is marked ~ and labelled in words')
{
  const messages = [user('hi'), asst('resp-4', usage(20_000, 500), 'answer')]
  const view = contextFillView(messages, FALLBACK)
  const out = await answer(messages, FALLBACK)
  check('the view resolves a fallback window for this model', view.windowSource === 'fallback', JSON.stringify(view))
  check('the answer marks the window ~ and says it is a conservative default', out.text.includes(`of ~${count(view.window)} tokens used`) && out.text.includes(`Window: ~${count(view.window)} tokens, a conservative default`), out.text)
  check('a stated window carries no ~', !(await answer(messages, STATED)).text.includes('~'))
  console.log('    sample:\n      ' + out.text.split('\n').join('\n      '))
}

section('§7 a response without wire usage is an estimate, labelled')
{
  const messages = [user('hi'), asst('resp-5', undefined, 'an answer the wire did not measure')]
  const view = contextFillView(messages, STATED)
  const out = await answer(messages, STATED)
  check('the view reads an estimate', view.fillSource === 'estimate' && view.usedTokens !== null, JSON.stringify(view))
  check('the answer equals the view and says estimated from characters', out.usedTokens === view.usedTokens && out.fillSource === 'estimate' && out.text.includes('estimated from characters') && !out.text.includes('measured'), out.text)
}

section('§8 posture: read-only, concurrency-safe, permission-free, no parameters')
{
  check('isReadOnly', subject.isReadOnly({}) === true)
  check('isConcurrencySafe', subject.isConcurrencySafe({}) === true)
  const verdict = await subject.checkPermissions({}, { getAppState: () => ({ toolPermissionContext: permissionContext }) } as never)
  check('checkPermissions allows outright (no ask)', verdict.behavior === 'allow')
  check('the schema is the empty strict object', subject.inputSchema.safeParse({}).success === true && subject.inputSchema.safeParse({ tokens: 1 }).success === false)
  check('an explicit empty classifier projection (never blocked by the fail-closed guard)', subject.toAutoClassifierInput({}) === '')
  check('the description and prompt tell the model when to call and when not to', (await subject.description()).includes('context window') && (await subject.prompt()).includes('Do not call it every turn') && (await subject.prompt()).includes('unknown'))
  const source = readFileSync(join(ROOT, TOOL_FILE), 'utf8')
  check('the tool reads messages and mainLoopModel off the tool-use context', /contextFillView\(context\.messages, context\.options\.mainLoopModel\)/.test(source))
  check('no second derivation: the tool imports the one view and none of the token, window or compact owners', source.includes("from '../../utils/contextFill.js'") && !/utils\/tokens\.js|utils\/context\.js|services\/compact\/|model\/capabilities\.js/.test(source))
}

section('§9 every roster that counts tools by name carries it')
{
  const censusPath = join(ROOT, 'scripts/builtin-tools/fixtures/tool-census.json')
  const census = existsSync(censusPath) ? (JSON.parse(readFileSync(censusPath, 'utf8')) as { rows: Array<{ name: string; declared: unknown; proof: string | null }> }) : null
  const row = census?.rows.find(entry => entry.name === TOOL_NAME)
  check('the committed census anchor rows the tool (regenerated in the same change)', row !== undefined, 'run bun scripts/builtin-tools/census-gen.ts')
  check('the census row carries the declared contract and this proof', row?.declared !== null && row?.proof === 'scripts/tools/prove-context-left-tool.ts', JSON.stringify(row))
  check('the glyph registry gives it a family', TOOL_FAMILY_BY_NAME[TOOL_NAME] !== undefined, JSON.stringify(TOOL_FAMILY_BY_NAME[TOOL_NAME]))
  check('a background sub-agent may ask about its own window', ASYNC_AGENT_ALLOWED_TOOLS.has(TOOL_NAME))
  check('no agent is barred from it', !ALL_AGENT_DISALLOWED_TOOLS.has(TOOL_NAME))
  check('its result is indexed for transcript search (extractSearchText)', typeof subject.extractSearchText === 'function' && subject.extractSearchText({ text: 'Context: x' } as never) === 'Context: x')
}

console.log('\n' + (failures === 0 ? `${TOOL_NAME}: ALL CHECKS PASSED` : `${TOOL_NAME}: ${failures} CHECK(S) FAILED`))
process.exit(failures === 0 ? 0 : 1)
