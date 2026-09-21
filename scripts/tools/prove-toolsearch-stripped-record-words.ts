#!/usr/bin/env bun
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const ROOT = join(import.meta.dir, '..', '..')

console.log('============================================================')
console.log(' ToolSearch — a stripped admission record tells the model its tools are in the list')
console.log('============================================================')

const { STRIPPED_ADMISSION_RECORD_TEXT } = await import('../../src/tools/ToolSearchTool/prompt.ts')
const { createUserMessage, stripToolReferenceBlocksFromUserMessage } = await import('../../src/utils/messages.ts')

type Block = { type: string; text?: string; tool_name?: string; content?: Block[] }
const strip = (content: Block[]): Block[] => {
  const message = createUserMessage({ content: content as never })
  const stripped = stripToolReferenceBlocksFromUserMessage(message as never) as { message: { content: Block[] } }
  return stripped.message.content
}

console.log('\n§1 a record made only of tool references')
const only = strip([{ type: 'tool_result', tool_name: undefined, content: [{ type: 'tool_reference', tool_name: 'SendMessage' }, { type: 'tool_reference', tool_name: 'Monitor' }], ...({ tool_use_id: 'toolu_search_1' } as object) }])
const text = only[0]?.content?.[0]?.text ?? ''
check('the record becomes one text block inside the same tool result', only.length === 1 && only[0]?.type === 'tool_result' && only[0]?.content?.length === 1 && only[0]?.content?.[0]?.type === 'text', JSON.stringify(only))
check("the text is the tool search module's own words", text === STRIPPED_ADMISSION_RECORD_TEXT, text)
check("the words say every tool's full schema is in this request's tool list and to call the tools directly", text.includes("every tool's full schema is in this request's tool list") && text.includes('call the tools directly'), text)
check('the words no longer call the search not enabled', !text.includes('not enabled'), text)

console.log('\n§2 a record carrying its own text keeps the text and drops the references')
const mixed = strip([{ type: 'tool_result', content: [{ type: 'text', text: 'admitted:' }, { type: 'tool_reference', tool_name: 'SendMessage' }], ...({ tool_use_id: 'toolu_search_2' } as object) }])
check('the text stays, the reference goes, no placeholder is added', mixed[0]?.content?.length === 1 && mixed[0]?.content?.[0]?.text === 'admitted:', JSON.stringify(mixed))

console.log('\n§3 the words hold on every road that strips: no tool defers there, so every schema rides the list')
const streamCore = readFileSync(join(ROOT, 'src', 'services', 'providers', 'anthropic', 'streamCore.ts'), 'utf8')
check('the stream road defers a schema only while the request uses tool search', streamCore.includes('const willDefer = (t: Tool) => useToolSearch && blockForm && deferredToolNames.has(t.name)'))
check('…and strips the records only where it does not', /if \(!useToolSearch\) \{\s*\n\s*messagesForAPI = messagesForAPI\.map\(msg => \{\s*\n\s*switch \(msg\.type\) \{\s*\n\s*case 'user':\s*\n\s*return stripToolReferenceBlocksFromUserMessage\(msg\)/.test(streamCore))
const apiView = readFileSync(join(ROOT, 'src', 'utils', 'messages', 'apiView.ts'), 'utf8')
check('the api view reads the words from the tool search module and spells none of its own', apiView.includes("import { STRIPPED_ADMISSION_RECORD_TEXT } from '../../tools/ToolSearchTool/prompt.js'") && apiView.includes('text: STRIPPED_ADMISSION_RECORD_TEXT') && !apiView.includes('tool search not enabled'))
const old = spawnSync('grep', ['-rl', 'tool search not enabled', join(ROOT, 'src')], { encoding: 'utf8' })
check('the old words are spelled nowhere under src', old.status === 1 && old.stdout.trim() === '', old.stdout)

console.log(failures === 0 ? '\n  ALL PASS' : `\n  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
