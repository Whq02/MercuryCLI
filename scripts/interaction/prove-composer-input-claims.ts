#!/usr/bin/env bun
// ============================================================================
//  prove-composer-input-claims — the composer input-core truths (the
//  TASK-E004 field audit's Q2 cluster; ideology laws 3 and 5: keystrokes
//  land where the user is looking, and a fixed mechanism stays pinned).
//
//  §1 PURE — resolver + seed truths:
//     · the Atlas context SHADOWS the Global claims on the atlas's mode
//       chords (ctrl+l/ctrl+r resolved app:redraw/history:search first —
//       the advertised lookup was unreachable);
//     · ONE chord display dialect (alt/meta collapse) — the same binding
//       surfaced as 'meta+p' in one hint and 'alt+p' in another;
//     · the early-input capture seeds the composer draft through
//       initSession ('early input wins') — boot keystrokes were captured
//       and then discarded because nothing consumed the buffer.
//  §2 SOURCE ratchets — the wiring that has no pure seam: the covered-REPL
//     fence, the boot-seed argument, the queued/applied notice pair, the
//     bang-paste guard, the palette query cap, the live-draft paste-id
//     scan, the bash-mode search field, the selection-band token.
//  §3 PTY — three real journeys in the built binary: concourse keys never
//     land in the parked composer; a multi-line '!' paste chips instead of
//     flooding shell mode; the narrow help overlay states what it cut.
// ============================================================================
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

process.env.MERCURY_CONFIG_DIR ??= mkdtempSync(join(tmpdir(), 'input-claims-home-'))

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const read = (p: string): string =>
  readFileSync(join(import.meta.dir, '..', '..', p), 'utf8')

console.log('============================================================')
console.log(' composer input claims — atlas · dialect · boot seed (PTY)')
console.log('============================================================')

console.log('\n── §1 resolver + seed truths ────────────────────────────────')
{
  const { resolveKey, getBindingDisplayText } = await import('../../src/keybindings/resolver.ts')
  const { DEFAULT_BINDINGS } = await import('../../src/keybindings/defaultBindings.ts')
  const { parseBindings } = await import('../../src/keybindings/parser.ts')
  const bindings = parseBindings(DEFAULT_BINDINGS)
  const key = (ctrl: boolean) =>
    ({ ctrl, alt: false, shift: false, meta: false, super: false }) as never

  const globalOnly = resolveKey('l', key(true), ['Global'], bindings)
  check(
    'without the atlas, ctrl+l is the Global redraw',
    globalOnly.type === 'match' && globalOnly.action === 'app:redraw',
    JSON.stringify(globalOnly),
  )
  const atlasL = resolveKey('l', key(true), ['Atlas', 'Global'], bindings)
  check(
    'with the Atlas context active, ctrl+l resolves to the atlas lookup (the advertised key reaches the atlas)',
    atlasL.type === 'match' && atlasL.action === 'atlas:lookup',
    JSON.stringify(atlasL),
  )
  const atlasR = resolveKey('r', key(true), ['Atlas', 'Global'], bindings)
  check(
    'with the Atlas context active, ctrl+r resolves to the atlas rebind (shadows history:search)',
    atlasR.type === 'match' && atlasR.action === 'atlas:rebind',
    JSON.stringify(atlasR),
  )

  // One display dialect: the default modelPicker binding is spelled meta+p;
  // every hint must render the collapsed alt/meta modifier, never 'meta'.
  const linux = getBindingDisplayText('chat:modelPicker', 'Chat', bindings, 'linux')
  const mac = getBindingDisplayText('chat:modelPicker', 'Chat', bindings, 'macos')
  check("the display dialect collapses meta → 'alt+p' off-mac", linux === 'alt+p', String(linux))
  check("… and → 'opt+p' on macOS", mac === 'opt+p', String(mac))
  const ctrlChord = getBindingDisplayText('app:toggleTranscript', 'Global', bindings)
  check('ctrl chords render unchanged in the dialect', ctrlChord === 'ctrl+o', String(ctrlChord))
}
{
  const early = await import('../../src/utils/earlyInput.ts')
  const pending = await import('../../src/input-core/pending-input.ts')
  pending.resetPendingInputForTests()
  early.seedEarlyInput('typed during boot')
  const consumed = early.consumeEarlyInput()
  check('consumeEarlyInput returns the captured buffer once', consumed === 'typed during boot', consumed)
  check('… and clears it', early.consumeEarlyInput() === '')
  pending.initSession('input-claims-session', consumed)
  check(
    "initSession seeds the composer draft from the early input ('early input wins')",
    pending.text() === 'typed during boot',
    pending.text(),
  )
  pending.resetPendingInputForTests()
}
{
  // The dangling-reference decision (the paste-recall class's honest-failure
  // arm): a reference whose body is absent — or whose entry is the WRONG
  // TYPE — must be named and refused, never silently shipped or wrongly
  // attached.
  const { danglingReferences } = await import('../../src/history.ts')
  const store = {
    1: { id: 1, type: 'text', content: 'body one' },
    2: { id: 2, type: 'image', content: 'x', mediaType: 'image/png', filename: 'a.png' },
  } as never
  check(
    'a resolvable text reference is not dangling',
    danglingReferences('see [Pasted text #1 +3 lines]', store).length === 0,
  )
  check(
    'an aged-out reference is dangling (bare-placeholder shipping refused)',
    danglingReferences('see [Pasted text #9 +3 lines]', store).map(r => r.id).join() === '9',
  )
  check(
    'an image reference resolves only against an IMAGE entry',
    danglingReferences('[Image #2]', store).length === 0 &&
      danglingReferences('[Image #1]', store).length === 1,
  )
  check(
    'a type-mismatched entry is dangling — never the wrong data',
    danglingReferences('[Pasted text #2]', store).length === 1,
  )
  check(
    'the dotted truncated form resolves through its text entry',
    danglingReferences('[...Truncated text #1 +12 lines...]', store).length === 0,
  )
}

