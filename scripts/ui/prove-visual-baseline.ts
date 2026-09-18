#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawnSync } from 'node:child_process'

const FULL = process.env.UI_RENDER === '1'
const SPOTS = [
  'frame--120x40--light--truecolor--full',
  'frame--120x40--light-daltonized--truecolor--full',
  'frame--120x40--dark--ansi--full',
]

let fail = 0

{
  const { DEFAULT_MASKS, neutralizeGrid } = await import('./visualBaseline.ts')
  const oneRow = (text: string) => ({ schema: 1, cols: text.length, rows: 1, text: [text], styles: [[]] })
  const here = '◐ first task · mercury · ready' + ' '.repeat(82) + '⇧← back '
  const there = '◐ first task · a-much-longer-checkout-name · ready' + ' '.repeat(60) + '⇧← back '
  const same =
    neutralizeGrid(oneRow(here), DEFAULT_MASKS).text[0] === neutralizeGrid(oneRow(there), DEFAULT_MASKS).text[0]
  console.log(`  [${same ? 'PASS' : 'FAIL'}] the session tag bar canonicalizes across checkout basenames`)
  if (!same) fail = 1
  const composer = '│❯ Type a prompt, start a slash command, or Tab to focus the rails' + ' '.repeat(52) + '│'
  const kept = neutralizeGrid(oneRow(composer), DEFAULT_MASKS).text[0] === composer
  console.log(`  [${kept ? 'PASS' : 'FAIL'}] the composer row is not a tag-bar row (no mask fires)`)
  if (!kept) fail = 1

  const { canonicalizeCheckoutRows } = await import('./visualBaseline.ts')
  const band = '│ ▚▛▀▜▞ │ Opus 5 · ● high │ some-worktree ⌥fix/some-lane │ ⤳2' + ' '.repeat(56) + '│'
  const tag = '◐ first task · some-worktree · ready' + ' '.repeat(76) + '⇧← back '
  const grid = { schema: 1, cols: band.length, rows: 2, text: [band, tag], styles: [[], []] }
  const canon = canonicalizeCheckoutRows(grid, { basename: 'some-worktree', branch: 'fix/some-lane' })
  const spelled =
    canon.text[0].includes('│ mercury ⌥main │ ⤳2') && canon.text[1].startsWith('◐ first task · mercury · ready  ')
  const widths = canon.text[0].length === band.length && canon.text[1].length === tag.length
  const named = !canon.text.some(r => r.includes('some-worktree') || r.includes('some-lane'))
  console.log(`  [${spelled && widths && named ? 'PASS' : 'FAIL'}] the checkout rows store one fixed spelling at the captured width`)
  if (!(spelled && widths && named)) fail = 1
  const tight = { schema: 1, cols: 30, rows: 1, text: ['◐ t · m · ready' + ' '.repeat(7) + '⇧← back '], styles: [[]] }
  const left = canonicalizeCheckoutRows(tight, { basename: 'm', branch: 'x' }).text[0] === tight.text[0]
  console.log(`  [${left ? 'PASS' : 'FAIL'}] a name the fixed spelling would not fit is left as captured`)
  if (!left) fail = 1
  const bandNow = '│ ▚▛▀▜▞ │ Opus 5 · ● high │ some-worktree ⌥ fix/some-lane │ ⤳2' + ' '.repeat(55) + '│'
  const tagNow = ' some-worktree · ready' + ' '.repeat(90) + '⇧← back '
  const canonNow = canonicalizeCheckoutRows({ schema: 1, cols: bandNow.length, rows: 2, text: [bandNow, tagNow], styles: [[], []] }, { basename: 'some-worktree', branch: 'fix/some-lane' })
  const nowOk =
    canonNow.text[0].includes('│ mercury ⌥ main │ ⤳2') &&
    canonNow.text[1].startsWith(' mercury · ready  ') &&
    canonNow.text[0].length === bandNow.length &&
    canonNow.text[1].length === tagNow.length &&
    !canonNow.text.some(r => r.includes('some-worktree') || r.includes('some-lane'))
  console.log(`  [${nowOk ? 'PASS' : 'FAIL'}] the checkout rows as painted today (a space after ⌥, the tag bar leading with the checkout) store the fixed spelling too`)
  if (!nowOk) fail = 1
  const tagThere = ' a-much-longer-checkout-name · ready' + ' '.repeat(76) + '⇧← back '
  const sameNow = neutralizeGrid(oneRow(tagNow), DEFAULT_MASKS).text[0] === neutralizeGrid(oneRow(tagThere), DEFAULT_MASKS).text[0]
  console.log(`  [${sameNow ? 'PASS' : 'FAIL'}] the session tag bar as painted today canonicalizes across checkout basenames`)
  if (!sameNow) fail = 1

  const cardMac = '│ ⊞ SESSIONS › │  ▣ this session  │  ▢ first task   ⌥←→ flip · /sessions' + ' '.repeat(47) + '│'
  const cardLinux = '│ ⊞ SESSIONS › │  ▣ this session  │  ▢ first task   alt+←→ flip · /sessions' + ' '.repeat(44) + '│'
  const cardSame = neutralizeGrid(oneRow(cardMac), DEFAULT_MASKS).text[0] === neutralizeGrid(oneRow(cardLinux), DEFAULT_MASKS).text[0]
  const cardKeepsTabs = neutralizeGrid(oneRow(cardMac), DEFAULT_MASKS).text[0].includes('▣ this session  │  ▢ first task')
  console.log(`  [${cardSame && cardKeepsTabs ? 'PASS' : 'FAIL'}] the SESSIONS card row canonicalizes across the flip hint's host spellings (⌥←→ · alt+←→) and keeps its tabs — ${JSON.stringify(neutralizeGrid(oneRow(cardLinux), DEFAULT_MASKS).text[0])}`)
  if (!(cardSame && cardKeepsTabs)) fail = 1
  const withoutHintMask = DEFAULT_MASKS.filter(m => !m.includes('←→ flip'))
  const oldVocabularyDiverged = neutralizeGrid(oneRow(cardMac), withoutHintMask).text[0] !== neutralizeGrid(oneRow(cardLinux), withoutHintMask).text[0]
  console.log(`  [${oldVocabularyDiverged ? 'PASS' : 'FAIL'}] without the hint's mask the two hosts diverge on that row (the branch mask ate the Mac glyph alone) — the reason the old vocabulary was false`)
  if (!oldVocabularyDiverged) fail = 1

  const tagMac = ' mercury · ready' + ' '.repeat(96) + '⇧← back '
  const tagLinux = ' mercury · ready' + ' '.repeat(92) + 'shift+← back '
  const taskMac = '◐ first task · mercury · ready' + ' '.repeat(82) + '⇧← back '
  const taskLinux = '◐ first task · mercury · ready' + ' '.repeat(78) + 'shift+← back '
  const rowOf = (text: string, masks: string[]) => neutralizeGrid(oneRow(text), masks).text[0]
  const backSame = rowOf(tagMac, DEFAULT_MASKS) === rowOf(tagLinux, DEFAULT_MASKS) && rowOf(taskMac, DEFAULT_MASKS) === rowOf(taskLinux, DEFAULT_MASKS)
  console.log(`  [${backSame ? 'PASS' : 'FAIL'}] the session tag bar canonicalizes across the back hint's host spellings (⇧← back · shift+← back) in both of its shapes — ${JSON.stringify(rowOf(tagLinux, DEFAULT_MASKS))} · ${JSON.stringify(rowOf(taskLinux, DEFAULT_MASKS))}`)
  if (!backSame) fail = 1
  const withoutBackMask = DEFAULT_MASKS.filter(m => !m.includes('← back'))
  const backDiverged = rowOf(tagMac, withoutBackMask) !== rowOf(tagLinux, withoutBackMask)
  console.log(`  [${backDiverged ? 'PASS' : 'FAIL'}] without the back hint's mask the two hosts diverge on that row (the one-spelling mask left the Linux row raw) — the reason the old vocabulary was false`)
  if (!backDiverged) fail = 1
}

const run = (only?: string): void => {
  const args = ['run', 'scripts/ui/generate-visual-baseline.ts', '--check']
  if (only) args.push('--only', only)
  const r = spawnSync(process.env.BUN ?? `${process.env.HOME}/.bun/bin/bun`, args, {
    encoding: 'utf8',
    timeout: FULL ? 1_800_000 : 300_000,
  })
  const tail = (r.stdout + r.stderr).split('\n').filter(Boolean).slice(-3).join(' · ')
  const ok = r.status === 0
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] baseline check ${only ?? 'FULL MATRIX'} — ${tail}`)
  if (!ok) fail = 1
}

console.log('visual baseline — the committed grids match the live product')
if (FULL) {
  run()
} else {
  for (const id of SPOTS) run(id)
}

if (fail) {
  console.log('❌ visual-baseline comparison RED')
  process.exit(1)
}
console.log('✅ visual-baseline comparison green')
