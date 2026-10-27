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
const roads = { smallModelId: () => 'claude-haiku-5-5', mainModelId: () => 'claude-fable-5-1' }

console.log('============================================================')
console.log(' WebFetch summariser — the reading is every text block of the reply, wherever the thinking lands')
console.log('============================================================')

section('§1 a reply that opens with a thinking block (the always-on family at any effort) still yields its text')
{
  const r = await applyPromptToMarkdown('q', 'PAGE', sig, true, false, { ...roads, small: async () => reply([thinking('the model reasons first'), text('SUMMARY')]) as never, withModel: thrower('the second road must not run') as never })
  check('the small-fast tier\'s [thinking, text] reply is the reading', r === reading('SUMMARY'), r)
  const r2 = await applyPromptToMarkdown('q', 'PAGE', sig, true, false, { ...roads, small: thrower('small refused') as never, withModel: async () => reply([thinking('reasoning'), text('FALLBACK')]) as never })
  check('the session model\'s [thinking, text] reply is the reading on the second road', r2 === reading('FALLBACK'), r2)
}

section('§2 several text blocks join; a thinking block between them is not text')
{
  const r = await applyPromptToMarkdown('q', 'PAGE', sig, true, false, { ...roads, small: async () => reply([text('first'), thinking('more reasoning'), text('second')]) as never, withModel: thrower('must not run') as never })
  check('the reading carries both text blocks, line-separated', r === reading('first\nsecond'), r)
}

section('§3 a reply with no words is no reading: the next road is asked, then the page itself')
{
  const r = await applyPromptToMarkdown('q', 'PAGE', sig, true, false, { ...roads, small: async () => reply([thinking('only reasoning')]) as never, withModel: async () => reply([text('   ')]) as never })
  check('a thinking-only reply and a blank reply both read as no text; the page comes back with the road', r.includes('Road: tried the small-fast model claude-haiku-5-5 (the reply carried no text), then the session model claude-fable-5-1 (the reply carried no text)') && r.trimEnd().endsWith('PAGE'), r)
}

section('§4 an API-error reply still reads its words through every text block')
{
  const r = await applyPromptToMarkdown('q', 'PAGE', sig, true, false, { ...roads, small: async () => ({ isApiErrorMessage: true, message: { content: [thinking('x'), text('API Error: small refused')] } }) as never, withModel: async () => reply([text('FALLBACK')]) as never })
  check('the refusal\'s words are the first road\'s reason and the fallback answers', r === reading('FALLBACK'), r)
}

console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
