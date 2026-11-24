import assert from 'node:assert/strict'
import React from 'react'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
const { FallbackToolUseErrorMessage } = await import('../../src/tools/kit/FallbackToolUseErrorMessage.js')
const { renderToString } = await import('../../src/screen/renderer/staticRender.js')
const plain = 'Error: ENOENT: missing file\n    at open (file.ts:1:2)'
const decorated = '\u001b[31mError:\u001b[0m ENOENT: missing file\n\u001b[32m    at open (file.ts:1:2)\u001b[0m\u001b[2K'
for (const verbose of [false, true]) {
  const expected = await renderToString(React.createElement(FallbackToolUseErrorMessage, { result: plain, verbose }), 100)
  const actual = await renderToString(React.createElement(FallbackToolUseErrorMessage, { result: decorated, verbose }), 100)
  assert.equal(actual, expected, 'collapsed and expanded tool errors paint the same text without ANSI: FallbackToolUseErrorMessage in src/tools/kit/FallbackToolUseErrorMessage.tsx must strip escape sequences from the result before it renders')
  const linked = '\u001b]8;;https://example.test\u0007' + plain + '\u001b]8;;\u0007'
  assert.equal(await renderToString(React.createElement(FallbackToolUseErrorMessage, { result: linked, verbose }), 100), expected, 'a result wrapped in an OSC 8 link must render as the plain text: FallbackToolUseErrorMessage in src/tools/kit/FallbackToolUseErrorMessage.tsx must strip link sequences as well as colour codes')
  console.log(expected)
}
console.log('tool error ANSI: PASS')
