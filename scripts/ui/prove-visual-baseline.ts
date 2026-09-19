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

  const hintMac = 'shift + ↵ for a new line · ⇧← concourse'.padEnd(120)
  const hintLinux = 'shift + ↵ for a new line · shift+← concourse'.padEnd(120)
  const countsMac = '1 session on · 0 monitors here · 0 agents here' + ' '.repeat(23) + '⇧← concourse'
  const countsLinux = '1 session on · 0 monitors here · 0 agents here' + ' '.repeat(18) + 'shift+← concourse'
  const concourseSame = rowOf(hintMac, DEFAULT_MASKS) === rowOf(hintLinux, DEFAULT_MASKS) && rowOf(countsMac, DEFAULT_MASKS) === rowOf(countsLinux, DEFAULT_MASKS)
  const concourseKeepsWords = rowOf(hintLinux, DEFAULT_MASKS).startsWith('shift + ↵ for a new line ·') && rowOf(countsLinux, DEFAULT_MASKS).startsWith('1 session on · 0 monitors here · 0 agents here')
  console.log(`  [${concourseSame && concourseKeepsWords ? 'PASS' : 'FAIL'}] the composer hint row and the compact count row canonicalize across the concourse hint's host spellings (⇧← · shift+←) and keep their words — ${JSON.stringify(rowOf(hintLinux, DEFAULT_MASKS))} · ${JSON.stringify(rowOf(countsLinux, DEFAULT_MASKS))}`)
  if (!(concourseSame && concourseKeepsWords)) fail = 1
  const withoutConcourseMask = DEFAULT_MASKS.filter(m => !m.includes('← concourse'))
  const concourseDiverged = rowOf(hintMac, withoutConcourseMask) !== rowOf(hintLinux, withoutConcourseMask)
  console.log(`  [${concourseDiverged ? 'PASS' : 'FAIL'}] without the concourse hint's mask the two hosts diverge on that row (no mask read the composer's hint) — the reason the old vocabulary was false`)
  if (!concourseDiverged) fail = 1

  const bandHere = '✶ Mercury · ● ready · Opus 5 · effort high · ctx — · tree ⌥…'
  const bandThere = '✶ Mercury · ● ready · Opus 5 · effort high · ctx — · mercur…'
  const bandHosted = '✶ Mercury · ● ready · Opus 5 · effort high · ctx — · PreRel…'
  const bandSame = rowOf(bandHere, DEFAULT_MASKS) === rowOf(bandThere, DEFAULT_MASKS) && rowOf(bandThere, DEFAULT_MASKS) === rowOf(bandHosted, DEFAULT_MASKS)
  const bandKeepsWords = rowOf(bandThere, DEFAULT_MASKS).startsWith('✶ Mercury · ● ready · Opus 5 · effort high · ctx — ·')
  const chipRowsStillMasked = rowOf('  ▀▀▀▀▀▀▀▀▀   tree ⌥ HEAD · ⤳2', DEFAULT_MASKS) === '⟪row⟫' && rowOf('  ▀▀▀▀▀▀▀▀▀   a-much-longer-checkout-name ⌥lane/x · ⤳2', DEFAULT_MASKS) === '⟪row⟫'
  const railCtxUntouched = rowOf('  · ctx — · 1000k       │', DEFAULT_MASKS) === '  · ctx — · 1000k       │'
  console.log(`  [${bandSame && bandKeepsWords && chipRowsStillMasked && railCtxUntouched ? 'PASS' : 'FAIL'}] the compact band's checkout chip canonicalizes across checkout names cut before the branch glyph, the band's words kept, the wide chip rows still row-masked and the rail's ctx row untouched — ${JSON.stringify(rowOf(bandThere, DEFAULT_MASKS))}`)
  if (!(bandSame && bandKeepsWords && chipRowsStillMasked && railCtxUntouched)) fail = 1
  const glyphOnly = ['row:\\S+ ⌥ ?\\S+']
  const bandDiverged = rowOf(bandHere, glyphOnly) !== rowOf(bandThere, glyphOnly)
  console.log(`  [${bandDiverged ? 'PASS' : 'FAIL'}] keyed on the branch glyph alone the two checkouts diverge on that row (the glyph is cut with the name at 60 columns) — the reason the old vocabulary was false`)
  if (!bandDiverged) fail = 1
}

{
  const { DEFAULT_MASKS, neutralizeGrid } = await import('./visualBaseline.ts')
  const { compactWorkSummaryText } = await import('../../src/components/tasks/useFocusedWork.ts')
  const { stringWidth } = await import('../../src/ink/stringWidth.ts')
  const counts = { sessionsOn: 1, monitorsHere: 0, agentsHere: 0, samples: 0 }
  const countRow = (columns: number, hint: string): string => {
    const words = compactWorkSummaryText(counts, Math.max(0, columns - (stringWidth(hint) + 1)))
    return `${words.padEnd(columns - stringWidth(hint) - 1)} ${hint}`
  }
  const oneRow = (text: string) => ({ schema: 1, cols: text.length, rows: 1, text: [text], styles: [[]] })
  const canon = (text: string, masks: string[]): string => neutralizeGrid(oneRow(text), masks).text[0]
  const mac60 = countRow(60, '⇧← concourse')
  const linux60 = countRow(60, 'shift+← concourse')
  const mac80 = countRow(80, '⇧← concourse')
  const linux80 = countRow(80, 'shift+← concourse')
  const squeezed = mac60.startsWith('1 session on · 0 monitors here · 0 agents here') && linux60.startsWith('S:1 · M:0 · A:0')
  console.log(`  [${squeezed ? 'PASS' : 'FAIL'}] at 60 columns the count row keeps its words under the glyph and drops to its short form under the spelled hint (the product's own budget) — ${JSON.stringify([mac60.trim(), linux60.trim()])}`)
  if (!squeezed) fail = 1
  const rowMasked = canon(mac60, DEFAULT_MASKS) === canon(linux60, DEFAULT_MASKS) && canon(mac60, DEFAULT_MASKS) === '⟪row⟫'
  console.log(`  [${rowMasked ? 'PASS' : 'FAIL'}] the squeezed count row canonicalizes across the hosts as one row`)
  if (!rowMasked) fail = 1
  const wide = canon(mac80, DEFAULT_MASKS)
  const wideKept = wide === canon(linux80, DEFAULT_MASKS) && wide.includes('1 session on · 0 monitors here · 0 agents here') && !wide.includes('concourse')
  console.log(`  [${wideKept ? 'PASS' : 'FAIL'}] at 80 columns the count row keeps its words on both hosts and only the hint is masked — ${wide.trim()}`)
  if (!wideKept) fail = 1
  const withoutRowMask = DEFAULT_MASKS.filter(m => !m.includes('sessions? on'))
  const diverged = canon(mac60, withoutRowMask) !== canon(linux60, withoutRowMask)
  console.log(`  [${diverged ? 'PASS' : 'FAIL'}] without the count row's mask the two hosts diverge at 60 columns (the hint's span mask cannot restore the words the spelling squeezed) — the reason the old vocabulary was false`)
  if (!diverged) fail = 1
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
