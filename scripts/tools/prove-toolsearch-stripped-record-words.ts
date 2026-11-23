#!/usr/bin/env bun
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

console.log('============================================================')
console.log(' ToolSearch — a stripped admission record tells the model its tools are in the list')
console.log('============================================================')

const { STRIPPED_ADMISSION_RECORD_TEXT } = await import('../../src/tools/kit/names/toolSearch.ts')
const { createUserMessage, stripToolReferenceBlocksFromUserMessage } = await import('../../src/engine/messages/messages.ts')

type Block = { type: string; text?: string; tool_name?: string; content?: Block[] }
const strip = (content: Block[]): Block[] => {
  const message = createUserMessage({ content: content as never })
  const stripped = stripToolReferenceBlocksFromUserMessage(message as never) as { message: { content: Block[] } }
  return stripped.message.content
}

console.log('\n§1 a record made only of tool references')
const only = strip([{ type: 'tool_result', tool_name: undefined, content: [{ type: 'tool_reference', tool_name: 'SendMessage' }, { type: 'tool_reference', tool_name: 'Monitor' }], ...({ tool_use_id: 'toolu_search_1' } as object) }])
const text = only[0]?.content?.[0]?.text ?? ''
check('the record becomes one text block inside the same tool result', only.length === 1 && only[0]?.type === 'tool_result' && only[0]?.content?.length === 1 && only[0]?.content?.[0]?.type === 'text', JSON.stringify(only) + ' — projectReferences in src/engine/messages/apiViewRows.ts must replace an all-reference tool result with one text block')
check("the text is the tool search module's own words", text === STRIPPED_ADMISSION_RECORD_TEXT, text + ' — stripToolReferenceBlocksFromUserMessage in src/engine/messages/apiViewRows.ts must use STRIPPED_ADMISSION_RECORD_TEXT from src/tools/kit/names/toolSearch.ts')
check("the words say every tool's full schema is in this request's tool list and to call the tools directly", text.includes("every tool's full schema is in this request's tool list") && text.includes('call the tools directly'), text + ' — reword STRIPPED_ADMISSION_RECORD_TEXT in src/tools/kit/names/toolSearch.ts to carry both phrases')
check('the words no longer call the search not enabled', !text.includes('not enabled'), text + ' — remove the not enabled wording from STRIPPED_ADMISSION_RECORD_TEXT in src/tools/kit/names/toolSearch.ts')

console.log('\n§2 a record carrying its own text keeps the text and drops the references')
const mixed = strip([{ type: 'tool_result', content: [{ type: 'text', text: 'admitted:' }, { type: 'tool_reference', tool_name: 'SendMessage' }], ...({ tool_use_id: 'toolu_search_2' } as object) }])
check('the text stays, the reference goes, no placeholder is added', mixed[0]?.content?.length === 1 && mixed[0]?.content?.[0]?.text === 'admitted:', JSON.stringify(mixed) + ' — projectReferences in src/engine/messages/apiViewRows.ts must add the placeholder only when no kept items remain')


console.log(failures === 0 ? '\n  ALL PASS' : `\n  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
