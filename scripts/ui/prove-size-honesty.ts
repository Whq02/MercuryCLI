#!/usr/bin/env bun
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }


let failures = 0
let sectionFix = ''
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}${!cond && sectionFix ? ` — fix: ${sectionFix}` : ''}`)
}

console.log('§1 C1 — the footer transient is one row by fold')
{
  sectionFix = 'change footerNoticeLine in src/screen/composer/Notifications.tsx'
  const { footerNoticeLine } = await import('../../src/screen/composer/Notifications.tsx')
  check('newlines fold to the seam', footerNoticeLine('hook said\nline two\nline three') === 'hook said · line two · line three')
  check('CRLF and blank runs fold clean', footerNoticeLine('a\r\n\r\n  b  \n\nc') === 'a · b · c')
  check('a one-line notice is untouched', footerNoticeLine('plain notice') === 'plain notice')
  check('the fold never mints a newline', !footerNoticeLine('x\ny\nz').includes('\n'))
}

console.log('§2 C2 — the footer right cell holds a budget and keeps its tail')
{
  sectionFix = 'change the status cell of TranscriptFooter in src/screen/chat/useChatSearch.tsx (its width budget, the floor of 16, and the truncation from the start)'
  const React = await import('react')
  const { mountPart } = await import('./chatScenarios.ts')
  const { waitFor } = await import('../lib/settingsPopupHarness.ts')
  const { TranscriptFooter } = await import('../../src/screen/chat/useChatSearch.tsx')
  const status = 'written to /a/long/way/down/the/tree/of/folders/mercury-transcript-1234567890.md — set $EDITOR to open it'
  const props = { toggleChord: 'ctrl+o', expandChord: 'ctrl+e', hasSearchBadge: false, virtualScroll: true, showAllSuppressed: false, showAll: false, status, badge: null }
  const rowAt = async (columns: number): Promise<{ row: string; rows: number }> => {
    const footer = await mountPart(() => props, { columns, rows: 4, draw: value => React.createElement(TranscriptFooter, value) })
    await waitFor(() => footer.view.lines().some(line => line.includes('open it')), 3000)
    const painted = footer.view.lines().filter(line => line.trim() !== '' && !/^─+$/.test(line.trim()))
    footer.unmount()
    return { row: painted.find(line => line.includes('open it')) ?? painted.join('|'), rows: painted.length }
  }
  const wide = await rowAt(60)
  const tight = await rowAt(30)
  const cellOf = (row: string): string => row.slice(row.lastIndexOf('…'))
  check(
    'the budget exists and floors at 16',
    cellOf(wide.row).length === 28 && cellOf(tight.row).length === 16,
    `${cellOf(wide.row).length} columns at 60, ${cellOf(tight.row).length} at 30`,
  )
  check('the cell is width-bound and truncates from the START', wide.row.endsWith('set $EDITOR to open it') && tight.row.endsWith('open it') && cellOf(wide.row).startsWith('…') && cellOf(tight.row).startsWith('…'), `${JSON.stringify(wide.row)} · ${JSON.stringify(tight.row)}`)
  check('the left pack budgets against the CAPPED width', wide.row.length <= 60 && tight.row.length <= 30 && wide.rows === 1 && tight.rows === 1 && wide.row.startsWith(' detailed transcript'), `${JSON.stringify(wide.row)} · ${JSON.stringify(tight.row)}`)
  check('the unbudgeted paint is gone', !wide.row.includes('written to /a/long') && !tight.row.includes('written to'), `${JSON.stringify(wide.row)} · ${JSON.stringify(tight.row)}`)
}


console.log('§5 C6 — the tool header is one row by fold, both shells')
{
  sectionFix = 'change oneLineCommandDisplay or TOOL_USE_LINE_MAX_CHARS in src/tools/kit/commandDisplay.ts'
  const { oneLineCommandDisplay, TOOL_USE_LINE_MAX_CHARS } = await import('../../src/tools/kit/commandDisplay.ts')
  check('a two-line command folds to the marker', oneLineCommandDisplay('Get-Item a\nGet-Item b') === 'Get-Item a ↵ Get-Item b')
  check('no output ever carries a newline', !oneLineCommandDisplay('a\nb\nc\nd\ne').includes('\n'))
  check('a one-liner is untouched', oneLineCommandDisplay('echo hello') === 'echo hello')
  const long = 'x'.repeat(TOOL_USE_LINE_MAX_CHARS + 40)
  check('the cap cuts with an ellipsis at the cap', oneLineCommandDisplay(long).length === TOOL_USE_LINE_MAX_CHARS + 1 && oneLineCommandDisplay(long).endsWith('…'))
  check('a fold under the cap earns no ellipsis (the marker carries the truth)', !oneLineCommandDisplay('a\nb').includes('…'))
}

console.log('§6 — the consent command is height-bound and names its cut')
{
  sectionFix = 'change boundLines, consentBodyBudget or consentContentWidth in src/permissions/cards/consentBodyBudget.ts'
  const { boundLines, consentBodyBudget, consentContentWidth, CONSENT_BODY_MIN_ROWS } = await import('../../src/permissions/cards/consentBodyBudget.ts')
  check('the budget floors and follows the terminal', consentBodyBudget(12) === CONSENT_BODY_MIN_ROWS && consentBodyBudget(40) > consentBodyBudget(30))
  const width = consentContentWidth(100)
  const short = boundLines('ls -la\npwd'.split('\n'), width, consentBodyBudget(30))
  check('a short command is whole with nothing hidden', short.lines.join('\n') === 'ls -la\npwd' && short.hiddenLines === 0)
  const heredoc = Array.from({ length: 60 }, (_, i) => `line ${i}`)
  const bounded = boundLines(heredoc, width, consentBodyBudget(30))
  check('a 60-line heredoc at 30 rows is cut with the hidden count named', bounded.hiddenLines === 60 - bounded.lines.length && bounded.hiddenLines > 0)
  check('the kept lines fit the row budget', bounded.lines.length <= consentBodyBudget(30))
  const wrapped = boundLines(['x'.repeat(2000), 'second'], consentContentWidth(80), consentBodyBudget(24))
  check('a monster one-liner keeps a head sized to the budget and counts the rest', wrapped.lines[0]!.endsWith('…') && wrapped.hiddenLines === 2)
  const cjk = boundLines(Array.from({ length: 30 }, () => '漢'.repeat(60)), consentContentWidth(80), consentBodyBudget(24))
  check('wrapped-row accounting rides the width oracle (CJK rows cost double)', cjk.lines.length <= Math.ceil(consentBodyBudget(24) / 2) + 1)
}

console.log('§7 C7+C8 — the picker row measures in cells and its metadata line is cut')
{
  sectionFix = 'change truncateToWidth in src/platform/text/truncate.ts (it must count terminal cells, not characters)'
  const { truncateToWidth } = await import('../../src/platform/text/truncate.ts')
  check('the owner is width-true on wide glyphs (10 CJK cells cut to ≤8+ellipsis)', truncateToWidth('漢漢漢漢漢', 9).length <= 5 && truncateToWidth('漢漢漢漢漢', 9).endsWith('…'))
}

console.log('§8 C9 — AGE right-aligns under its header; the filter echo is bounded')
{
  sectionFix = 'change padStartTo or padTo in src/screen/theme/glyphs.ts'
  const { padStartTo, padTo } = await import('../../src/screen/theme/glyphs.ts')
  check('padStartTo fills from the left', padStartTo('3m', 5) === '   3m' && padTo('3m', 5) === '3m   ')
  check('padStartTo truncates width-true past the cell', padStartTo('longest', 5).length <= 5)
  check('a full cell is identity', padStartTo('waits', 5) === 'waits')
}


console.log('§10 C11 — an over-wide rail token truncates, never vanishes')
{
  sectionFix = 'change wrapRailRows in src/screen/fullscreen-layout/HelmLanesRail.tsx'
  const { wrapRailRows } = await import('../../src/screen/fullscreen-layout/HelmLanesRail.tsx')
  const path = 'C:\\Users\\OPERATOR\\AppData\\Local\\mercury\\transcripts\\deep\\file.txt'
  const rows = wrapRailRows(`writing ${path} now`, 20, 4)
  check('the over-wide token keeps a truncated row of its own', rows.some(r => r.includes('C:\\Users')), rows.join(' | '))
  check('its neighbours survive around it', rows[0] === 'writing' && rows.some(r => r === 'now'))
  check('ordinary wrapping is unchanged', wrapRailRows('one two three', 9, 3).join('|') === 'one two|three')
  check('the row cap still ends with the honest ellipsis', wrapRailRows('a b c d e f g h', 3, 2)[1]!.endsWith('…'))
  check('every produced row fits the rail', wrapRailRows(`x ${path} y`, 14, 5).every(r => r.length <= 14))
}



console.log('§14 E2 — sliceAnsi never exceeds its bound by the oracle’s measure')
{
  sectionFix = 'change sliceAnsi in src/platform/text/sliceAnsi.ts (a slice must never measure wider than its bound by stringWidth in src/screen/renderer/stringWidth.ts)'
  const sliceAnsi = (await import('../../src/platform/text/sliceAnsi.ts')).default
  const { stringWidth } = await import('../../src/screen/renderer/stringWidth.ts')
  const samples = ['✳️✳️✳️', 'a👍🏽b👨‍💻c', '\x1b[31m✳️red\x1b[39m tail', '🇺🇸🇺🇸']
  let sound = true
  for (const s of samples) {
    for (let bound = 0; bound <= stringWidth(s) + 2; bound++) {
      if (stringWidth(sliceAnsi(s, 0, bound)) > bound) sound = false
    }
  }
  check('every slice of every sample fits its bound (VS16, skin tones, ZWJ, flags, styled)', sound)
  check('a cluster is never split (the 3-cell slice of three width-2 emoji is ONE emoji)', sliceAnsi('✳️✳️✳️', 0, 3) === '✳️')
}


console.log(failures === 0 ? '\nsize-honesty: GREEN' : `\nsize-honesty: ${failures} RED`)
process.exit(failures === 0 ? 0 : 1)
