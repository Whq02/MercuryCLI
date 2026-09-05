#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(72) + '\n' + t)
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

const owner = await import('../../src/components/permissions/consentBodyBudget.ts')
const { stringWidth } = await import('../../src/ink/stringWidth.ts')
const {
  CONSENT_BODY_MIN_ROWS,
  CONSENT_CHROME_ROWS,
  boundHunks,
  boundLines,
  consentBodyBudget,
  consentContentWidth,
  cutToRows,
  diffPaintWidth,
  filePaintWidth,
  paintedRows,
  totalHunkRows,
  totalLineRows,
} = owner

section('§1 the owner — painted rows, the floor, the measured chrome')
{
  check('the chrome reserve is the measured one (19 rows around an Edit card body, the tail row, one row of spread)', CONSENT_CHROME_ROWS === 21)
  check('the budget is the viewport minus the chrome', consentBodyBudget(40) === 40 - CONSENT_CHROME_ROWS && consentBodyBudget(30) === 30 - CONSENT_CHROME_ROWS)
  check('the floor holds on a tiny pane', consentBodyBudget(8) === CONSENT_BODY_MIN_ROWS && consentBodyBudget(24) === CONSENT_BODY_MIN_ROWS)
  for (const columns of [80, 100, 120]) {
    const width = consentContentWidth(columns)
    check(`the content box at ${columns} columns is the width less the card's borders and paddings (${width})`, width === columns - 6)
    const line = 'w'.repeat(350)
    check(`a 350-character line at ${columns} columns paints ceil(350/${width}) rows`, paintedRows(line, width) === Math.ceil(350 / width))
  }
  check('an empty line paints one row', paintedRows('', 90) === 1)
  check('a wide-glyph line counts cells, not characters', paintedRows('漢'.repeat(60), 80) === 2)
  const single = boundLines(['x'.repeat(400)], 100, 3)
  check('a 400-column single line at a 3-row budget is torn mid-wrap with the cut mark', single.cut && single.lines.length === 1 && single.lines[0]!.endsWith('…') && stringWidth(single.lines[0]!) <= 300)
  check('…and the torn line counts among the hidden lines (never "+0")', single.hiddenLines === 1)
  const heredoc = Array.from({ length: 60 }, (_, i) => `line ${i}`)
  const cut = boundLines(heredoc, 90, consentBodyBudget(30))
  check('a 60-line heredoc at 30 rows keeps exactly the budget and names the rest', cut.lines.length === consentBodyBudget(30) && cut.hiddenLines === 60 - consentBodyBudget(30) && !cut.cut)
  const one = boundLines(['one line'], 90, consentBodyBudget(30))
  check('a one-line body paints whole', one.lines.length === 1 && one.hiddenLines === 0 && !one.cut)
  const whole = boundLines(heredoc, 90, null)
  check('a null budget (expanded / unbounded) paints every line', whole.lines.length === 60 && whole.hiddenLines === 0)
  const fits = boundLines(['a', 'b', 'c'], 90, 3)
  check('a body that fits exactly paints whole', fits.lines.length === 3 && fits.hiddenLines === 0)
  const mixed = boundLines(['short', 'x'.repeat(250), 'after'], 100, 3)
  check('the boundary line is torn at the rows left (short=1, then 2 rows of the long line)', mixed.lines.length === 2 && mixed.cut && stringWidth(mixed.lines[1]!) <= 200 && mixed.hiddenLines === 2)
  check('cutToRows keeps the whole line when it fits', cutToRows('abc', 10, 1) === 'abc')
  check('cutToRows tears to rows×width cells with the mark', cutToRows('x'.repeat(50), 10, 2) === 'x'.repeat(19) + '…')
  check('totalLineRows sums painted rows', totalLineRows(['x'.repeat(150), 'y'], 100) === 3)
}

section('§2 the hunk walk — torn boundary, separators, order')
{
  const hunk = (start: number, n: number, width = 5) => ({
    oldStart: start,
    oldLines: n,
    newStart: start,
    newLines: n,
    lines: Array.from({ length: n }, (_, i) => `+${String(start + i).padStart(2, '0')}${'w'.repeat(width)}`),
  })
  const hunks = [hunk(1, 10), hunk(50, 10), hunk(100, 10)]
  check('totalHunkRows counts every line and a separator per later hunk', totalHunkRows(hunks, 90) === 30 + 2)
  const walk = boundHunks(hunks, 90, 15)
  check('the walk keeps exactly the rows: 10 lines, a separator, 4 lines', walk.hunks.length === 2 && walk.hunks[0]!.lines.length === 10 && walk.hunks[1]!.lines.length === 4 && !walk.cut)
  check('…and names the hidden lines (16)', walk.hiddenLines === 16)
  const exact = boundHunks(hunks, 90, 32)
  check('an exact fit keeps every hunk object', exact.hunks.length === 3 && exact.hunks[0] === hunks[0] && exact.hiddenLines === 0)
  const wide = [hunk(1, 5, 350)]
  const torn = boundHunks(wide, 100, 9)
  check('a wide hunk is torn mid-wrap: two whole lines (8 rows) and one row of the third', torn.hunks[0]!.lines.length === 3 && torn.cut && torn.hunks[0]!.lines[2]!.startsWith('+') && torn.hunks[0]!.lines[2]!.endsWith('…'))
  check('…the torn line keeps its marker and counts among the hidden (3)', torn.hiddenLines === 3)
  check('a null budget keeps the whole list', boundHunks(wide, 100, null).hunks.length === 1 && boundHunks(wide, 100, null).hiddenLines === 0)
}

