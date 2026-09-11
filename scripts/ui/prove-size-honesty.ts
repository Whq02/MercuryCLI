#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }

const ROOT = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('§1 C1 — the footer transient is one row by fold')
{
  const { footerNoticeLine } = await import('../../src/components/PromptInput/Notifications.tsx')
  check('newlines fold to the seam', footerNoticeLine('hook said\nline two\nline three') === 'hook said · line two · line three')
  check('CRLF and blank runs fold clean', footerNoticeLine('a\r\n\r\n  b  \n\nc') === 'a · b · c')
  check('a one-line notice is untouched', footerNoticeLine('plain notice') === 'plain notice')
  check('the fold never mints a newline', !footerNoticeLine('x\ny\nz').includes('\n'))
  const src = read('src/components/PromptInput/Notifications.tsx')
  check('the transient paints THROUGH the fold (its hint-row form)', src.includes('const line = footerNoticeLine(current.text)'))
  check('the raw multi-line paint is gone', !src.includes('{current.text}'))
  check('the column itself paints no transient row', !src.includes("'jsx' in current ? (") && !src.includes('{footerNoticeLine(current.text)}'))
}

console.log('§2 C2 — the footer right cell holds a budget and keeps its tail')
{
  const repl = read('src/screens/REPL.tsx')
  check(
    'the budget exists and floors at 16',
    repl.includes('Math.min(stringWidth(right), Math.max(16, Math.floor((columns - 3) / 2)))'),
  )
  check('the cell is width-bound and truncates from the START', repl.includes('width={rightBudget}') && repl.includes('wrap="truncate-start"'))
  check('the left pack budgets against the CAPPED width', repl.includes('const rightWidth = right === \'\' ? 0 : rightBudget + 1'))
  check('the unbudgeted paint is gone', !repl.includes('<Text color={tokens.textSecondary}>{right}</Text>'))
}

console.log('§3 C3 — the hard-80 fields follow the terminal; the dialog caret is real')
{
  const sel = read('src/components/CustomSelect/select-input-option.tsx')
  check(
    'the feedback editor wraps at min(80, terminal − chrome), floored at 20',
    sel.includes('const inputColumns = Math.max(20, Math.min(INPUT_WRAP_COLUMNS, termCols - 6))') && sel.includes('columns={inputColumns}'),
  )
  check('no fixed-width TextInput survives there', !sel.includes('columns={INPUT_WRAP_COLUMNS}'))
  const add = read('src/components/permissions/rules/AddWorkspaceDirectory.tsx')
  check(
    'the add-directory field wraps live under the same cap',
    add.includes('const fieldColumns = Math.max(20, Math.min(80, termCols - 6))') && add.includes('columns={fieldColumns}'),
  )
  check(
    'the caret is REAL state, not a pin to the end',
    add.includes('const [cursorOffset, setCursorOffset] = useState(0)') &&
      add.includes('cursorOffset={cursorOffset}') &&
      add.includes('onChangeCursorOffset={setCursorOffset}') &&
      !add.includes('cursorOffset={value.length}') &&
      !add.includes('onChangeCursorOffset={() => {}}'),
  )
  check('a completion swap parks the caret at the new end', add.includes('setCursorOffset(completed.length)'))
}

console.log("§4 C4 — the tool row's tails price themselves against the row")
{
  const row = read('src/components/messages/AssistantToolUseMessage.tsx')
  check(
    'the head floor is derived (dot + mark + name floor + readable target + gutter)',
    row.includes('const ROW_HEAD_FLOOR = 2 + 2 + NAME_MIN_COLUMNS + 20 + 4'),
  )
  check('the summary tail pays its own width', row.includes('tailFits(1 + stringWidth(summary))'))
  check('the edit tail pays its exact rendered width', row.includes('tailFits(stringWidth(` · +${editMetaRaw.added}/-${editMetaRaw.removed}`))'))
  check('the raw ≥80 proxies are gone', !row.includes('columns >= 80'))
}

console.log('§5 C6 — the tool header is one row by fold, both shells')
{
  const { oneLineCommandDisplay, TOOL_USE_LINE_MAX_CHARS } = await import('../../src/tools/commandDisplay.ts')
  check('a two-line command folds to the marker', oneLineCommandDisplay('Get-Item a\nGet-Item b') === 'Get-Item a ↵ Get-Item b')
  check('no output ever carries a newline', !oneLineCommandDisplay('a\nb\nc\nd\ne').includes('\n'))
  check('a one-liner is untouched', oneLineCommandDisplay('echo hello') === 'echo hello')
  const long = 'x'.repeat(TOOL_USE_LINE_MAX_CHARS + 40)
  check('the cap cuts with an ellipsis at the cap', oneLineCommandDisplay(long).length === TOOL_USE_LINE_MAX_CHARS + 1 && oneLineCommandDisplay(long).endsWith('…'))
  check('a fold under the cap earns no ellipsis (the marker carries the truth)', !oneLineCommandDisplay('a\nb').includes('…'))
  const bash = read('src/tools/BashTool/UI.tsx')
  const pwsh = read('src/tools/PowerShellTool/UI.tsx')
  check('both shells ride the shared fold', bash.includes('oneLineCommandDisplay(command)') && pwsh.includes('oneLineCommandDisplay(command)'))
  check('the two-line truncations are retired', !bash.includes('truncateCommandDisplay') && !pwsh.includes('lines.slice(0, 2)'))
}

