#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'toolsearch-wire-'))
delete process.env.ANTHROPIC_BASE_URL
delete process.env.MERCURY_TOOL_SEARCH
delete process.env.MERCURY_TOOL_DEFER
delete process.env.MERCURY_OPENAI_API_BASE
delete process.env.MERCURY_OPENAI_CHATGPT_BASE
delete process.env.MERCURY_MODEL

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const hintWire = 'change deferralWireFormFor in src/models/roads/deferralWire.ts (the route comes from declaredRouteOf in src/models/roads/routeLaw.ts)'
const hintRender = 'change ToolSearchTool.mapToolResultToToolResultBlockParam in src/tools/tool-search/ToolSearchTool.ts, or renderAdmissionRecordsAsText in src/models/roads/toolEconomy.ts'
const hintGate = 'change isToolSearchEnabledOptimistic in src/engine/messages/toolSearch.ts (ToolSearchTool.isEnabled in src/tools/tool-search/ToolSearchTool.ts calls it)'
const hintPrompt = 'change getPrompt in src/tools/tool-search/prompt.ts (ToolSearchTool.prompt in src/tools/tool-search/ToolSearchTool.ts picks the form)'

const state = await import('../../src/boot/process-state/processState.ts')
const { ToolSearchTool } = await import('../../src/tools/tool-search/ToolSearchTool.ts')
const { getPrompt } = await import('../../src/tools/tool-search/prompt.ts')
const { isToolSearchEnabledOptimistic } = await import('../../src/engine/messages/toolSearch.ts')
const { declaredRouteOf } = await import('../../src/models/roads/routeLaw.ts')
const { deferralWireFormFor } = await import('../../src/models/roads/deferralWire.ts')
const { renderAdmissionRecordsAsText } = await import('../../src/models/roads/toolEconomy.ts')
const { getEngineModel } = await import('../../src/models/catalogue/engineModel.ts')
const { createUserMessage } = await import('../../src/engine/messages/messages.ts')

const output = {
  matches: ['WebFetch', 'Browser'],
  query: 'fetch a web page',
  total_deferred_tools: 2,
  match_lines: ['WebFetch — fetch and read a url', 'Browser — drive a real browser'],
}
type Block = { type: string; tool_name?: string; text?: string }
const render = (): unknown => ToolSearchTool.mapToolResultToToolResultBlockParam(output as never, 'toolu_1').content

section('§A the result on the Anthropic route — tool_reference blocks, unchanged')
{
  state.setEngineModelOverride('claude-opus-4-8' as never)
  check('the session model routes to anthropic', declaredRouteOf(getEngineModel()) === 'anthropic', `${getEngineModel()}; ${hintWire}`)
  check('…and the first-party wire form is the block form', deferralWireFormFor(getEngineModel()).form === 'block', hintWire)
  const content = render()
  check('the content is an array of tool_reference blocks', Array.isArray(content) && (content as Block[]).every(b => b.type === 'tool_reference'), hintRender)
  check('…naming exactly the matches, in order', Array.isArray(content) && (content as Block[]).map(b => b.tool_name).join(',') === 'WebFetch,Browser', hintRender)
}

section('§A the result off the Anthropic route — the SAME admission record, rendered as text on the wire')
{
  for (const model of ['deepseek-v4-pro', 'glm-5.3', 'gpt-5.3-codex']) {
    state.setEngineModelOverride(model as never)
    const route = declaredRouteOf(getEngineModel())
    check(`${model} routes off anthropic (${route})`, route !== 'anthropic', hintWire)
    check(`${model}: the wire form is text`, deferralWireFormFor(getEngineModel()).form === 'text', hintWire)
    const content = render()
    check(`${model}: the stored result is the admission record (tool_reference blocks)`, Array.isArray(content) && (content as Block[]).every(b => b.type === 'tool_reference'), hintRender)
    const stored = createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content }] as never })
    const [rendered] = renderAdmissionRecordsAsText([stored])
    const blocks = (rendered as { message: { content: Array<{ type: string; content?: Block[] }> } }).message.content
    const inner = blocks[0]?.content ?? []
    check(`${model}: on the wire the record renders as text`, inner.length === 1 && inner[0]?.type === 'text', hintRender)
    const text = String(inner[0]?.text ?? '')
    check(`${model}: it names each admitted tool`, text.includes('- WebFetch') && text.includes('- Browser'), hintRender)
    check(`${model}: it says the schemas are in the tool list from this request on`, /tool list from this request on/i.test(text), hintRender)
    check(`${model}: no placeholder block leaks`, !text.includes('tool_reference'), hintRender)
  }
  const none = ToolSearchTool.mapToolResultToToolResultBlockParam({ matches: [], query: 'q', total_deferred_tools: 0 } as never, 'toolu_2').content
  check('no matches ⇒ the no-match sentence names the query, says nothing was loaded and points at the "Deferred tools:" list', String(none) === 'No deferred tool matches "q"; nothing was loaded. Every tool you can load is in the "Deferred tools:" list with what it is for — pick one there and load it with "select:<name>".', `${String(none)}; ${hintRender}`)
  state.setEngineModelOverride('gpt-5.5' as never)
  check("gpt-5.5 (5.4 or later, first-party OpenAI) rides the provider's own form — openai-native — where ToolSearch is not offered on the wire", deferralWireFormFor(getEngineModel()).form === 'openai-native', hintWire)
  state.setEngineModelOverride('openrouter/stealth/ox-alpha' as never)
  check("openrouter/stealth/ox-alpha rides the provider's own form — openrouter-native — where ToolSearch is not offered on the wire", deferralWireFormFor(getEngineModel()).form === 'openrouter-native', hintWire)
}

