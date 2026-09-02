#!/usr/bin/env bun
// ============================================================================
//  scripts/core-runtime/prove-field-findings-input-family.ts — three input
// seams from the TASK-017 supplement, each SURVIVED its
//  adversarial re-read and each fixed at its owner:
//
//   §1 `early-input-eats-introducer-not-final`: the boot capture's escape
//      skip stopped ON the CSI/SS3 introducer ('['/'O' sit inside the
//      terminating range), so an arrow pressed during startup seeded its
//      FINAL byte ('A') into the composer as a literal.
//   §2 `clipboard-hint-args-swapped`: useClipboardImageHint(isFocused,
//      enabled) was called (enabled, isFocused) at both composers, so the
//      focus transition never fired and the hint was unreachable.
//   §3 `paste-candidates-split-on-lf-only`: the paste-to-attachment
//      splitter split on LF alone — a Windows console paste is
//      CR-delimited, so two dragged paths glued into one candidate that no
//      longer ended in an image extension.
//
//  Run: ~/.bun/bin/bun run scripts/core-runtime/prove-field-findings-input-family.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('§1 the boot capture discards escape sequences WHOLE')
{
  const { __processEarlyChunkForTest, consumeEarlyInput } = await import('../../src/utils/earlyInput.ts')
  const drive = (chunk: string): string => {
    consumeEarlyInput() // drain any prior state
    __processEarlyChunkForTest(chunk)
    return consumeEarlyInput()
  }
  check("an up-arrow (ESC [ A) seeds NOTHING — the finder's repro", drive('\u001b[A') === '')
  check('a CSI with parameters (ctrl+arrow, ESC [ 1 ; 5 D) seeds nothing', drive('\u001b[1;5D') === '')
  check('an SS3 function key (F1, ESC O P) seeds nothing', drive('\u001bOP') === '')
  check('the sequence is stripped from surrounding typing', drive('hi\u001b[Byo') === 'hiyo')
  check('a two-char escape (alt+x) is discarded whole', drive('\u001bx') === '')
  check('plain typing still lands', drive('abc') === 'abc')
  check('CR still folds to newline', drive('a\rb') === 'a\nb')
}

console.log('§2 the clipboard-image hint is wired (isFocused, enabled) at both composers')
{
  const text = readFileSync(join(ROOT, 'src/components/TextInput.tsx'), 'utf8')
  const vim = readFileSync(join(ROOT, 'src/components/VimTextInput.tsx'), 'utf8')
  for (const [name, src] of [['TextInput', text], ['VimTextInput', vim]] as const) {
    check(
      `${name} passes the focus fact first and the capability second`,
      src.includes('useClipboardImageHint(terminalFocused, Boolean(props.onImagePaste))'),
    )
    check(`${name}'s swapped pre-fix call is gone`, !src.includes('useClipboardImageHint(Boolean(props.onImagePaste), terminalFocused)'))
  }
}

console.log('§3 paste candidates split on every line-break class')
{
  const { splitPasteCandidates } = await import('../../src/hooks/usePasteHandler.ts')
  check(
    "a CR-delimited Windows console paste splits (the finder's two dragged .pngs)",
    JSON.stringify(splitPasteCandidates('C:\\a\\one.png\rC:\\a\\two.png')) === JSON.stringify(['C:\\a\\one.png', 'C:\\a\\two.png']),
  )
  check('CRLF splits', splitPasteCandidates('a.png\r\nb.png').length === 2)
  check('LF still splits', splitPasteCandidates('a.png\nb.png').length === 2)
  check('space-before-absolute-path still splits', splitPasteCandidates('/x/a.png /x/b.png').length === 2)
  check('a single path stays whole', JSON.stringify(splitPasteCandidates('C:\\a\\one.png')) === JSON.stringify(['C:\\a\\one.png']))
}
// NEEDS-REAL-BOX: press ↑ during a slow boot — the composer holds no 'A';
// on Windows Terminal drag two .png files onto the composer — two image
// chips appear.

console.log('§4 a held key still fires its single-letter binding (`key-repeat-run-loses-its-name`)')
{
  const { getKeyName, matchesKeystroke } = await import('../../src/keybindings/match.ts')
  const bare = {
    escape: false, return: false, tab: false, backspace: false, delete: false,
    upArrow: false, downArrow: false, leftArrow: false, rightArrow: false,
    pageUp: false, pageDown: false, wheelUp: false, wheelDown: false,
    home: false, end: false, ctrl: false, shift: false, meta: false, super: false,
  } as never
  check("a coalesced repeat run names its letter ('jjjj' → j; one atom, one step)", getKeyName('jjjj', bare) === 'j')
  check('a held capital folds like a single one', getKeyName('JJJ', bare) === 'j')
  check('a mixed run stays nameless (a real paste body)', getKeyName('jk', bare) === null && getKeyName('abc', bare) === null)
  check('a control-byte run stays nameless', getKeyName('\x03\x03', bare) === null)
  const j = { key: 'j', ctrl: false, shift: false, alt: false, meta: false, super: false } as never
  check('the run MATCHES the binding a single press matches', matchesKeystroke('jjjj', bare, j) && matchesKeystroke('j', bare, j))
}
// Recorded, not fixed here: the vim NORMAL motions read rawInput through
// their own transitions and keep the equality guard — the same disease at
// a different owner.

// §4 the vim '?' help affordance is draft-content-aware: a ? pressed while
// NORMAL-idle on a NON-EMPTY draft used to replace the whole draft with the
// literal '?' (the composer's help guard only opens on an empty draft, so
// the fluent type→esc→? gesture fell through it and cost the draft with
// nothing on screen explaining it — undo recovered, silently). The hook now
// checks the draft itself before firing the affordance.
{
  const hook = readFileSync(join(ROOT, 'src/hooks/useVimInput.ts'), 'utf8')
  check(
    "the ? affordance fires only on an EMPTY draft (never a draft replace)",
    /wasIdle && input === '\?' && props\.value === ''/.test(hook),
  )
}

process.exit(failures === 0 ? 0 : 1)