console.log('\n── §2 wiring pinned in source ───────────────────────────────')
{
  const repl = read('src/screens/REPL.tsx')
  const prompt = read('src/components/PromptInput/PromptInput.tsx')
  check(
    'the REPL boot seed consumes the early-input capture (a hardcoded empty seed discarded boot keystrokes)',
    repl.includes('pendingInput.initSession(getSessionId(), consumeEarlyInput())'),
  )
  // The model-switch boundary receipt is the SESSION's (its runner applies
  // the switch and its facts feed names the model); the screen paints no
  // 'model-switched' receipt of its own, so the queued notice's one-way
  // invalidation is the whole law on the face.
  check(
    'the queued notice retires the transition-applied notice (the screen paints no model-switched receipt of its own)',
    prompt.includes("invalidates: ['model-transition-applied']") && !repl.includes("key: 'model-switched'"),
  )
  check(
    'the raw ladder carries the covered-REPL fence (concourse keys must not reach the parked composer)',
    prompt.includes("if (currentSurfaceRoute().kind !== 'repl') return"),
  )
  check(
    'the text-buffer focus carries the same fence',
    prompt.includes('helmOnPrompt && !surfaceCovered'),
  )
  check(
    'a paste may enter shell mode only as a short single line (the bang-paste flood guard)',
    /input === '' &&\s*\n\s*lineCount === 1 &&\s*\n\s*text\.length <= PASTE_THRESHOLD/.test(prompt),
  )
  check(
    'paste-id allocation scans the LIVE draft (a recalled chip id is never re-minted)',
    prompt.includes('parseReferences(pendingInput.text())') &&
      prompt.includes('while (taken.has(id)) id++',),
  )
  check(
    'submit refuses dangling references with a visible notice (never a silent bare placeholder)',
    prompt.includes("key: 'paste-ref-dangling'") &&
      prompt.includes('danglingReferences(submitted'),
  )
  const palette = read('src/components/MercuryCommandPalette.tsx')
  check(
    'the palette query is length-capped (an uncapped paste grew the overlay past the screen)',
    palette.includes('.slice(0, QUERY_MAX_LENGTH)'),
  )
  const leftSide = read('src/components/PromptInput/PromptInputFooterLeftSide.tsx')
  check(
    'the bash-mode collapse keeps the reverse-search field (an invisible search ate keystrokes)',
    /mode === 'bash'[\s\S]{0,600}searchField \?\?/.test(leftSide),
  )
  const suggestions = read('src/components/PromptInput/PromptInputFooterSuggestions.tsx')
  check(
    'the selection band paints the design-system token, not an unknown Theme key',
    suggestions.includes('tokens.selectionBand') &&
      !suggestions.includes("selected ? 'selectionBand'"),
  )
  // The `?` grid budgets its rows beneath a notice column whose height
  // varies (the sign-in row, a steering split at its seams, a JSX refusal
  // of several rows); a fixed chrome allowance pushed the grid's own
  // remainder row below the screen (journey C). The grid now measures its
  // own screen top after an uncapped paint and caps to the rows beneath it
  // — the fork's row twin of elementScreenLeft is the one owner of that
  // arithmetic.
  const helpMenu = read('src/components/PromptInput/PromptInputHelpMenu.tsx')
  const measurer = read('src/ink/measure-element.ts')
  check(
    'the fork owns the screen-row measurement beside its column twin',
    measurer.includes('export function elementScreenTop(node: DOMElement): number') &&
      measurer.includes('export function elementScreenLeft(node: DOMElement): number'),
  )
  check(
    'the help grid caps to the rows beneath its measured screen top, not a chrome guess',
    helpMenu.includes('const top = elementScreenTop(element)') &&
      helpMenu.includes('rows: Math.max(3, termRows - top)') &&
      helpMenu.includes('ref={gridRef}'),
  )
}

console.log('\n── §3 PTY journeys ──────────────────────────────────────────')
const { scenario, cleanupScenario } = await import('../ui/renderScenarios.ts')

