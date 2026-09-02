#!/usr/bin/env bun
// ============================================================================
//  scripts/streaming/prove-tail-fence-carry.ts — the inline tail carries the
//  enclosing fence across its cut (FN-016 R22).
//
//  THE DEFECT: boundTailForInline slices the growing answer at a bare
//  newline offset. Once a fenced code block grows taller than the kept
//  window, the opening fence scrolls out and the kept slice is handed to
//  StreamingMarkdown WITHOUT it — the code loses its code dress and lexes
//  as prose: leading # become headings, - become bullets, * and _ become
//  emphasis, indentation collapses; and when the CLOSING fence becomes the
//  first kept line the remainder flips INTO a code block instead. At settle
//  the whole message re-parses correctly — the live tail and the settled
//  row showed the same text in two different dresses.
//
//  THE LAW: the cut carries the enclosing block state — the discarded
//  prefix's standing opener (marker + info string) rides out beside the
//  byte-identical kept text, and the renderer prepends it, so the tail's
//  lex matches the settled render's.
//
//   §1 openFenceOf: the fence ledger over a discarded prefix;
//   §2 the bound returns the standing opener beside the untouched slice;
//   §3 THE DRESS PIN, through the same lexer the renderer uses (marked):
//      the kept slice alone lexes as prose (the disease), the carried
//      opener restores the code token, and the closer-first-line case
//      yields an empty block plus honest prose — never an inverted flip;
//   §4 the parity control: text and truncated are byte-identical to the
//      pre-carry outputs (the standing parity oracle is untouched).
//
//  Run: ~/.bun/bin/bun run scripts/streaming/prove-tail-fence-carry.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)
const j = (v: unknown): string => JSON.stringify(v)

const tail = await import(join(ROOT, 'src/components/LiveStreamingTail.tsx'))
const { boundTailForInline, openFenceOf } = tail as {
  boundTailForInline: (text: string, rows: number, columns: number) => { text: string; truncated: boolean; openFence?: string | null }
  openFenceOf: (prefix: string) => string | null
}
const { marked } = await import('marked')

section('§1 the fence ledger over a discarded prefix')
{
  check('an unclosed backtick fence stands, info string kept', openFenceOf('prose\n```ts\nconst a = 1') === '```ts')
  check('a closed pair stands down', openFenceOf('```ts\ncode\n```\nprose') === null)
  check('an unclosed tilde fence stands', openFenceOf('~~~python\nx = 1') === '~~~python')
  check('a longer closer closes a shorter opener', openFenceOf('```\ncode\n`````\n') === null)
  check('a SHORTER run does not close', openFenceOf('````\ncode\n```\n') === '````')
  check('a backtick info string containing a backtick is not an opener', openFenceOf('``` a`b\ntext') === null)
  check('a fence-looking line inside an open block is content, never a nested opener', openFenceOf('```\n~~~\nstill code') === '```')
  check('a closer with trailing spaces closes', openFenceOf('```js\ncode\n```   \nprose') === null)
  check('an opener indented up to three spaces counts, indent dropped in the carry', openFenceOf('   ```rb\ncode') === '```rb')
  check('no fence, no carry', openFenceOf('# heading\n- item\nplain') === null)
}

section('§2 the bound returns the standing opener beside the untouched slice')
{
  // rows=10 → capRows=4: a fenced block tall enough that the opener is cut.
  const lines = ['intro prose', '```ts', ...Array.from({ length: 12 }, (_, i) => `const v${i} = ${i} // #${i}`), '- not a bullet', '# not a heading']
  const text = lines.join('\n')
  const out = boundTailForInline(text, 10, 84)
  check('the window truncates (fixture geometry)', out.truncated === true)
  check('THE DEFECT PIN: the standing opener rides out with the cut', out.openFence === '```ts', j({ openFence: out.openFence }))
  check('the kept text itself is the byte-identical raw slice (no splice into the text)', text.endsWith(out.text) && !out.text.includes('```'), j(out.text.slice(0, 40)))
  const whole = boundTailForInline('short\ntext', 40, 84)
  check('an untruncated tail carries no fence', whole.truncated === false && whole.openFence === null)
  const cutPastClose = boundTailForInline(['```js', 'code', '```', ...Array.from({ length: 12 }, (_, i) => `prose line ${i}`)].join('\n'), 10, 84)
  check('a cut AFTER the block closed carries nothing', cutPastClose.truncated === true && cutPastClose.openFence === null, j(cutPastClose.openFence))
}

