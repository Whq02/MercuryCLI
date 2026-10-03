#!/usr/bin/env bun
// gate-watch: src/utils/permissions/flowClassifier.ts src/utils/permissions/classifierRouted.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'classifier-element-home-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'sk-ant-fixture-not-a-real-key'
delete process.env.MERCURY_HOME

const REPO = resolve(import.meta.dir, '..', '..')
let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log("the auto-mode check wraps the project instructions in Mercury's element")

await import('../../src/utils/permissions/decision/wrapper.ts')
const flow = await import('../../src/utils/permissions/flowClassifier.ts')
const state = await import('../../src/bootstrap/state.ts')
const reader = await import('../api/read-instruction-heading.ts')

const MARKER = 'ELEMENT-MARKER-51c2: never push without asking.'

section('§1 the prefix: the cached project instructions ride inside <project_instructions>')
{
  check("the element is Mercury's word", flow.CLASSIFIER_INSTRUCTIONS_ELEMENT === 'project_instructions')
  const build = (flow as { buildInstructionPrefix?: () => string | undefined }).buildInstructionPrefix ?? (() => undefined)
  check('the prefix builder is a seam the proof can drive', typeof (flow as { buildInstructionPrefix?: unknown }).buildInstructionPrefix === 'function')
  state.setCachedInstructionPrompt(null)
  check('no project instructions ⇒ no prefix', build() === undefined)
  state.setCachedInstructionPrompt(MARKER)
  const prefix = build() ?? ''
  check('the prefix opens with the words that name what it is', prefix.startsWith("The following is the user's project configuration"), prefix.slice(0, 80))
  check('the instructions sit inside the element, opened and closed', prefix.endsWith(`<project_instructions>\n${MARKER}\n</project_instructions>`), prefix.slice(-120))
  const tags = prefix.match(/<\/?([A-Za-z_][\w-]*)>/g) ?? []
  check('the element is the only tag in the prefix', tags.join(' ') === '<project_instructions> </project_instructions>', tags.join(' '))
  check('the live-check reader finds the same element', reader.classifierTagOf(prefix) === 'project_instructions', String(reader.classifierTagOf(prefix)))
}

section('§2 both request roads carry the prefix as written')
{
  const requestOptions = (flow as { classifierRequestOptions?: (args: unknown) => { messages: Array<{ role: string; content: unknown }> } }).classifierRequestOptions
  const options = requestOptions
    ? requestOptions({
        model: 'claude-opus-4-8',
        systemPrompt: 'judge the action',
        content: [{ type: 'text', text: 'User: do the thing' }],
        maxTokens: 64,
        signal: new AbortController().signal,
      })
    : { messages: [] }
  const first = options.messages[0]
  const firstText = Array.isArray(first?.content) ? (first.content[0] as { text?: string } | undefined)?.text ?? '' : ''
  check('the Anthropic road: the prefix is the leading user message', options.messages.length === 2 && first?.role === 'user' && firstText.includes(`<project_instructions>\n${MARKER}\n</project_instructions>`), firstText.slice(0, 160))
  check('…and the reader finds the element in that request body', reader.reportRow({ body: options }).classifierTag === 'project_instructions')
  const routed = readFileSync(join(REPO, 'src/utils/permissions/classifierRouted.ts'), 'utf8')
  check('the routed road prepends the same prefix to its user prompt', /args\.instructionPrefix \? `\$\{args\.instructionPrefix\}\\n\\n` : ''/.test(routed))
  const source = readFileSync(join(REPO, 'src/utils/permissions/flowClassifier.ts'), 'utf8')
  check('the element is spelled once, through the constant', (source.match(/project_instructions/g) ?? []).length === 1 && /<\$\{CLASSIFIER_INSTRUCTIONS_ELEMENT\}>/.test(source))
  state.setCachedInstructionPrompt(null)
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(` ✅ CLASSIFIER INSTRUCTIONS ELEMENT GREEN (${checks} checks)`)
  process.exit(0)
}
console.log(` ❌ CLASSIFIER INSTRUCTIONS ELEMENT RED (${failures} of ${checks} checks failed)`)
process.exit(1)
