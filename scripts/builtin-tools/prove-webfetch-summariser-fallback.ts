#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const { applyPromptToMarkdown } = await import('../../src/tools/WebFetchTool/utils.ts')
const { AbortError } = await import('../../src/utils/errors.ts')

const fakeMsg = (text: string) => ({ message: { content: [{ type: 'text', text }] } })
const thrower = (msg: string) => async () => {
  throw new Error(msg)
}
const sig = new AbortController().signal

console.log('============================================================')
console.log(' WebFetch summariser — the session family tier, then the session model, then an honest road')
console.log('============================================================')

section('§1 the small-fast tier answers: its summary comes back with no note')
const r1 = await applyPromptToMarkdown('q', 'PAGE', sig, true, false, { small: async () => fakeMsg('SUMMARY') as never, withModel: thrower('should not run') as never, smallModelId: () => 'haiku', mainModelId: () => 'opus' })
check('the primary summary is returned as is', r1 === 'SUMMARY', r1)

section("§2 the small-fast tier has no credential: the session's own model is the second road")
const r2 = await applyPromptToMarkdown('q', 'PAGE', sig, true, false, { small: thrower('the small tier credential was refused') as never, withModel: async () => fakeMsg('FALLBACK') as never, smallModelId: () => 'haiku', mainModelId: () => 'opus' })
check('the fallback summary is returned, and it is a summary not a note', r2 === 'FALLBACK')

section('§3 both roads fail: the page content comes back with a note that names the road')
const r3 = await applyPromptToMarkdown('q', 'PAGE CONTENT', sig, true, false, { small: thrower('small refused') as never, withModel: thrower('opus refused') as never, smallModelId: () => 'haiku', mainModelId: () => 'opus' })
check('the note says no summariser was available', r3.includes('no summariser model was available'))
check('the note names both roads it took', r3.includes('Road: tried the small-fast model haiku (small refused), then the session model opus (opus refused)'), r3)
check('the page content is delivered under the note', r3.trimEnd().endsWith('PAGE CONTENT'))
check('a non-preapproved domain keeps the quote ceiling in the note', r3.includes('keep every quotation under 125 characters'))

section('§4 the session model equals the small tier: one road, no invented second')
const r4 = await applyPromptToMarkdown('q', 'PAGE', sig, true, false, { small: thrower('refused') as never, withModel: thrower('should not run') as never, smallModelId: () => 'm', mainModelId: () => 'm' })
check('the note says the session model is the same, no second road', r4.includes('the session model is the same, so there was no second road') && !r4.includes('should not run'), r4)

section('§5 a preapproved domain carries no quote ceiling in the note')
const r5 = await applyPromptToMarkdown('q', 'PAGE', sig, true, true, { small: thrower('x') as never, withModel: thrower('y') as never, smallModelId: () => 'a', mainModelId: () => 'b' })
check('the preapproved note omits the quote ceiling', !r5.includes('keep every quotation'))

section('§6 an aborted signal throws, never a degraded note')
const ac = new AbortController()
ac.abort()
let threw = false
try {
  await applyPromptToMarkdown('q', 'PAGE', ac.signal, true, false, { small: async () => fakeMsg('x') as never, withModel: thrower('y') as never, smallModelId: () => 'a', mainModelId: () => 'b' })
} catch (e) {
  threw = e instanceof AbortError
}
check('the abort throws AbortError', threw)

section('§7 the fetch tool wires the two roads')
const utils = readFileSync(join(ROOT, 'src/tools/WebFetchTool/utils.ts'), 'utf8')
check('it reaches for the session small-fast tier and the session model', utils.includes('sessionSmallFastModel') && utils.includes('getMainLoopModel') && utils.includes('queryWithModel'))
check('the fallback runs the session model through queryWithModel with that model', utils.includes('await withModel(') && utils.includes('model: fallbackModel'))
const tool = readFileSync(join(ROOT, 'src/tools/WebFetchTool/WebFetchTool.ts'), 'utf8')
check('the tool still calls applyPromptToMarkdown', tool.includes('applyPromptToMarkdown('))

console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
