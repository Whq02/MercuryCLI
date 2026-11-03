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

const HEAD = 'Loads the full definitions of deferred tools so they become callable.\n\n'
const LOCATION = 'Deferred tools are listed in <system-reminder> messages that begin "Deferred tools:", one per line: the name, and what the tool is for when it declares one; keyword search also reads each tool\'s full description.'
const SPEC_BLOCK = `${HEAD}${LOCATION} The result carries the complete definition of each match inside a <functions> block, callable from then on, no different from the tools the prompt opened with.`
const SPEC_TEXT = `${HEAD}${LOCATION} The result names the admitted tools, and from that request on their complete definitions are in your tool list, no different from the tools the prompt opened with.`
const SPEC_TEXT_APPEND = `${HEAD}${LOCATION} The result names the admitted tools, and their complete definitions are appended to the conversation right after it, callable from then on, no different from the tools the prompt opened with.`

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
  check('it carries no worked query examples: the grammar is the query field\'s', !text.includes('select:') && !text.includes('Query forms'))
  check('it says where the list is and what a line holds', text.includes('messages that begin "Deferred tools:", one per line: the name, and what the tool is for when it declares one'))
  check('it says a loaded definition is callable like the tools the prompt opened with', text.includes('no different from the tools the prompt opened with'))
  check('it pre-empts no miss and explains no mechanism: the result names a miss at call time', !text.includes('loads nothing') && !text.includes('Shape of the result') && !text.includes('all you hold'))
  check('the input schema is unchanged', JSON.stringify(ToolSearchTool.inputSchema.shape ? Object.keys(ToolSearchTool.inputSchema.shape).sort() : []) === JSON.stringify(['max_results', 'query']))
  check('getPrompt() defaults to the block text', getPrompt() === SPEC_BLOCK && getPrompt('block') === SPEC_BLOCK)
  console.log(`  block text: ${Buffer.byteLength(text, 'utf8')} bytes`)
}

section('§2 the text form')
{
  const TEXT = 'glm-5.3'
  check(`${TEXT} rides the text form`, deferralWireFormFor(TEXT).form === 'text')
  const text = await ToolSearchTool.prompt({ model: TEXT })
  check('the description equals the specification\'s text-form text exactly', text === SPEC_TEXT, firstDifference(text, SPEC_TEXT))
  check('it promises the admission notice and the tool list, never the <functions> expansion', text.includes('names the admitted tools') && text.includes('in your tool list') && !text.includes('<functions>'))
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

section('§4 every form shares the head and the location; the grammar lives in the query field')
{
  for (const form of ['block', 'text', 'text-append'] as const) {
    const text = getPrompt(form)
    check(`${form}: starts with the head and names the "Deferred tools:" list`, text.startsWith(`${HEAD}Deferred tools are listed in <system-reminder> messages that begin "Deferred tools:"`))
    check(`${form}: one paragraph after the head, under 500 bytes`, text.split('\n\n').length === 2 && Buffer.byteLength(text) <= 500, `${Buffer.byteLength(text)} bytes`)
    check(`${form}: never names <available-deferred-tools>`, !text.includes('<available-deferred-tools>'))
    check(`${form}: the query forms do not say again what the query and max_results fields say (the exact names, the best matches, the result bound)`, !text.includes('pull exactly the tools named') && !text.includes('best matches') && !text.includes('max_results'))
    const spec = form === 'block' ? SPEC_BLOCK : form === 'text' ? SPEC_TEXT : SPEC_TEXT_APPEND
    check(`${form}: the first three lines — all the Fallback permission card prints under an explicit ask rule — are the specification's`, text.split('\n').slice(0, 3).join('\n') === spec.split('\n').slice(0, 3).join('\n'), text.split('\n').slice(0, 3).join('\n').slice(0, 160))
  }
  const fields = (ToolSearchTool.inputSchema as unknown as { shape: Record<string, { description?: string }> }).shape
  check('the query field says the three forms and the roster', (fields.query?.description ?? '') === 'What to load: exact names as "select:<name>,<name>"; or keywords ranked against the deferred roster, where "+word" requires the word (in a tool\'s name, description or search words) and the other words only rank.', fields.query?.description)
  check('the max_results field says the result bound and its default', (fields.max_results?.description ?? '') === 'Maximum number of results to return (default: 5)', fields.max_results?.description)
}

section('§5 the unattended run (no host answers asks, the roster names only): the location sentence tells that truth, the rest of the text is the hosted text')
{
  const { isUnattendedRun, markSessionNonInteractive, resetRuntimePostureForTest } = await import('../../src/utils/cockpit/runtimePosture.ts')
  const HOSTED_LOCATION = 'one per line: the name, and what the tool is for when it declares one; keyword search also reads each tool\'s full description.'
  const UNATTENDED_LOCATION = 'one name per line, optionally followed by a hint; keyword search matches names and descriptions even when only names are listed.'
  check('this proof renders the hosted posture (no session mark, so a screen may print the card)', isUnattendedRun() === false)
  for (const form of ['block', 'text', 'text-append'] as const) {
    const hosted = getPrompt(form)
    const unattended = getPrompt(form, true)
    check(`${form}: the unattended text differs from the hosted text in the location sentence alone`, hosted.includes(HOSTED_LOCATION) && !hosted.includes(UNATTENDED_LOCATION) && unattended.includes(UNATTENDED_LOCATION) && unattended.replace(UNATTENDED_LOCATION, HOSTED_LOCATION) === hosted, firstDifference(unattended, hosted))
    check(`${form}: getPrompt(form, false) is the hosted text`, getPrompt(form, false) === hosted)
  }
  markSessionNonInteractive()
  bootstrap.setAskChannel('none')
  check('a session marked non-interactive with no ask channel renders the unattended text by default', isUnattendedRun() === true && getPrompt('block') === getPrompt('block', true) && (await ToolSearchTool.prompt({ model: 'claude-sonnet-5-5' })) === getPrompt('block', true))
  bootstrap.setAskChannel('sdk')
  check('a host that answers asks keeps the hosted text while the session is marked non-interactive', isUnattendedRun() === false && getPrompt('block') === SPEC_BLOCK)
  resetRuntimePostureForTest()
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
