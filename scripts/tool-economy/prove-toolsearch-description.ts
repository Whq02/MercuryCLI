#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
for (const k of ['ANTHROPIC_BASE_URL', 'MERCURY_TOOL_SEARCH', 'MERCURY_TOOL_DEFER', 'MERCURY_MODEL', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_CHATGPT_BASE']) {
  delete process.env[k]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'toolsearch-description-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { ToolSearchTool } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.ts')
const { getPrompt } = await import('../../src/tools/ToolSearchTool/prompt.ts')
const { deferralWireFormFor } = await import('../../src/services/providers/deferralWire.ts')
const { kimiSupportsDynamicToolLoading } = await import('../../src/services/providers/moonshot/kimiPins.ts')

const SPEC_BLOCK = `Load the full schemas of deferred tools so they become callable.

Deferred tools are listed in <system-reminder> messages that begin "Deferred tools:", one per line: the name, then what the tool is for. Before that fetch, the name and its line are all you hold — without a parameter schema the tool stays uncallable. Hand it a query; it matches against the deferred roster and answers with the complete JSONSchema definition of each match, inside a <functions> block. A schema landing in that result makes its tool callable, no different from the tools the prompt opened with. A tool already in your tool list needs no fetch: call it directly.

Shape of the result: every match lands as its own \`<function>{"description": "...", "name": "...", "parameters": {...}}</function>\` line inside the <functions> block, encoded the way the opening tool list is. A select that names a tool this session does not have loads nothing; the result names the miss.

Query forms:
- \`select:WebFetch,Sleep\` — pull exactly the tools named, spelled as the list spells them
- \`notebook jupyter\` — keyword search returning the best matches, max_results at most
- \`+slack send\` — "slack" must appear in the name; remaining terms only rank`
const SPEC_TEXT = `Load the full schemas of deferred tools so they become callable.

Deferred tools are listed in <system-reminder> messages that begin "Deferred tools:", one per line: the name, then what the tool is for. Before that fetch, the name and its line are all you hold — without a parameter schema the tool stays uncallable. Hand it a query; it matches against the deferred roster and admits each match: the result names the admitted tools, and from that request on their complete definitions are in your tool list, no different from the tools the prompt opened with. A tool already in your tool list needs no fetch: call it directly. A select that names a tool this session does not have loads nothing; the result names the miss.

Query forms:
- \`select:WebFetch,Sleep\` — pull exactly the tools named, spelled as the list spells them
- \`notebook jupyter\` — keyword search returning the best matches, max_results at most
- \`+slack send\` — "slack" must appear in the name; remaining terms only rank`
const SPEC_TEXT_APPEND = `Load the full schemas of deferred tools so they become callable.

Deferred tools are listed in <system-reminder> messages that begin "Deferred tools:", one per line: the name, then what the tool is for. Before that fetch, the name and its line are all you hold — without a parameter schema the tool stays uncallable. Hand it a query; it matches against the deferred roster and admits each match: the result names the admitted tools, and their complete definitions are appended to the conversation right after it, callable from then on, no different from the tools the prompt opened with. A tool already in your tool list needs no fetch: call it directly. A select that names a tool this session does not have loads nothing; the result names the miss.

Query forms:
- \`select:WebFetch,Sleep\` — pull exactly the tools named, spelled as the list spells them
- \`notebook jupyter\` — keyword search returning the best matches, max_results at most
- \`+slack send\` — "slack" must appear in the name; remaining terms only rank`

const firstDifference = (a: string, b: string): string => {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return `at ${i}: got …${JSON.stringify(a.slice(Math.max(0, i - 20), i + 40))} want …${JSON.stringify(b.slice(Math.max(0, i - 20), i + 40))}`
}

section('§1 the block form, first party')
{
  const BLOCK = 'claude-sonnet-5-5'
  check(`${BLOCK} rides the block form`, deferralWireFormFor(BLOCK).form === 'block')
  const text = await ToolSearchTool.prompt({ model: BLOCK })
  check('the description equals the specification\'s block text exactly', text === SPEC_BLOCK, firstDifference(text, SPEC_BLOCK))
  check('it never calls the list name-only', !text.includes('name-only'))
  check('its select example no longer names three always-loaded tools', !text.includes('select:Read,Edit,Grep') && text.includes('select:WebFetch,Sleep'))
  check('it says where the list is and what a line holds', text.includes('messages that begin "Deferred tools:", one per line: the name, then what the tool is for'))
  check('it says a loaded tool needs no fetch', text.includes('A tool already in your tool list needs no fetch: call it directly.'))
  check('it says a select with a miss loads nothing', text.includes('A select that names a tool this session does not have loads nothing; the result names the miss.'))
  check('the input schema is unchanged', JSON.stringify(ToolSearchTool.inputSchema.shape ? Object.keys(ToolSearchTool.inputSchema.shape).sort() : []) === JSON.stringify(['max_results', 'query']))
  check('getPrompt() defaults to the block text', getPrompt() === SPEC_BLOCK && getPrompt('block') === SPEC_BLOCK)
  console.log(`  block text: ${Buffer.byteLength(text, 'utf8')} bytes`)
}

section('§2 the text form')
{
  const TEXT = 'local/qwen3-32b'
  check(`${TEXT} rides the text form`, deferralWireFormFor(TEXT).form === 'text')
  const text = await ToolSearchTool.prompt({ model: TEXT })
  check('the description equals the specification\'s text-form text exactly', text === SPEC_TEXT, firstDifference(text, SPEC_TEXT))
  check('it promises the admission notice and the tool list, never the <functions> expansion', text.includes('admits each match') && text.includes('in your tool list') && !text.includes('<functions>'))
  check('getPrompt(\'text\') is the same text', getPrompt('text') === SPEC_TEXT)
  console.log(`  text-form text: ${Buffer.byteLength(text, 'utf8')} bytes`)
}

section('§3 the text-append form')
{
  const KIMI = 'kimi-k3'
  check(`${KIMI} is a Kimi id the dynamic-tool-loading pin admits`, kimiSupportsDynamicToolLoading(KIMI))
  check(`${KIMI} rides the text-append form`, deferralWireFormFor(KIMI).form === 'text-append', deferralWireFormFor(KIMI).form)
  const text = await ToolSearchTool.prompt({ model: KIMI })
  check('the description equals the specification\'s text-append text exactly', text === SPEC_TEXT_APPEND, firstDifference(text, SPEC_TEXT_APPEND))
  check('it differs from the text form by the one clause', text.includes('appended to the conversation right after it, callable from then on') && !text.includes('from that request on'))
  check('getPrompt(\'text-append\') is the same text', getPrompt('text-append') === SPEC_TEXT_APPEND)
}

section('§4 every form shares the head, the location, the direct-call sentence, the miss sentence and the query forms')
{
  for (const form of ['block', 'text', 'text-append'] as const) {
    const text = getPrompt(form)
    check(`${form}: starts with the head and names the "Deferred tools:" list`, text.startsWith('Load the full schemas of deferred tools so they become callable.\n\nDeferred tools are listed in <system-reminder> messages that begin "Deferred tools:"'))
    check(`${form}: carries the three query forms`, text.endsWith('Query forms:\n- `select:WebFetch,Sleep` — pull exactly the tools named, spelled as the list spells them\n- `notebook jupyter` — keyword search returning the best matches, max_results at most\n- `+slack send` — "slack" must appear in the name; remaining terms only rank'))
    check(`${form}: never names <available-deferred-tools>`, !text.includes('<available-deferred-tools>'))
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