function capture(
  tag: string,
  scenarioName: string,
  cols: number,
  rows: number,
  sends: Array<Record<string, unknown> & { data: string }>,
  total: number,
): string[] | null {
  // scenario() mutates process.env for its child (the concourse scenario
  // sets MERCURY_CONCOURSE=always) — snapshot and restore, or every LATER
  // journey in this process boots into the wrong surface.
  const envBefore = { ...process.env }
  const cfg = scenario(scenarioName, cols, rows)
  const gridPath = `/tmp/input-claims-${tag}-${process.pid}.json`
  const cfgPath = `/tmp/input-claims-${tag}-cfg-${process.pid}.json`
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, sends, total, out: gridPath }))
  const res = spawnSync('/usr/bin/python3', [join(import.meta.dir, '../ui/vshot.py'), cfgPath], {
    encoding: 'utf8',
    timeout: vshotBudgetMs(150_000),
    env: { ...process.env, MERCURY_LIVE_GLYPHS: '0' },
  })
  cleanupScenario(scenarioName)
  for (const k of Object.keys(process.env)) {
    if (!(k in envBefore)) delete process.env[k]
  }
  Object.assign(process.env, envBefore)
  if (res.status !== 0) {
    check(`${tag}: PTY capture ran`, false, res.stderr?.slice(0, 200) ?? '')
    try {
      const g = (JSON.parse(readFileSync(gridPath, 'utf8')) as { grid: { c: string }[][] }).grid
      console.log(g.slice(-6).map(r => `      | ${r.map(c => c.c).join('').trimEnd()}`).join('\n'))
    } catch {
      /* no grid written */
    }
    return null
  }
  const grid = (JSON.parse(readFileSync(gridPath, 'utf8')) as { grid: { c: string }[][] }).grid
  return grid.map(r => r.map(c => c.c).join(''))
}

{
  // Journey A — the parked-composer fence: type on the concourse, esc home,
  // and the ROOT composer must not hold the concourse keystrokes.
  const a = capture(
    'conleak',
    'concourse',
    100,
    38,
    [
      { awaitText: 'for shortcuts', minTick: 5, atTick: 60, awaitSettleTicks: 3, data: 'zqxw' },
      { afterPrevTicks: 10, data: '\u001b' },
      { afterPrevTicks: 14, data: '' },
    ],
    120,
  )
  if (a) {
    check(
      'concourse keystrokes never land in the parked root composer',
      !a.some(l => l.includes('zqxw')),
      a.find(l => l.includes('zqxw')) ?? '',
    )
    check('esc returned to the root REPL (composer sigil present)', a.some(l => l.includes('❯')))
  }
}
{
  // Journey B — a multi-line paste whose body starts '!' is CONTENT: it
  // takes the chip path in prompt mode, never floods shell mode.
  const body = Array.from({ length: 20 }, (_, i) => `const bangRow${i} = ${i}`).join('\n')
  const b = capture(
    'bangpaste',
    'resume-2turn',
    120,
    38,
    [
      {
        awaitText: '\u276f',
        minTick: 5,
        atTick: 60,
        awaitSettleTicks: 3,
        data: `\u001b[200~!${body}\u001b[201~`,
      },
      { afterPrevTicks: 14, data: '' },
    ],
    110,
  )
  if (b) {
    check(
      "the bang paste rendered a chip ('[Pasted text #1 …')",
      b.some(l => l.includes('[Pasted text #1')),
      b.find(l => l.includes('Pasted')) ?? '(no chip row)',
    )
    check(
      'the composer did not flip to shell mode',
      !b.some(l => l.includes('for shell mode')),
    )
  }
}
{
  // Journey C — the narrow help overlay states what it cut (60×24 sheds
  // rows; the remainder line is the visible truth), and the taller control
  // shows the full single-column list with no remainder.
  const c = capture('help-narrow', 'help', 100, 22, [{ atTick: 30, data: '?' }], 46)
  if (c) {
    const saysWhatItCut = c.some(l => l.includes('more · /help lists every shortcut'))
    check('the clipped narrow help overlay says what it cut', saysWhatItCut, c.slice(-8).join(' | '))
    if (!saysWhatItCut) {
      // The whole frame, row-numbered: a remainder row that fell below the
      // screen leaves no trace in the last rows alone.
      console.log('      ┌ the 60×24 frame — no remainder row')
      c.forEach((line, index) => {
        const row = line.trimEnd()
        if (row !== '') console.log(`      │ ${String(index).padStart(2, ' ')} ${row}`)
      })
      console.log('      └')
    }
  }
  const d = capture('help-tall', 'help', 100, 38, [{ atTick: 30, data: '?' }], 46)
  if (d) {
    check(
      'the 60×38 control shows the whole list (no remainder row)',
      !d.some(l => l.includes('more · /help lists every shortcut')),
    )
    check(
      "… including the tail entries the narrow overlay used to clip silently ('stash prompt')",
      d.some(l => l.includes('stash prompt')),
    )
  }
}

console.log(failures === 0 ? '\n✅ prove-composer-input-claims — all checks pass' : `\n❌ prove-composer-input-claims — ${failures} failing`)
process.exit(failures === 0 ? 0 : 1)
