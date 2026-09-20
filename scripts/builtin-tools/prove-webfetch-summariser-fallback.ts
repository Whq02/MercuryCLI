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

section('§8 the first leg answers an API error message, not a throw: a failed leg, and the session model is asked')
const errMsg = (text: string) => ({ isApiErrorMessage: true, message: { content: [{ type: 'text', text }] } })
const REFUSAL = "API Error: model 'gpt-5.4-mini' is not offered by the ChatGPT pro subscription live catalogue. The catalogue offers: gpt-6-astra, gpt-5.6-sol."
const r8 = await applyPromptToMarkdown('q', 'PAGE', sig, true, false, { small: async () => errMsg(REFUSAL) as never, withModel: async () => fakeMsg('FALLBACK') as never, smallModelId: () => 'gpt-5.4-mini', mainModelId: () => 'gpt-5.6-sol' })
check('the refusal is never returned as the summary; the fallback summary is', r8 === 'FALLBACK', r8)

section('§9 both legs answer API error messages: the page with the note naming both roads and both reasons')
const r9 = await applyPromptToMarkdown('q', 'PAGE CONTENT', sig, true, false, { small: async () => errMsg('API Error: small refused') as never, withModel: async () => errMsg('API Error: session refused') as never, smallModelId: () => 'haiku', mainModelId: () => 'opus' })
check('the note names both roads with the error words as the reasons', r9.includes('Road: tried the small-fast model haiku (API Error: small refused), then the session model opus (API Error: session refused)'), r9)
check('the page content is delivered under the note', r9.trimEnd().endsWith('PAGE CONTENT'))

section('§10 a thrown first leg, then an API error message on the fallback: the note carries each road its own reason')
const r10 = await applyPromptToMarkdown('q', 'PAGE', sig, true, false, { small: thrower('small refused') as never, withModel: async () => errMsg('API Error: session refused') as never, smallModelId: () => 'haiku', mainModelId: () => 'opus' })
check('the thrown reason and the error-message reason sit on their own roads', r10.includes('Road: tried the small-fast model haiku (small refused), then the session model opus (API Error: session refused)'), r10)

section('§11 the marker decides, never the words: a true answer that quotes an error line is the summary')
const QUOTING = 'API Error: the page quotes this line as an example, and it is the summary'
const r11 = await applyPromptToMarkdown('q', 'PAGE', sig, true, false, { small: async () => fakeMsg(QUOTING) as never, withModel: thrower('should not run') as never, smallModelId: () => 'haiku', mainModelId: () => 'opus' })
check('an unmarked reply is returned as is, whatever its words', r11 === QUOTING, r11)

section('§12 every API-error text Mercury mints carries the marker, so an unmarked refusal cannot reach the tool')
const { readdirSync, statSync } = await import('node:fs')
const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  const path = join(dir, name)
  return statSync(path).isDirectory() ? walk(path) : /\.tsx?$/.test(path) ? [path] : []
})
const sources = [...walk(join(ROOT, 'src/services/providers')), ...walk(join(ROOT, 'src/services/api')), ...walk(join(ROOT, 'src/utils/messages'))]
const bare: string[] = []
const plainFactory: string[] = []
for (const file of sources) {
  const text = readFileSync(file, 'utf8')
  const where = (index: number): string => `${file.slice(ROOT.length + 1)}:${text.slice(0, index).split('\n').length}`
  const templated = /content: `\$\{API_ERROR_MESSAGE_PREFIX\}/g
  let hit: RegExpExecArray | null
  while ((hit = templated.exec(text)) !== null) {
    if (!/createAssistantAPIErrorMessage\(|apiErrorMessage\(/.test(text.slice(Math.max(0, hit.index - 240), hit.index))) bare.push(where(hit.index))
  }
  const plain = /createAssistantMessage\(\{[^}]{0,200}API_ERROR_MESSAGE_PREFIX/g
  while ((hit = plain.exec(text)) !== null) plainFactory.push(where(hit.index))
}
check('no templated API-error content is built outside the marker factory or a provider helper that calls it', bare.length === 0, bare.join(', '))
check('no plain assistant message carries the API-error prefix (the unmarked factory never mints a refusal)', plainFactory.length === 0, plainFactory.join(', '))
const factories = readFileSync(join(ROOT, 'src/utils/messages/factories.ts'), 'utf8')
check('the marker factory sets isApiErrorMessage', /export function createAssistantAPIErrorMessage\([\s\S]{0,1200}isApiErrorMessage: true/.test(factories))
for (const helper of ['src/services/providers/openai/openaiCallModel.ts', 'src/services/providers/openaicompat/compatChatCallModel.ts', 'src/services/providers/zai/zaiCallModel.ts']) {
  check(`${helper} builds its API-error messages through the marker factory`, /function apiErrorMessage\([\s\S]{0,500}return createAssistantAPIErrorMessage\(/.test(readFileSync(join(ROOT, helper), 'utf8')))
}

section('§7 the fetch tool wires the two roads')
const utils = readFileSync(join(ROOT, 'src/tools/WebFetchTool/utils.ts'), 'utf8')
check('it reaches for the session small-fast tier and the session model', utils.includes('sessionSmallFastModel') && utils.includes('getMainLoopModel') && utils.includes('queryWithModel'))
check('the fallback runs the session model through queryWithModel with that model', utils.includes('await withModel(') && utils.includes('model: fallbackModel'))
const tool = readFileSync(join(ROOT, 'src/tools/WebFetchTool/WebFetchTool.ts'), 'utf8')
check('the tool still calls applyPromptToMarkdown', tool.includes('applyPromptToMarkdown('))

console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
