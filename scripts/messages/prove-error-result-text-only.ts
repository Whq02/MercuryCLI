import { resolve } from 'node:path'

const root = resolve(process.argv[2] ?? new URL('../..', import.meta.url).pathname)
const { sanitizeErrorToolResultContent } = await import(`${root}/src/utils/messages/apiFilters.ts`)
let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}
const text = (value: string) => ({ type: 'text', text: value })
const image = () => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } })
const result = (content: unknown, isError: boolean) => ({ type: 'tool_result', tool_use_id: 'toolu_x', content, is_error: isError })
const user = (content: unknown) => ({ type: 'user', uuid: 'u', message: { role: 'user', content } })
const assistant = () => ({ type: 'assistant', uuid: 'a', message: { role: 'assistant', content: [text('hi')] } })

const mixed = result([text('first'), image(), text('second')], true)
const fine = result([text('ok'), image()], false)
const plain = text('a plain block')
const before = [assistant(), user('a string body'), user([plain, mixed, fine])]
const after = sanitizeErrorToolResultContent(before)
check('assistant rows and string-bodied user rows come back by reference', after[0] === before[0] && after[1] === before[1])
check('an error result mixing images and text keeps the text alone, joined by a blank line', JSON.stringify(after[2].message.content[1]) === JSON.stringify({ type: 'tool_result', tool_use_id: 'toolu_x', content: [text('first\n\nsecond')], is_error: true }), JSON.stringify(after[2].message.content[1]))
check('the other blocks of a changed row keep their identity', after[2].message.content[0] === plain && after[2].message.content[2] === fine)
check('a changed row is a copy and the input is untouched', after[2] !== before[2] && before[2].message.content[1] === mixed && mixed.content.length === 3)

const noText = sanitizeErrorToolResultContent([user([result([image()], true)])])
check('an error result with no text at all becomes an empty list', JSON.stringify(noText[0].message.content[0].content) === '[]')

const textual = user([result([text('only text')], true), result('a string', true), result([], true)])
check('all-text, string and empty error results leave the row by reference', sanitizeErrorToolResultContent([textual])[0] === textual)

console.log(`${failures ? 'FAIL' : 'PASS'} error result text only: ${failures} failures`)
process.exit(failures ? 1 : 0)