section('§3 the dress, through the renderer’s own lexer')
{
  const lines = ['```ts', ...Array.from({ length: 12 }, (_, i) => `# line_${i}`)]
  const text = lines.join('\n')
  const out = boundTailForInline(text, 10, 84)
  check('fixture: cut inside the fence', out.truncated === true && out.openFence === '```ts')
  const bare = marked.lexer(out.text)
  check('CONTROL (the disease): the kept slice ALONE lexes as prose — headings where code streamed', bare.some(t => t.type === 'heading'), j(bare.map(t => t.type)))
  const dressed = marked.lexer(`${out.openFence}\n${out.text}`)
  check('the carried opener restores the code dress: ONE code token, zero headings', dressed.length === 1 && dressed[0]!.type === 'code' && (dressed[0] as { lang?: string }).lang === 'ts', j(dressed.map(t => t.type)))
  // The closer-first-line case: pre-fix the remainder flipped INTO a code
  // block; carried, the closer closes an empty block and prose is prose.
  // capRows = 4 at rows=10: exactly three lines after the closer puts the
  // closer itself at the kept window's head.
  const closerFirst = ['```js', ...Array.from({ length: 8 }, (_, i) => `code_${i}`), '```', '# real heading', 'plain prose', 'more prose']
  const cf = boundTailForInline(closerFirst.join('\n'), 10, 84)
  check('fixture: the closer is the first kept line', cf.truncated === true && cf.text.startsWith('```') && cf.openFence === '```js', j({ head: cf.text.split('\n')[0], fence: cf.openFence }))
  const cfBare = marked.lexer(cf.text)
  check('CONTROL (the inverted flip): alone, the remainder lexes INTO a code block', cfBare.some(t => t.type === 'code'), j(cfBare.map(t => t.type)))
  const cfDressed = marked.lexer(`${cf.openFence}\n${cf.text}`)
  check('carried, the heading is a heading again and no prose is imprisoned in code', cfDressed.some(t => t.type === 'heading') && !cfDressed.some(t => t.type === 'code' && ((t as { text?: string }).text ?? '').includes('real heading')), j(cfDressed.map(t => t.type)))
}

section('§4 the parity control — the kept text is untouched by the carry')
{
  const rand = ((): (() => number) => {
    let s = 0x5eed2
    return () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff
      return s / 0x7fffffff
    }
  })()
  let identical = 0
  for (let i = 0; i < 500; i++) {
    const n = 5 + Math.floor(rand() * 40)
    const lines = Array.from({ length: n }, (_, k) => (rand() < 0.15 ? '```' : `line ${k} ${'x'.repeat(Math.floor(rand() * 90))}`))
    const text = lines.join('\n')
    const out = boundTailForInline(text, 8 + Math.floor(rand() * 10), 60 + Math.floor(rand() * 60))
    const raw = out.truncated ? text.slice(text.length - out.text.length) : text
    if (out.text === raw) identical++
  }
  check('500 random tails: the kept text is always a raw suffix of the input', identical === 500, `${identical}/500`)
  const component = readFileSync(join(ROOT, 'src/components/LiveStreamingTail.tsx'), 'utf8')
  check('the renderer prepends the carried opener (the component consumes openFence)', component.includes('`${bounded.openFence}\\n${bounded.text}`'))
}

console.log(failures === 0 ? '\nprove-tail-fence-carry: ALL LAWS HOLD' : `\nprove-tail-fence-carry: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
