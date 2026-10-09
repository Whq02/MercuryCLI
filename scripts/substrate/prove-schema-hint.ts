#!/usr/bin/env bun
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

delete process.env.NODE_ENV
for (const k of ['ANTHROPIC_BASE_URL', 'MERCURY_TOOL_SEARCH', 'MERCURY_TOOL_DEFER', 'MERCURY_TOOL_DEFER_PROBE', 'MERCURY_MODEL', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_CHATGPT_BASE']) {
  delete process.env[k]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'schema-hint-'))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const ROOT = join(import.meta.dir, '..', '..')
const { buildSchemaNotSentHint } = await import('../../src/services/tools/toolExecution.ts')
const { isDeferredTool, TOOL_SEARCH_TOOL_NAME } = await import('../../src/tools/ToolSearchTool/prompt.ts')
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.ts')
type Tool = Parameters<typeof buildSchemaNotSentHint>[0]
type Message = Parameters<typeof buildSchemaNotSentHint>[1][number]

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const BLOCK_WIRE = 'claude-sonnet-5'
const SERVER_SEARCH_WIRE = 'gpt-5.6-sol'
const TEXT_WIRE = 'glm-5.3'
const withSearch = [{ name: TOOL_SEARCH_TOOL_NAME }, { name: 'WebFetch' }, { name: 'Bash' }]
const withoutSearch = [{ name: 'WebFetch' }, { name: 'Bash' }]
const deferredTool = { name: 'WebFetch', isMcp: true } as unknown as Tool
const plainTool = { name: 'Bash', shouldDefer: false } as unknown as Tool
const begin = createUserMessage({ content: 'begin' }) as Message
const fresh: Message[] = [begin]

function loaded(id: string, names: string[]): Message[] {
  return [
    createAssistantMessage({
      content: [{ type: 'tool_use', id, name: TOOL_SEARCH_TOOL_NAME, input: { query: `select:${names.join(',')}` } }] as never,
    }) as Message,
    createUserMessage({
      content: [{ type: 'tool_result', tool_use_id: id, content: names.map(tool_name => ({ type: 'tool_reference', tool_name })) }] as never,
    }) as Message,
  ]
}

console.log('============================================================')
console.log(' the schema-not-sent hint — the deferred-tool recovery words')
console.log('============================================================')

section('§1 a deferred tool nobody loaded, on a wire that defers client-side: the hint speaks')
{
  const hint = buildSchemaNotSentHint(deferredTool, fresh, withSearch, BLOCK_WIRE)
  check('the hint is returned', hint !== null)
  check('it opens on a blank line, so it reads as a paragraph after the schema error', hint?.startsWith('\n\n') === true, JSON.stringify(hint?.slice(0, 4)))
  check('it says the schema was not in the request', hint?.includes('schema was not in this turn\'s request') === true, hint ?? '')
  check('it says why the typed parameters came through as strings', hint?.includes('went out as a string') === true, hint ?? '')
  check('it names the tool-search tool by its real name', hint?.includes(TOOL_SEARCH_TOOL_NAME) === true)
  check('it spells the one query that loads the schema', hint?.includes(`with query "select:WebFetch"`) === true, hint ?? '')
  check('it says to make the call again', hint?.includes('make this call again') === true)
  check('the same words come back on a text wire', buildSchemaNotSentHint(deferredTool, fresh, withSearch, TEXT_WIRE) === hint)
}

section('§2 tool search in standard mode: silence')
{
  process.env.MERCURY_TOOL_SEARCH = '0'
  check('null when tool search is switched to standard', buildSchemaNotSentHint(deferredTool, fresh, withSearch, BLOCK_WIRE) === null)
  delete process.env.MERCURY_TOOL_SEARCH
  check('control: the hint speaks again once the mode is back', buildSchemaNotSentHint(deferredTool, fresh, withSearch, BLOCK_WIRE) !== null)
}

section('§3 no tool-search tool in the list: silence (never point at a tool that cannot be called)')
{
  check('null without a tool-search tool', buildSchemaNotSentHint(deferredTool, fresh, withoutSearch, BLOCK_WIRE) === null)
}

section('§4 a tool whose schema always ships: silence')
{
  check('control: the plain tool is not deferred', isDeferredTool(plainTool) === false)
  check('null for a tool that is not deferred', buildSchemaNotSentHint(plainTool, fresh, withSearch, BLOCK_WIRE) === null)
}

section('§5 the schema already loaded by a tool-search round: silence')
{
  const history = [...fresh, ...loaded('toolu_1', ['WebFetch'])]
  check('null once the history carries the tool reference', buildSchemaNotSentHint(deferredTool, history, withSearch, BLOCK_WIRE) === null)
  check('another tool\'s load does not count', buildSchemaNotSentHint(deferredTool, [...fresh, ...loaded('toolu_2', ['Browser'])], withSearch, BLOCK_WIRE) !== null)
}

section('§6 a wire whose tool search runs on the server: silence (the tool is not on that wire)')
{
  check('null on the server-search wire', buildSchemaNotSentHint(deferredTool, fresh, withSearch, SERVER_SEARCH_WIRE) === null)
}

section('§7 the model read when no model is passed is the engine model')
{
  process.env.MERCURY_MODEL = SERVER_SEARCH_WIRE
  check('MERCURY_MODEL on the server-search wire silences the three-argument call', buildSchemaNotSentHint(deferredTool, fresh, withSearch) === null)
  process.env.MERCURY_MODEL = BLOCK_WIRE
  check('MERCURY_MODEL on the block wire lets the three-argument call speak', buildSchemaNotSentHint(deferredTool, fresh, withSearch) !== null)
  delete process.env.MERCURY_MODEL
}

section('§8 one owner of the load road: the executor spells the select query once, and the build carries the words')
{
  const executor = readFileSync(join(ROOT, 'src/services/tools/toolExecution.ts'), 'utf8')
  check('the executor spells `with query "select:` exactly once', (executor.match(/with query "select:\$\{/g) ?? []).length === 1)
  const dist = join(ROOT, 'dist', 'mercury.mjs')
  if (!existsSync(dist)) {
    console.log('  [SKIP] dist/mercury.mjs not built — run `bun run build.ts` to include this check')
  } else {
    const built = readFileSync(dist, 'utf8')
    check('the build carries the strings explanation', built.includes('went out as a string'))
    check('the build carries the select query template', built.includes('with query "select:${'))
  }
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL SCHEMA-HINT PROOFS PASS')
else console.log(`❌ ${failures} SCHEMA-HINT PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