section('§3 the paint widths — the content box, the diff gutter, the file gutter')
{
  const hunk = (start: number, n: number) => ({ oldStart: start, oldLines: n, newStart: start, newLines: n, lines: Array.from({ length: n }, () => ' x') })
  check('the diff painter loses the gutter digits, two spaces and the marker column', diffPaintWidth(90, [hunk(1, 5)]) === 90 - 1 - 3)
  check('…the widest line number decides the digits (line 100 → three)', diffPaintWidth(90, [hunk(96, 5)]) === 90 - 3 - 3)
  check('…across hunks the widest wins', diffPaintWidth(90, [hunk(1, 5), hunk(120, 2)]) === 90 - 3 - 3)
  check('the paint width floors at one cell', diffPaintWidth(3, [hunk(1, 5)]) === 1)
  const fullscreen = process.env.MERCURY_FULLSCREEN
  process.env.MERCURY_FULLSCREEN = '1'
  check('the fullscreen file painter reserves the line-count digits and two spaces', filePaintWidth(90, 30) === 90 - 4)
  process.env.MERCURY_FULLSCREEN = '0'
  check('the inline file painter reserves nothing', filePaintWidth(90, 30) === 90)
  if (fullscreen === undefined) delete process.env.MERCURY_FULLSCREEN
  else process.env.MERCURY_FULLSCREEN = fullscreen
  check('the content box respects a card with no inner padding', consentContentWidth(100, 0) === 96)
}

