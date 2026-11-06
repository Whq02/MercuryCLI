#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
export {}

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail.slice(0, 400) : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const { applyPromptToMarkdown } = await import('../../src/tools/WebFetchTool/utils.ts')

const sig = new AbortController().signal
const reply = (content: unknown[]) => ({ message: { content } })
const thinking = (text: string) => ({ type: 'thinking', thinking: text, signature: `sig-${text.length}` })
const text = (value: string) => ({ type: 'text', text: value })
const thrower = (msg: string) => async () => {
  throw new Error(msg)
}
const reading = (value: string) => `[Model reading of the extracted page, not the page’s own words.]\n\n${value}`
const roads = { utilityModelId: () => 'local/qwen3.5-2b', mainModelId: () => 'local/qwen3.8-27b' }
const oneRoad = { utilityModelId: () => 'claude-fable-5-1', mainModelId: () => 'claude-fable-5-1' }

console.log('============================================================')
console.log(' WebFetch summariser — the reading is every text block of the reply, wherever the thinking lands')
console.log('============================================================')

section('§1 a reply that opens with a thinking block (the always-on family at any effort) still yields its text')
{
  const r = await applyPromptToMarkdown('q', 'PAGE', sig, true, false, { ...roads, utility: async () => reply([thinking('the model reasons first'), text('SUMMARY')]) as never, withModel: thrower('the second road must not run') as never })
  check('the utility call\'s [thinking, text] reply is the reading', r === reading('SUMMARY'), r)
  const r2 = await applyPromptToMarkdown('q', 'PAGE', sig, true, false, { ...roads, utility: thrower('utility refused') as never, withModel: async () => reply([thinking('reasoning'), text('FALLBACK')]) as never })
  check('the session model\'s [thinking, text] reply is the reading on the second road', r2 === reading('FALLBACK'), r2)
}

section('§2 several text blocks join; a thinking block between them is not text')
{
  const r = await applyPromptToMarkdown('q', 'PAGE', sig, true, false, { ...roads, utility: async () => reply([text('first'), thinking('more reasoning'), text('second')]) as never, withModel: thrower('must not run') as never })
  check('the reading carries both text blocks, line-separated', r === reading('first\nsecond'), r)
}

section('§3 a reply with no words is no reading: the page itself comes back (the session model is the same model, so there is no second road)')
{
  const r = await applyPromptToMarkdown('q', 'PAGE', sig, true, false, { ...oneRoad, utility: async () => reply([thinking('only reasoning')]) as never, withModel: thrower('the same model is no second road') as never })
  check('a thinking-only reply reads as no text; the page comes back with the road, and no second road is invented for the same model', r.includes('Road: tried the utility model claude-fable-5-1 (the reply carried no text); the session model is the same, so there was no second road') && r.trimEnd().endsWith('PAGE'), r)
  const r2 = await applyPromptToMarkdown('q', 'PAGE', sig, true, false, { ...roads, utility: async () => reply([thinking('only reasoning')]) as never, withModel: async () => reply([text('   ')]) as never })
  check('with a local helper slot, a thinking-only reply and a blank reply both read as no text; the page comes back naming both roads', r2.includes('Road: tried the utility model local/qwen3.5-2b (the reply carried no text), then the session model local/qwen3.8-27b (the reply carried no text)') && r2.trimEnd().endsWith('PAGE'), r2)
}

section('§4 an API-error reply still reads its words through every text block')
{
  const r = await applyPromptToMarkdown('q', 'PAGE', sig, true, false, { ...roads, utility: async () => ({ isApiErrorMessage: true, message: { content: [thinking('x'), text('API Error: utility refused')] } }) as never, withModel: async () => reply([text('FALLBACK')]) as never })
  check('the refusal\'s words are the first road\'s reason and the fallback answers', r === reading('FALLBACK'), r)
}

console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
