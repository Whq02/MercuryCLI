#!/usr/bin/env bun
// ============================================================================
//  scripts/helm-console/prove-console-text.ts
//  PROOF: the console's pure text shaping (utils/cockpit/helmConsoleText.ts):
//    · wrapPlain — every emitted line fits the display-width budget (incl.
//      CJK double-width and hard-broken long words), paragraphs survive;
//    · plainifyAnswer — fences drop but their content survives; emphasis/
//      inline-code/links unwrap; bullets → the dot glyph; never invents text;
//    · consoleInputWindow — the cursor is ALWAYS visible: head clips with an
//      ellipsis, a few post-cursor cells survive, budget honored;
//    · fmtTok — compact token formatting at the boundaries.
//  Width math must DELEGATE to the SOT (glyphs.ts) — asserted structurally.
//  Run:  ~/.bun/bin/bun run scripts/helm-console/prove-console-text.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { displayWidth } from '../../src/components/mercury-ui/glyphs.js'
import {
  consoleInputWindow,
  fmtTok,
  plainifyAnswer,
  wrapPlain,
} from '../../src/utils/cockpit/helmConsoleText.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' helm console text shaping — wrap · plainify · window · fmt')
console.log('============================================================')

section('wrapPlain — width honesty')
const w = 21
const lines = wrapPlain(
  'The quick brown fox jumps over the lazy dog and keeps going for a while longer.',
  w,
)
check('every line ≤ budget', lines.every(l => displayWidth(l) <= w), lines.map(l => displayWidth(l)).join(','))
check('no content lost', lines.join(' ').replace(/\s+/g, ' ') === 'The quick brown fox jumps over the lazy dog and keeps going for a while longer.')
const cjk = wrapPlain('漢字がたくさん並んでいる行はセルの幅で折り返す必要がある', 10)
check('CJK wraps by cell width', cjk.every(l => displayWidth(l) <= 10), cjk.map(l => displayWidth(l)).join(','))
const longWord = wrapPlain('averyveryverylongunbrokenidentifier_that_keeps_going', 12)
check('long word hard-breaks within budget', longWord.every(l => displayWidth(l) <= 12))
check('hard-broken word reassembles', longWord.join('') === 'averyveryverylongunbrokenidentifier_that_keeps_going')
const paras = wrapPlain('one\n\ntwo', 10)
check('paragraph break survives as a blank line', paras.length === 3 && paras[1] === '')

section('plainifyAnswer — conservative markdown unwrap')
const md = [
  '# Heading',
  '',
  'Some **bold** and *italic* and `code` and a [link](https://x.y).',
  '',
  '- first',
  '- second',
  '',
  '```ts',
  'const x = 1',
  '```',
  '> quoted',
].join('\n')
const plain = plainifyAnswer(md)
check('heading marker dropped', plain.startsWith('Heading'))
check('bold unwrapped', plain.includes('Some bold and italic and code'))
check('link → label', plain.includes('a link.') && !plain.includes('https://x.y'))
check('bullets → dot glyph', plain.includes('· first') && plain.includes('· second'))
check('fence markers dropped, content kept', plain.includes('const x = 1') && !plain.includes('```'))
check('blockquote marker dropped', plain.includes('quoted') && !plain.includes('> quoted'))

section('consoleInputWindow — cursor always visible')
const short = consoleInputWindow('hello', 5, 20)
check('short line intact', short.pre === 'hello' && short.post === '' && !short.headClipped)
const long = 'abcdefghijklmnopqrstuvwxyz0123456789'
const win = consoleInputWindow(long, long.length, 15)
check('head clips with ellipsis', win.headClipped && win.pre.startsWith('…'))
check('pre + cursor fits budget', displayWidth(win.pre) + 1 <= 15, `preW=${displayWidth(win.pre)}`)
const mid = consoleInputWindow(long, 10, 15)
check('mid-cursor keeps post context', mid.post.length > 0 && mid.post.startsWith('k'))
check('mid-cursor window fits', displayWidth(mid.pre) + 1 + displayWidth(mid.post) <= 15)
const zero = consoleInputWindow(long, 0, 15)
check('cursor at 0 shows the head', zero.pre === '' && zero.post.startsWith('a') && zero.tailClipped)

section('fmtTok — boundaries')
check('999 → 999', fmtTok(999) === '999')
check('1000 → 1k', fmtTok(1000) === '1k')
check('1500 → 1.5k', fmtTok(1500) === '1.5k')
check('9999 → 10k', fmtTok(9999) === '10k')
check('41234 → 41k', fmtTok(41234) === '41k')
check('1.2m', fmtTok(1_200_000) === '1.2m')
check('negative/NaN → 0', fmtTok(-5) === '0' && fmtTok(Number.NaN) === '0')

section('width-oracle delegation (structural)')
const src = readFileSync('src/utils/cockpit/helmConsoleText.ts', 'utf8')
check('imports the glyphs facade', src.includes("from '../../components/mercury-ui/glyphs.js'"))
check('defines no width primitive of its own', !/function\s+(charWidth|displayWidth|stringWidth)\s*\(/.test(src))

console.log('')
if (failures > 0) {
  console.log(`❌ prove-console-text: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('✅ prove-console-text: ALL GREEN')
