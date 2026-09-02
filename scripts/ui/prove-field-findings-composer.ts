#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

let failures = 0
const check = (name: string, ok: boolean, detail?: string): void => {
  if (ok) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('§1 CI-01 — the composer reads the field the editor returns')
{
  const composer = read('src/components/PromptInput/PromptInput.tsx')
  check('POISON: the `.text` cast is gone', !composer.includes('{ text?: string | null; error?: string }') && !composer.includes('returned.text'))
  check('the commit gates on result.content and lands it as the one atomic edit', composer.includes("} else if (typeof result.content === 'string' && result.content !== expanded) {") && composer.includes('pendingInput.edit(result.content)') && composer.includes('setCursorOffset(result.content.length)'))
  check('the error branch still toasts the editor failure', composer.includes('text: `external editor failed: ${result.error}`'))
  const editor = read('src/utils/promptEditor.ts')
  check('EditorResult declares content, never text (the contract the composer now reads)', /export type EditorResult = \{\s*\n\s*content: string \| null\s*\n\s*error\?: string\s*\n\}/.test(editor) && !/\btext\?: string/.test(editor))
  check('editPromptInEditor returns the spread result with content', editor.includes('return { ...result, content }'))
  check('the sibling caller reads .content (the shape the composer rejoins)', read('src/components/agents/studio/StudioEditor.tsx').includes('if (result.content !== null && result.content !== doc.raw) {'))
}

console.log('§2 CI-02 — the masked branch paints renderedValue (the owner already masked it)')
{
  const base = read('src/components/BaseTextInput.tsx')
  check('POISON: the mask.repeat re-mask is gone', !base.includes('mask.repeat(renderedValue.length)'))
  check('both callers hand the SAME mask to the owner (useTextInput)', read('src/components/TextInput.tsx').includes('mask: props.mask') && read('src/components/VimTextInput.tsx').includes('mask: props.mask'))
  const { Cursor } = await import('../../src/utils/Cursor.ts')
  const INV = (s: string): string => `\x1b[7m${s}\x1b[27m`
  const secret = 'sk-ant-0123456789abcdef'
  const rendered = Cursor.fromText(secret, 80, secret.length).render('', '•', INV)
  const dots = (rendered.match(/•/g) ?? []).length
  check('the masked render masks every grapheme but the six-tail', dots === [...secret].length - 6, `dots=${dots}`)
  check('the six-grapheme tail stays readable (the reveal law)', rendered.includes('abcdef'))
  check('the head never leaks', !rendered.includes('sk-ant'))
}

process.exit(failures === 0 ? 0 : 1)
