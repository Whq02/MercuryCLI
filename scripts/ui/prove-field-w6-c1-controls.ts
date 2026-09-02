#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-field-w6-c1-controls.ts
//  TASK-018 wave 6 (input-encoding-and-ime) — the composer's committed-value
//  control filter now drops the C1 block (U+0080-U+009F), as its own comment
//  always claimed, and no longer lets strip-ansi eat the operator's next
//  character.
//
//  stripControls used to run strip-ansi FIRST over a class covering only C0
//  and DEL. Two failures followed: (1) strip-ansi's CSI branch accepts the
//  8-bit CSI introducer U+009B and consumes a final byte from the operator's
//  own text (so `G<U+009B>HI` lost its H); (2) strip-ansi's OSC branch is
//  7-bit only, so the 8-bit OSC introducer U+009D survived into the draft, the
//  transcript and the model. The fix removes C1 controls BEFORE strip-ansi.
//
//  This proof pins the transform against the SAME strip-ansi the product uses
//  and anchors the product source (importing the host component headless is
//  avoided; the real function is exported as __stripControlsForTest for the
//  live box). It pins strip-ansi's vendored regex behaviour, so RUN IT UNDER
//  NODE (or the built artifact), not bare bun. The repo carries no tsx: bundle
//  it for node first, beside the source so `../..` still reaches the root —
//    ~/.bun/bin/bun build scripts/ui/prove-field-w6-c1-controls.ts --target=node --outfile=scripts/ui/prove-field-w6-c1-controls.mjs && node scripts/ui/prove-field-w6-c1-controls.mjs
//  (bun scripts/search/lib/bundle-for-node.ts <entry> <outfile> does the same.)
// ============================================================================
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import stripAnsi from 'strip-ansi'

// import.meta.url, not import.meta.dir: only Bun defines .dir, and this proof
// runs under node as a bun-built bundle (the precedent is prove-ink-feel). A
// bundle written OUTSIDE the tree (the scratchpad, so nothing untracked is left
// inside the worktree) cannot reach the root by `../..`; then the working
// directory — the worktree the run is made from — is the root.
const HERE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ROOT = existsSync(join(HERE_ROOT, 'src', 'components')) ? HERE_ROOT : process.cwd()
let failures = 0
const check = (name: string, ok: boolean, detail?: string): void => {
  if (ok) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// The product's transform, transcribed (src/components/PromptInput/PromptInput.tsx).
const C1 = /[\u0080-\u009f]/g
const C0_DEL = /[\u0000-\u0008\u000b-\u001f\u007f]/g
const stripControls = (value: string): string => stripAnsi(value.replace(C1, '')).replace(C0_DEL, '')

const cp = (n: number): string => String.fromCodePoint(n)
const CSI8 = cp(0x009b) // 8-bit CSI introducer
const OSC8 = cp(0x009d) // 8-bit OSC introducer
const ST8 = cp(0x009c) // 8-bit string terminator
const NEL = cp(0x0085) // C1 NEL
const ESC = cp(0x001b) // C0 escape

console.log('§1 — the C1 block is dropped and the next character survives')
const cases: Array<{ name: string; input: string; want: string }> = [
  { name: 'U+009B no longer eats the following H', input: 'G' + CSI8 + 'HI', want: 'GHI' },
  { name: 'U+009B no longer eats a following letter (m)', input: 'G' + CSI8 + 'mI', want: 'GmI' },
  { name: 'U+009B no longer eats three characters', input: 'G' + CSI8 + '1HI', want: 'G1HI' },
  { name: 'a trailing U+009B is dropped, not left in the value', input: 'G' + CSI8, want: 'G' },
  { name: 'C1 NEL (U+0085) is dropped, not kept', input: 'G' + NEL + 'I', want: 'GI' },
  { name: '8-bit OSC introducer/terminator are dropped', input: 'G' + OSC8 + 'xyz' + ST8 + 'I', want: 'GxyzI' },
  { name: '7-bit ANSI is still stripped (unchanged)', input: 'G' + ESC + '[31mRED', want: 'GRED' },
  { name: 'ordinary text is untouched', input: 'hello world', want: 'hello world' },
]
for (const c of cases) {
  const got = stripControls(c.input)
  check(c.name, got === c.want, `got ${JSON.stringify(got)}`)
}

console.log('§2 — the product source carries the two-pass C1-before-strip-ansi filter')
{
  const src = readFileSync(join(ROOT, 'src/components/PromptInput/PromptInput.tsx'), 'utf8')
  const fn = src.slice(src.indexOf('function stripControls'), src.indexOf('function stripControls') + 400)
  check('C1 is removed inside the strip-ansi call (before it runs)', /stripAnsi\(value\.replace\(\/\[\\u0080-\\u009f\]\/g/.test(fn))
  check('the C0/DEL class still follows strip-ansi', fn.includes('\\u0000-\\u0008\\u000b-\\u001f\\u007f'))
  check('POISON: the old single-pass (strip-ansi then one class) is gone', !/return stripAnsi\(value\)\.replace/.test(fn))
  check('the test seam is exported', src.includes('export const __stripControlsForTest = stripControls'))
}

process.exit(failures === 0 ? 0 : 1)