section('§4 the wiring — every body-bearing card reads the one owner; the old owners are gone')
{
  check('the retired diff owner is gone', !existsSync(join(ROOT, 'src/components/permissions/boundedDiffPreview.ts')))
  check('the retired command owner is gone', !existsSync(join(ROOT, 'src/components/permissions/consentPreview.ts')))
  const readers: Array<[string, string[]]> = [
    ['src/components/FileEditToolDiff.tsx', ['boundHunks(', 'diffPaintWidth(']],
    ['src/components/permissions/ConsentFileEditDiff.tsx', ['consentBodyBudget(rows)', 'consentContentWidth(columns)']],
    ['src/components/permissions/FileWritePermissionRequest/FileWriteToolDiff.tsx', ['boundHunks(', 'boundLines(', 'diffPaintWidth(', 'filePaintWidth(', 'consentBodyBudget(rows)']],
    ['src/components/permissions/NotebookEditPermissionRequest/NotebookEditToolDiff.tsx', ['boundHunks(', 'boundLines(', 'diffPaintWidth(', 'filePaintWidth(', 'consentBodyBudget(rows)']],
    ['src/components/permissions/ChangeSetPermissionRequest/ChangeSetPermissionRequest.tsx', ['boundHunks(', 'diffPaintWidth(', 'consentBodyBudget(rows)', 'hiddenFiles']],
    ['src/components/permissions/ConsentBodyText.tsx', ['boundLines(', 'consentBodyBudget(rows)', 'consentContentWidth(columns)']],
    ['src/components/permissions/BashPermissionRequest/BashPermissionRequest.tsx', ['<ConsentBodyText']],
    ['src/components/permissions/PowerShellPermissionRequest/PowerShellPermissionRequest.tsx', ['<ConsentBodyText']],
    ['src/components/permissions/FallbackPermissionRequest.tsx', ['<ConsentBodyText']],
    ['src/components/permissions/FilesystemPermissionRequest/FilesystemPermissionRequest.tsx', ['<ConsentBodyText']],
    ['src/components/permissions/WebFetchPermissionRequest/WebFetchPermissionRequest.tsx', ['<ConsentBodyText']],
    ['src/components/permissions/BrowserPermissionRequest/BrowserPermissionRequest.tsx', ['<ConsentBodyText']],
    ['src/components/permissions/ApolloReviewPermissionRequest/ApolloReviewPermissionRequest.tsx', ['boundLines(', 'consentBodyBudget(rows)']],
    ['src/components/permissions/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.tsx', ['consentBodyBudget(termRows)', 'totalLineRows(']],
  ]
  for (const [rel, needles] of readers) {
    const src = read(rel)
    const missing = needles.filter(n => !src.includes(n))
    check(`${rel.split('/').pop()} reads the one owner (${needles.length} shapes)`, missing.length === 0, `missing: ${missing.join(', ')}`)
  }
  const editCard = read('src/components/permissions/FileEditPermissionRequest/FileEditPermissionRequest.tsx')
  const sedCard = read('src/components/permissions/SedEditPermissionRequest/SedEditPermissionRequest.tsx')
  check('the Edit consent card renders the bounded wrapper', editCard.includes('ConsentFileEditDiff') && !/content=\{<FileEditToolDiff/.test(editCard))
  check('the sed consent card renders the bounded wrapper', sedCard.includes('ConsentFileEditDiff') && !/<FileEditToolDiff\b/.test(sedCard))
  const transcriptSurface = read('src/tools/FileEditTool/UI.tsx')
  check("the transcript's rejected-edit surface stays deliberately unbounded (bare FileEditToolDiff, no consent budget)", transcriptSurface.includes('<FileEditToolDiff') && !transcriptSurface.includes('consentBudget'))
  const notebookCard = read('src/components/permissions/NotebookEditPermissionRequest/NotebookEditPermissionRequest.tsx')
  check('the notebook card no longer hands its diff a fixed width', !notebookCard.includes('width={verbose ? 120 : 80}'))
  const editDiff = read('src/components/FileEditToolDiff.tsx')
  check('the Edit diff spends its frame (border + padding) inside the card\'s content box', editDiff.includes('outerWidth - FRAME_COLUMNS') && editDiff.includes('const FRAME_COLUMNS = 4'))
}

section('§5 the expand door — one chord, Confirmation context, the tail\'s words')
{
  const chordReaders = [
    'src/components/permissions/ConsentFileEditDiff.tsx',
    'src/components/permissions/FileWritePermissionRequest/FileWriteToolDiff.tsx',
    'src/components/permissions/NotebookEditPermissionRequest/NotebookEditToolDiff.tsx',
    'src/components/permissions/ChangeSetPermissionRequest/ChangeSetPermissionRequest.tsx',
    'src/components/permissions/ConsentBodyText.tsx',
    'src/components/permissions/ApolloReviewPermissionRequest/ApolloReviewPermissionRequest.tsx',
    'src/components/permissions/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.tsx',
  ]
  for (const rel of chordReaders) {
    const src = read(rel)
    check(`${rel.split('/').pop()} binds confirm:toggleFullPreview in the Confirmation context`, src.includes("useKeybinding('confirm:toggleFullPreview'") && src.includes("context: 'Confirmation'"))
  }
  const wrapper = read('src/components/permissions/ConsentFileEditDiff.tsx')
  check('expanded hands the diff a null budget (the whole diff)', wrapper.includes('expanded ? null : consentBodyBudget(rows)'))
  const tails: Array<[string, string[]]> = [
    ['src/components/FileEditToolDiff.tsx', ['more line', 'ctrl+f expands', 'the whole edit applies', 'ctrl+f collapses the preview']],
    ['src/components/permissions/FileWritePermissionRequest/FileWriteToolDiff.tsx', ['more line', 'ctrl+f expands', 'ctrl+f collapses the preview']],
    ['src/components/permissions/NotebookEditPermissionRequest/NotebookEditToolDiff.tsx', ['more line', 'ctrl+f expands', 'the whole edit applies', 'ctrl+f collapses the preview']],
    ['src/components/permissions/ChangeSetPermissionRequest/ChangeSetPermissionRequest.tsx', ['more line', 'more file', 'ctrl+f expands', 'ctrl+f collapses the preview']],
    ['src/components/permissions/ConsentBodyText.tsx', ['more line', 'ctrl+f expands', 'ctrl+f collapses the preview']],
    ['src/components/permissions/BashPermissionRequest/BashPermissionRequest.tsx', ['(the whole command runs)']],
    ['src/components/permissions/PowerShellPermissionRequest/PowerShellPermissionRequest.tsx', ['(the whole command runs)']],
  ]
  for (const [rel, words] of tails) {
    const src = read(rel)
    const missing = words.filter(w => !src.includes(w))
    check(`${rel.split('/').pop()} speaks the tail's existing words`, missing.length === 0, `missing: ${missing.join(', ')}`)
  }
}

{
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const budget = await import('../../src/components/permissions/consentBodyBudget.ts')
  const ui = readFileSync(join(import.meta.dir, '..', '..', 'src', 'tools', 'FileEditTool', 'UI.tsx'), 'utf8')
  const rejected = ui.slice(ui.indexOf('export function renderToolUseRejectedMessage'))
  check("the rejected-edit row's diff reads the card's content width at the row's columns (never unbounded)", rejected.includes('availableWidth: consentContentWidth(options.width)'))
  check('at 100 columns the diff paints inside the row (the card\'s borders and paddings spent)', budget.consentContentWidth(100) < 100 && budget.consentContentWidth(100) >= 90, `${budget.consentContentWidth(100)}`)
}

console.log(
  failures === 0
    ? '\n ✅ CONSENT BODIES BOUNDED — every card fits the pane; the cut is counted as painted'
    : `\n ❌ ${failures} FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
