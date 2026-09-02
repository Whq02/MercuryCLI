#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-field-findings-composer.ts
// TASK-017 SUPPLEMENT 3 fixes — the composer.
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-field-findings-composer.ts
// ============================================================================
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

// ── §1 · CI-01: the external-editor round-trip commits what the editor returned
// Finding CI-01 (important): editPromptInEditor returns `{ content, error? }`
// (EditorResult) and the composer read `returned.text` behind a cast that
// silenced tsc — `typeof undefined === 'string'` was always false, so the
// commit block was unreachable and every external edit was silently
// discarded. The POISON is the cast + the `.text` read.
console.log('§1 CI-01 — the composer reads the field the editor returns')
{
  const composer = read('src/components/PromptInput/PromptInput.tsx')
  check('POISON: the `.text` cast is gone', !composer.includes('{ text?: string | null; error?: string }') && !composer.includes('returned.text'))
  check('the commit gates on result.content and lands it as the one atomic edit', composer.includes("} else if (typeof result.content === 'string' && result.content !== expanded) {") && composer.includes('pendingInput.edit(result.content)') && composer.includes('setCursorOffset(result.content.length)'))
  check('the error branch still toasts the editor failure', composer.includes('text: `external editor failed: ${result.error}`'))
  const editor = read('src/utils/promptEditor.ts')
  check('EditorResult declares content, never text (the contract the composer now reads)', /export type EditorResult = \{\s*\n\s*content: string \| null\s*\n\s*error\?: string\s*\n\}/.test(editor) && !/\btext\?: string/.test(editor))
  check('editPromptInEditor returns the spread result with content', editor.includes('return { ...result, content }'))
  // The class: every other caller of the same door already read .content.
  check('the sibling caller reads .content (the shape the composer rejoins)', read('src/components/agents/studio/StudioEditor.tsx').includes('if (result.content !== null && result.content !== doc.raw) {'))
}
// NEEDS-REAL-BOX (the finder's drill): no EDITOR/VISUAL (stock Windows), type
// a draft, ctrl+x ctrl+e, add a word in notepad, save, close — the composer
// shows the edited text; ctrl+_ restores the pre-editor draft whole.

// ── §2 · CI-02 — masked fields paint the mask OWNER's render ────
// The finder: masked key fields repainted the mask from a raw string length
// that counted ANSI escapes and newlines. Cursor.render → maskLine is the
// one mask owner (every grapheme masked, the document-last line keeps its
// six-grapheme tail, the caret rendered in place); BaseTextInput now paints
// that render untouched.
console.log('§2 CI-02 — the masked branch paints renderedValue (the owner already masked it)')
{
  const base = read('src/components/BaseTextInput.tsx')
  check('POISON: the mask.repeat re-mask is gone', !base.includes('mask.repeat(renderedValue.length)'))
  check('both callers hand the SAME mask to the owner (useTextInput)', read('src/components/TextInput.tsx').includes('mask: props.mask') && read('src/components/VimTextInput.tsx').includes('mask: props.mask'))
  // Driven: the owner's masked render through the exact path the field
  // paints — an inverting caret and a multi-grapheme secret. The mask count
  // follows GRAPHEMES (the tail-reveal law: document-last line keeps six),
  // and the caret's ANSI bytes never inflate the mask.
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
