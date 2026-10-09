import { resolve } from 'node:path'

const root = resolve(process.argv[2] ?? new URL('../..', import.meta.url).pathname)
const { smooshIntoToolResult } = await import(`${root}/src/utils/messages/merge.ts`)
let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}
const text = (value: string, extra: Record<string, unknown> = {}) => ({ type: 'text', text: value, ...extra })
const image = (tag: string) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: tag } })
const result = (content: unknown, extra: Record<string, unknown> = {}) => ({ type: 'tool_result', tool_use_id: 'toolu_smoosh', content, ...extra })
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

const untouched = result('out')
check('no incoming blocks returns the same block', smooshIntoToolResult(untouched, []) === untouched)

const referenced = result([text('x'), { type: 'tool_reference', tool_name: 'Agent' }])
check('a result already carrying a tool_reference refuses the merge', smooshIntoToolResult(referenced, [text('y')]) === null)

const errored = result('failed', { is_error: true })
check('an error result ignores non-text blocks and comes back by reference when nothing is left', smooshIntoToolResult(errored, [image('i1')]) === errored)
const erroredText = smooshIntoToolResult(errored, [text(' more '), image('i2')])
check('an error result keeps the text and stays a string', erroredText.content === 'failed\n\nmore' && erroredText.is_error === true && errored.content === 'failed')

const stringShape = smooshIntoToolResult(result(undefined), [text(' a '), text('   '), text('b')])
check('absent content with all-text blocks becomes one string, trimmed, blanks dropped', stringShape.content === 'a\n\nb')
check('blank text everywhere yields an empty string', smooshIntoToolResult(result('  '), [text(' ')]).content === '')
check('the merged block is a copy carrying the other fields', stringShape.tool_use_id === 'toolu_smoosh' && stringShape.type === 'tool_result')

const first = image('i3')
const second = image('i4')
const existingArray = [text('lead', { citations: [] }), first, text(' ')]
const arrayShape = smooshIntoToolResult(result(existingArray), [text('x'), text('y'), second, text(' z ')])
check('array content folds consecutive text into one fresh text block and passes images through', same(arrayShape.content, [text('lead'), first, text('x\n\ny'), second, text('z')]), JSON.stringify(arrayShape.content))
check('images keep their identity and text blocks are new objects', arrayShape.content[1] === first && arrayShape.content[3] === second && arrayShape.content[0] !== existingArray[0] && !('citations' in arrayShape.content[0]))
check('the existing array is not modified', existingArray.length === 3 && existingArray[2].text === ' ')

const mixedFromString = smooshIntoToolResult(result('out'), [text('x'), first])
check('string content with a non-text block becomes an array led by the folded text', same(mixedFromString.content, [text('out\n\nx'), first]))
check('absent content with a non-text block becomes that block alone', same(smooshIntoToolResult(result(undefined), [first]).content, [first]))
check('an error result with array content keeps only its text', same(smooshIntoToolResult(result([text('a')], { is_error: true }), [first, text('b')]).content, [text('a\n\nb')]))

console.log(`${failures ? 'FAIL' : 'PASS'} tool_result smoosh: ${failures} failures`)
process.exit(failures ? 1 : 0)
