#!/usr/bin/env bun
// ============================================================================
//  scripts/builtin-tools/prove-toolsearch-wire-honesty.ts — ToolSearch reads
//  on every wire, and mounts on every route.
//
//  Deferral is Mercury's own context-assembly decision (the toolEconomy
//  owner), applied on EVERY provider route; the WIRE FORM a route carries it
//  in is the deferralWire owner's per-route capability: the beta block form
//  where the endpoint accepts it (first-party by contract), the client-side
//  text form everywhere else. Three laws:
//
//    §A the RESULT is the neutral ADMISSION RECORD on every route —
//       tool_reference blocks naming the matches, in order. The block-form
//       wire hands them to the server; a text-form wire renders them as
//       readable text (toolEconomy.renderAdmissionRecordsAsText) naming the
//       admitted tools, and NO placeholder block leaks. No-match text is
//       identical on both.
//    §B the ROSTER gate is route-independent: ToolSearch mounts on a
//       first-party Anthropic session exactly as before, AND on every other
//       family — a session on a text-form route defers too, so the search
//       tool is the only door to a deferred schema there.
//    §C the DESCRIPTION tells the truth per wire form: the block-form text
//       promises the server's <functions> expansion (byte-for-byte the text
//       the first-party route always carried); the text-form text promises
//       the admission notice and the tool list.
//
//  Run: ~/.bun/bin/bun run scripts/builtin-tools/prove-toolsearch-wire-honesty.ts
// ============================================================================
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'toolsearch-wire-'))
// First-party Anthropic base, the default deferral ladder (the shape an
// operator with no proxy has).
delete process.env.ANTHROPIC_BASE_URL
delete process.env.MERCURY_TOOL_SEARCH
delete process.env.MERCURY_TOOL_DEFER
// The main-loop model is driven through the session OVERRIDE (the first rung
// getMainLoopModel reads); the operator's env pick must not steer the proof.
delete process.env.ANTHROPIC_MODEL

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const state = await import('../../src/bootstrap/state.ts')
const { ToolSearchTool } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.ts')
const { getPrompt } = await import('../../src/tools/ToolSearchTool/prompt.ts')
const { isToolSearchEnabledOptimistic } = await import('../../src/utils/toolSearch.ts')
const { declaredRouteOf } = await import('../../src/services/providers/routeLaw.ts')
const { deferralWireFormFor } = await import('../../src/services/providers/deferralWire.ts')
const { renderAdmissionRecordsAsText } = await import('../../src/services/providers/toolEconomy.ts')
const { getMainLoopModel } = await import('../../src/utils/model/model.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')

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
  state.setMainLoopModelOverride('claude-opus-4-8' as never)
  check('the session model routes to anthropic', declaredRouteOf(getMainLoopModel()) === 'anthropic', getMainLoopModel())
  check('…and the first-party wire form is the block form', deferralWireFormFor(getMainLoopModel()).form === 'block')
  const content = render()
  check('the content is an array of tool_reference blocks', Array.isArray(content) && (content as Block[]).every(b => b.type === 'tool_reference'))
  check('…naming exactly the matches, in order', Array.isArray(content) && (content as Block[]).map(b => b.tool_name).join(',') === 'WebFetch,Browser')
}

section('§A the result off the Anthropic route — the SAME admission record, rendered as text on the wire')
{
  for (const model of ['openrouter/stealth/ox-alpha', 'glm-5.3', 'gpt-5.5']) {
    state.setMainLoopModelOverride(model as never)
    const route = declaredRouteOf(getMainLoopModel())
    check(`${model} routes off anthropic (${route})`, route !== 'anthropic')
    check(`${model}: the wire form is text`, deferralWireFormFor(getMainLoopModel()).form === 'text')
    const content = render()
    check(`${model}: the stored result is the admission record (tool_reference blocks)`, Array.isArray(content) && (content as Block[]).every(b => b.type === 'tool_reference'))
    const stored = createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content }] as never })
    const [rendered] = renderAdmissionRecordsAsText([stored])
    const blocks = (rendered as { message: { content: Array<{ type: string; content?: Block[] }> } }).message.content
    const inner = blocks[0]?.content ?? []
    check(`${model}: on the wire the record renders as text`, inner.length === 1 && inner[0]?.type === 'text')
    const text = String(inner[0]?.text ?? '')
    check(`${model}: it names each admitted tool`, text.includes('- WebFetch') && text.includes('- Browser'))
    check(`${model}: it says the schemas are in the tool list from this request on`, /tool list from this request on/i.test(text))
    check(`${model}: no placeholder block leaks`, !text.includes('tool_reference'))
  }
  const none = ToolSearchTool.mapToolResultToToolResultBlockParam({ matches: [], query: 'q', total_deferred_tools: 0 } as never, 'toolu_2').content
  check('no matches ⇒ the same plain sentence as before', String(none).startsWith('No matching deferred tools were found.'))
}

section('§B the roster gate is route-independent')
{
  state.setMainLoopModelOverride('claude-opus-4-8' as never)
  check('a first-party Anthropic session keeps ToolSearch exactly as today (mounted)', isToolSearchEnabledOptimistic() === true)
  check("…and the tool's own isEnabled agrees", ToolSearchTool.isEnabled() === true)
  for (const model of ['openrouter/stealth/ox-alpha', 'glm-5.3', 'gpt-5.5']) {
    state.setMainLoopModelOverride(model as never)
    check(`${model}: ToolSearch mounts too (deferral rides the text form there)`, isToolSearchEnabledOptimistic() === true && ToolSearchTool.isEnabled() === true)
  }
  process.env.MERCURY_TOOL_DEFER = '0'
  check('MERCURY_TOOL_DEFER=0 unmounts it on every route (the off arm inlines the catalogue)', isToolSearchEnabledOptimistic() === false && ToolSearchTool.isEnabled() === false)
  delete process.env.MERCURY_TOOL_DEFER
  state.setMainLoopModelOverride('claude-opus-4-8' as never)
  check('the flag read is live (mounted again once the kill lifts)', isToolSearchEnabledOptimistic() === true)
  state.setMainLoopModelOverride(undefined)
}

section('§C the description tells the truth per wire form')
{
  const block = getPrompt('block')
  const text = getPrompt('text')
  check('block form: promises the <functions> expansion (the first-party bytes)', block.includes('inside a <functions> block') && block.includes('Shape of the result'))
  check('text form: promises the admission notice and the tool list, never the expansion', text.includes('admits each match') && text.includes('in your tool list') && !text.includes('<functions>'))
  check('both carry the same head, location and query forms', [block, text].every(p => p.startsWith('Load the full schemas of deferred tools') && p.includes('inside <system-reminder> messages') && !p.includes('<available-deferred-tools>') && p.includes('select:Read,Edit,Grep') && p.includes('+slack send')))
  check('the default form is the block form (the unchanged first-party text)', getPrompt() === block)
  state.setMainLoopModelOverride('gpt-5.5' as never)
  check('the tool renders the text-form description for a text-form model', (await ToolSearchTool.prompt({ model: 'gpt-5.5' } as never)) === text)
  state.setMainLoopModelOverride('claude-opus-4-8' as never)
  check('…and the block-form description for a first-party model', (await ToolSearchTool.prompt({ model: 'claude-opus-4-8' } as never)) === block)
  state.setMainLoopModelOverride(undefined)
}

console.log(`\n${failures === 0 ? '✅ ALL TOOLSEARCH WIRE-HONESTY PROOFS PASS' : `❌ ${failures} TOOLSEARCH WIRE-HONESTY PROOF(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