console.log('§6 — the consent command is height-bound and names its cut')
{
  const { boundLines, consentBodyBudget, consentContentWidth, CONSENT_BODY_MIN_ROWS } = await import('../../src/components/permissions/consentBodyBudget.ts')
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
  for (const rel of [
    'src/components/permissions/BashPermissionRequest/BashPermissionRequest.tsx',
    'src/components/permissions/PowerShellPermissionRequest/PowerShellPermissionRequest.tsx',
  ]) {
    const card = read(rel)
    check(
      `${rel.split('/').pop()} rides the bounded body and names its cut`,
      card.includes('<ConsentBodyText') && card.includes('(the whole command runs)'),
    )
  }
}

console.log('§7 C7+C8 — the picker row measures in cells and its metadata line is cut')
{
  const sel = read('src/components/LogSelector.tsx')
  check('the label truncation rides the grapheme-aware owner', sel.includes('return truncateToWidth(text, Math.max(MIN_LABEL_WIDTH, width))'))
  check('the code-unit slice is gone', !sel.includes('text.slice(0, Math.max(1, budget - 1))'))
  check('every description call is FITTED', (sel.match(/describeLogFitted\(/g) ?? []).length >= 4 && !/description: describeLog\(/.test(sel))
  check('child rows pay their indent out of the same budget', sel.includes('Math.max(MIN_LABEL_WIDTH, labelWidth - 4)'))
  const { truncateToWidth } = await import('../../src/utils/truncate.ts')
  check('the owner is width-true on wide glyphs (10 CJK cells cut to ≤8+ellipsis)', truncateToWidth('漢漢漢漢漢', 9).length <= 5 && truncateToWidth('漢漢漢漢漢', 9).endsWith('…'))
}

console.log('§8 C9 — AGE right-aligns under its header; the filter echo is bounded')
{
  const { padStartTo, padTo } = await import('../../src/components/mercury-ui/glyphs.ts')
  check('padStartTo fills from the left', padStartTo('3m', 5) === '   3m' && padTo('3m', 5) === '3m   ')
  check('padStartTo truncates width-true past the cell', padStartTo('longest', 5).length <= 5)
  check('a full cell is identity', padStartTo('waits', 5) === 'waits')
  const layout = read('src/components/concourse/ConcourseLayout.tsx')
  check('the AGE cell rides the right-aligned twin', layout.includes("padStartTo(r.state === 'queued' ? 'waits' : (r.ageLabel ?? '—'), 5)"))
  check('the filter echo is bounded to the pane', layout.includes('truncateToWidth(filterText, Math.max(8, interior - 24))'))
}

console.log('§9 C10 — the mirror title yields to a MEASURED cluster')
{
  const mirror = read('src/components/concourse/SessionMirror.tsx')
  check('the fixed 10-cell reserve is gone', !mirror.includes('paneWidth - 10'))
  check(
    'the cluster is measured (note text or hint + activity) and bounded to half the pane',
    mirror.includes("stringWidth('↵ enter session') + (nowText !== null ? stringWidth(nowText) + 3 : 0)") &&
      mirror.includes('Math.min(clusterDesired, Math.max(10, Math.floor(paneWidth / 2)))'),
  )
  check('the title takes the true remainder', mirror.includes('truncateToWidth(title, titleBudget)') && mirror.includes('Math.max(8, paneWidth - clusterReserve - 2)'))
  check('the note text is bounded to its own reserve', mirror.includes('truncateToWidth(noteText, clusterReserve)'))
}

console.log('§10 C11 — an over-wide rail token truncates, never vanishes')
{
  const { wrapRailRows } = await import('../../src/components/HelmLanesRail.tsx')
  const path = 'C:\\Users\\OPERATOR\\AppData\\Local\\mercury\\transcripts\\deep\\file.txt'
  const rows = wrapRailRows(`writing ${path} now`, 20, 4)
  check('the over-wide token keeps a truncated row of its own', rows.some(r => r.includes('C:\\Users')), rows.join(' | '))
  check('its neighbours survive around it', rows[0] === 'writing' && rows.some(r => r === 'now'))
  check('ordinary wrapping is unchanged', wrapRailRows('one two three', 9, 3).join('|') === 'one two|three')
  check('the row cap still ends with the honest ellipsis', wrapRailRows('a b c d e f g h', 3, 2)[1]!.endsWith('…'))
  check('every produced row fits the rail', wrapRailRows(`x ${path} y`, 14, 5).every(r => r.length <= 14))
}

console.log('§11 C12 — the strip note truncates its middle, never its fix')
{
  const strips = read('src/components/concourse/ConcourseStrips.tsx')
  check(
    'the note row rides truncate-middle inside its height-1 slot',
    /note\.tone === 'warning' \? t\.warning : t\.textMuted\} wrap="truncate-middle"/.test(strips),
  )
  const { MANAGER_NEEDS_MODEL_LINE } = await import('../../src/services/concourse/managerMode.ts')
  check('the blocking line still carries its fix in the TAIL (what middle-truncation preserves)', MANAGER_NEEDS_MODEL_LINE.endsWith('picks one'))
  const wrapText = (await import('../../src/ink/wrap-text.ts')).default
  const cut = wrapText(MANAGER_NEEDS_MODEL_LINE, 38, 'truncate-middle')
  check('at 38 columns the middle cut keeps both the problem head and the fix tail', cut.includes('manager mode needs') && cut.includes('picks one'), cut)
}

console.log('§12 C13 — the daemon rows measure the terminal')
{
  const view = read('src/components/mercury-ui/parity/DaemonSupervisorView.tsx')
  check('the detail and dir budgets derive from the live width', view.includes('const detailBudget = Math.max(40, termCols - 24)') && view.includes('const dirBudget = Math.max(40, termCols - 22)'))
  check('both consumers ride the budgets', view.includes('truncateToWidth(detail, detailBudget)') && view.includes('truncateToWidth(v.dir, dirBudget)'))
  check('no fixed detail/dir cell survives', !view.includes('truncateToWidth(detail, 56)') && !view.includes('truncateToWidth(v.dir, 54)'))
  check('the ruled shapes stay: the 14-cell name column and status-first ordering', view.includes('padTo(w.short, 14)') && view.includes('`${w.state} · ${activity} · respawns'))
}

console.log('§13 C14 — the palette rows measure the terminal')
{
  const view = read('src/components/mercury-ui/PaletteView.tsx')
  check('the description budget derives from the live width and the row’s OWN name', view.includes('truncateToWidth(r.description, Math.max(16, cols - 9 - stringWidth(r.name)))'))
  check('the query display follows the width', view.includes('truncateToWidth(query, Math.max(24, cols - 12))'))
  check('no fixed 52/48 survives', !view.includes(', 52)') && !view.includes('truncateToWidth(query, 48)'))
}

console.log('§14 E2 — sliceAnsi never exceeds its bound by the oracle’s measure')
{
  const sliceAnsi = (await import('../../src/utils/sliceAnsi.ts')).default
  const { stringWidth } = await import('../../src/ink/stringWidth.ts')
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

console.log('§15 E3 — the fallback diff measures cells, not code units')
{
  const fb = read('src/components/StructuredDiff/Fallback.tsx')
  check('the whole-line pad rides the oracle', fb.includes("segment + ' '.repeat(Math.max(0, contentWidth - stringWidth(segment)))") && !fb.includes('segment.padEnd(contentWidth)'))
  check('the word-level column accounting rides the oracle', fb.includes('column + stringWidth(piece) > contentWidth') && fb.includes('column += stringWidth(piece)') && !fb.includes('column += piece.length'))
  check('the rendered-line pad measures cells', fb.includes('cells.reduce((sum, cell) => sum + stringWidth(cell.text), 0)'))
  check('the wrapper was already width-true (wrapText) — only the pads lied', fb.includes("wrapText(text, width, 'wrap')"))
}

console.log('§16 E4 — table cells re-break to the oracle’s own measure')
{
  const table = read('src/components/MarkdownTable.tsx')
  check(
    'the re-break rides the oracle + the cluster-true slicer',
    table.includes('while (stringWidth(line) > w) {') && table.includes('const head = sliceAnsi(line, 0, w)'),
  )
  check('the take-the-cluster stall guard stands (a 1-wide column cannot loop)', table.includes("if (head === '' || stringWidth(head) === 0 || head === line) break"))
  check('the pads already measured through the oracle (padTo — one table now end to end)', table.includes('const deficit = Math.max(0, width - stringWidth(text))'))
}

console.log(failures === 0 ? '\nsize-honesty: GREEN' : `\nsize-honesty: ${failures} RED`)
process.exit(failures === 0 ? 0 : 1)