section('§B the roster gate is route-independent')
{
  state.setEngineModelOverride('claude-opus-4-8' as never)
  check('a first-party Anthropic session keeps ToolSearch exactly as today (mounted)', isToolSearchEnabledOptimistic() === true, hintGate)
  check("…and the tool's own isEnabled agrees", ToolSearchTool.isEnabled() === true, hintGate)
  for (const model of ['openrouter/stealth/ox-alpha', 'glm-5.3', 'gpt-5.3-codex', 'gpt-5.5']) {
    state.setEngineModelOverride(model as never)
    check(`${model}: ToolSearch mounts too (the pool is route-independent; the wire form decides what rides)`, isToolSearchEnabledOptimistic() === true && ToolSearchTool.isEnabled() === true, hintGate)
  }
  process.env.MERCURY_TOOL_DEFER = '0'
  check('MERCURY_TOOL_DEFER=0 unmounts it on every route (the off arm inlines the catalogue)', isToolSearchEnabledOptimistic() === false && ToolSearchTool.isEnabled() === false, hintGate)
  delete process.env.MERCURY_TOOL_DEFER
  state.setEngineModelOverride('claude-opus-4-8' as never)
  check('the flag read is live (mounted again once the kill lifts)', isToolSearchEnabledOptimistic() === true, hintGate)
  state.setEngineModelOverride(undefined)
}

section('§C the description tells the truth per wire form')
{
  const block = getPrompt('block')
  const text = getPrompt('text')
  check('block form: promises the <functions> expansion (the first-party bytes)', block.includes('inside a <functions> block') && !block.includes('Shape of the result'), hintPrompt)
  check('text form: promises the admission notice and the tool list, never the expansion', text.includes('names the admitted tools') && text.includes('in your tool list') && !text.includes('<functions>'), hintPrompt)
  check('both carry the same head and location; the query grammar lives in the field', [block, text].every(p => p.startsWith('Loads the full definitions of deferred tools') && p.includes('listed in <system-reminder> messages that begin "Deferred tools:"') && !p.includes('<available-deferred-tools>') && !p.includes('select:WebFetch,Sleep')), hintPrompt)
  check("the default form is the block form (the first-party route's text)", getPrompt() === block, hintPrompt)
  state.setEngineModelOverride('gpt-5.3-codex' as never)
  check('the tool renders the text-form description for a text-form model', (await ToolSearchTool.prompt({ model: 'gpt-5.3-codex' } as never)) === text, hintPrompt)
  state.setEngineModelOverride('gpt-5.5' as never)
  check('…and the text-form description for a native-form model (never the <functions> promise off the block wire)', (await ToolSearchTool.prompt({ model: 'gpt-5.5' } as never)) === text, hintPrompt)
  state.setEngineModelOverride('claude-opus-4-8' as never)
  check('…and the block-form description for a first-party model', (await ToolSearchTool.prompt({ model: 'claude-opus-4-8' } as never)) === block, hintPrompt)
  state.setEngineModelOverride(undefined)
}

console.log(`\n${failures === 0 ? '✅ ALL TOOLSEARCH WIRE-HONESTY PROOFS PASS' : `❌ ${failures} TOOLSEARCH WIRE-HONESTY PROOF(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
