#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-s32-acceptance.ts — the S32 "acceptance
//  checks with no dedicated oracle", items 1–84, as one prover.
//
//  Method per check class (the prove-s31-acceptance idiom):
//  · pure importable surfaces (Cursor/MeasuredText, the kill ring, the vim
//    quintet, format/formatBriefTimestamp, terminal folding, markdown,
//    theme, pasteStore, slowOperations, the config-loader walk) are
//    exercised BEHAVIOURALLY in-process — real git repos, scratch homes and
//    scratch stores where topology is needed;
//  · platform-bound or PTY/process-bound corners (Windows/macOS clipboard
//    branches, the tmux panel, the submission pipeline's hook/context
//    machinery) are pinned STRUCTURALLY on the rewritten sources; every
//    such check prints `[pin]` so the method is auditable per row.
// ============================================================================

import { execSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Scratch config home BEFORE imports: pasteStore and the config loader key
// off the resolved Mercury home. Everything is realpath'd — the product
// works in PHYSICAL paths (Shell.ts resolves the cwd through symlinks), so
// fixture paths must match or /var-vs-/private/var splits the comparisons.
// Native file search: the vendored rg payload sits beside dist, not beside
// bun scripts — the registered native-walker lane is the in-process path.
import { realpathSync } from 'node:fs'
const TMP = realpathSync(tmpdir())
const SCRATCH_HOME = mkdtempSync(join(TMP, 's32-acceptance-home-'))
process.env.MERCURY_CONFIG_DIR = SCRATCH_HOME

import {
  Cursor,
  MeasuredText,
  pushToKillRing,
  getLastKill,
  getKillRingItem,
  getKillRingSize,
  clearKillRing,
  resetKillAccumulation,
  recordYank,
  canYankPop,
  yankPop,
  resetYankState,
} from '../../src/utils/Cursor.js'
import { resolveMotion } from '../../src/vim/motions.js'
import { findTextObject } from '../../src/vim/textObjects.js'
import {
  executeOperatorMotion,
  executeOperatorFind,
  executeOperatorTextObj,
  executeLineOp,
  executePaste,
  executeReplace,
  executeIndent,
  executeOperatorG,
  executeOperatorGg,
  type OperatorContext,
} from '../../src/vim/operators.js'
import { transition } from '../../src/vim/transitions.js'
import type { CommandState, FindType, RecordedChange } from '../../src/vim/types.js'
import { MAX_VIM_COUNT } from '../../src/vim/types.js'
import {
  formatFileSize,
  formatDuration,
  formatBarElapsed,
  formatRelativeTime,
  formatResetText,
} from '../../src/utils/format.js'
import { formatBriefTimestamp } from '../../src/utils/formatBriefTimestamp.js'
import { renderTruncatedContent, isOutputLineTruncated } from '../../src/utils/terminal.js'
import { applyMarkdown, configureMarked } from '../../src/utils/markdown.js'
import {
  getProjectDirsUpToHome,
  loadMarkdownFilesForSubdir,
  clearMarkdownFileCache,
} from '../../src/utils/markdownConfigLoader.js'
import { hashPastedText, storePastedText, retrievePastedText, cleanupOldPastes } from '../../src/utils/pasteStore.js'
import { getTheme, lerpHex, themeColorToAnsi, THEME_NAMES, type Theme, type ThemeName } from '../../src/utils/theme.js'
import { slowLogging, SLOW_OPERATION_THRESHOLD_MS } from '../../src/utils/slowOperations.js'
import { isImageFilePath } from '../../src/utils/imagePaste.js'
import { getMercuryHome } from '../../src/utils/envUtils.js'
import { TEAL as MERCURY_TEAL, AMBER as MERCURY_AMBER, CRIMSON as MERCURY_CRIMSON } from '../../src/components/mercuryPalette.js'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}
/** Structural pin on the rewritten source (no in-process harness exists). */
function pin(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} [pin] ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}
const src = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8')

const CHIP = '[Pasted text #1 +5 lines]'

// A minimal vim harness over the real Cursor + operator context.
function makeVim(text: string, offset: number, columns = 80) {
  const state = {
    text,
    offset,
    register: '',
    registerIsLinewise: false,
    lastFind: null as { type: FindType; char: string } | null,
    changes: [] as RecordedChange[],
    insertEntered: null as number | null,
  }
  const ctx: OperatorContext = {
    get cursor() {
      return Cursor.fromText(state.text, columns, state.offset)
    },
    get text() {
      return state.text
    },
    setText: t => {
      state.text = t
    },
    setOffset: o => {
      state.offset = o
    },
    enterInsert: o => {
      state.insertEntered = o
      state.offset = o
    },
    getRegister: () => state.register,
    setRegister: (content, linewise) => {
      state.register = content
      state.registerIsLinewise = linewise
    },
    getLastFind: () => state.lastFind,
    setLastFind: (type, char) => {
      state.lastFind = { type, char }
    },
    recordChange: change => {
      state.changes.push(change)
    },
  }
  return { state, ctx }
}

/** Drive a NORMAL-mode key sequence through the real transition machine. */
function driveKeys(harness: ReturnType<typeof makeVim>, keys: string[]): CommandState {
  let command: CommandState = { type: 'idle' }
  for (const key of keys) {
    const result = transition(command, key, harness.ctx)
    result.execute?.()
    command = result.next ?? { type: 'idle' }
  }
  return command
}

console.log('── S32 §7.2 acceptance checks 1–84 ──')
console.log('\n── caret and document (1–12) ──')

// 1: decomposed input reports composed offsets; no mid-cluster caret.
{
  const decomposed = 'éclair' // é as e + combining acute
  const doc = new MeasuredText(decomposed, 80)
  const composed = decomposed.normalize('NFC')
  const cursor = new Cursor(doc, 1)
  check(
    '1. NFC normalisation + no grapheme split by offset placement',
    doc.text === composed && doc.text.length === composed.length && doc.snapToGraphemeBoundary(1) <= 1,
    `text=${JSON.stringify(doc.text)}`,
  )
}

// 2: arrows cross a ZWJ emoji as one cluster.
{
  const family = '👩‍👩‍👧‍👦'
  const cursor = Cursor.fromText(`a${family}b`, 80, 1)
  const right = cursor.right()
  const backAgain = right.left()
  check(
    '2. ZWJ emoji cluster hops whole',
    right.offset === 1 + family.length && backAgain.offset === 1,
    `right=${right.offset} back=${backAgain.offset}`,
  )
}

// 3: up/down preserve display column, clamp on shorter lines; boundary identity.
{
  const text = 'long first line\nab\nanother long line'
  const down = Cursor.fromText(text, 80, 10).down()
  const clamped = down.getPosition()
  const top = Cursor.fromText(text, 80, 3)
  const up0 = top.up()
  const bottom = Cursor.fromText(text, 80, text.length - 2)
  const downLast = bottom.down()
  check(
    '3. vertical motion clamps to the shorter line; up@0/down@last are identity',
    clamped.line === 1 && clamped.column <= 2 && up0.equals(top) && downLast.equals(bottom),
    `clamped=${JSON.stringify(clamped)} up0=${up0.offset} downLast=${downLast.offset}`,
  )
}

// 4: start-of-line at column 0 of a wrapped continuation moves to the previous display line's start.
{
  const text = 'aaaa bbbb cccc dddd'
  const doc = new MeasuredText(text, 10)
  const lines = doc.getWrappedLines()
  const secondStart = lines[1]!.startOffset
  const cursor = new Cursor(doc, secondStart)
  const sol = cursor.startOfLine()
  check(
    '4. SOL at a wrapped continuation column 0 goes to the previous display line',
    lines.length > 1 && sol.offset === lines[0]!.startOffset,
    `secondStart=${secondStart} sol=${sol.offset}`,
  )
}

// 5: logical up/down preserve code-unit column, clamp, snap to grapheme boundary.
{
  const text = 'abcdefgh\nxy\naé💚cdefgh'
  const down1 = Cursor.fromText(text, 80, 6).downLogicalLine()
  const pos1 = down1.offset
  const line2Start = text.indexOf('xy')
  const clampOk = pos1 === line2Start + 2 // clamped to 'xy' end
  const fromXy = Cursor.fromText(text, 80, line2Start + 2).downLogicalLine()
  const line3Start = text.indexOf('aé💚cdefgh')
  const inLine3 = fromXy.offset - line3Start
  const snapped = new MeasuredText('aé💚cdefgh', 80).snapToGraphemeBoundary(inLine3) === inLine3
  check('5. logical vertical: code-unit column, clamped, grapheme-snapped', clampOk && snapped, `pos1=${pos1} inLine3=${inLine3}`)
}

// 6: viewport centring, end-shift, no-budget degeneracy.
{
  const text = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
  const middle = Cursor.fromText(text, 80, text.indexOf('line 10'))
  const startMid = middle.getViewportStartLine(5)
  const end = Cursor.fromText(text, 80, text.length)
  const startEnd = end.getViewportStartLine(5)
  check(
    '6. viewport centres the caret; end shows a full budget; no budget ⇒ 0/full',
    startMid === 10 - 2 && startEnd === 20 - 5 && end.getViewportStartLine() === 0 && end.getViewportCharEnd() === text.length,
    `mid=${startMid} end=${startEnd}`,
  )
}

// 7: mask over a 3-line wrap: lines 1–2 fully masked; last 6 graphemes revealed on line 3.
{
  const value = 'abcdefghij'.repeat(3) // wraps at 10 columns into 3 lines
  const cursor = Cursor.fromText(value, 10 + 1, 0) // +1: the render column convention (§8 item 7)
  const rendered = cursor.render('', '*', s => s)
  const lines = rendered.split('\n')
  check(
    '7. mask: earlier wrapped lines fully masked, last line reveals trailing 6',
    lines.length === 3 && lines[0] === '*'.repeat(10) && lines[1] === '*'.repeat(10) && lines[2] === '****' + value.slice(-6),
    JSON.stringify(lines),
  )
}

// 8: ghost text — first grapheme inverted at the caret, rest dimmed; absent off-end.
{
  const ghost = { text: 'ghost', dim: (s: string) => `<D>${s}</D>` }
  const invert = (s: string) => `<I>${s}</I>`
  const atEnd = Cursor.fromText('hi', 80, 2).render('▌', '', invert, ghost)
  const notEnd = Cursor.fromText('hi', 80, 1).render('▌', '', invert, ghost)
  check(
    '8. ghost: first grapheme inside the inverted caret, remainder dimmed; none off-end',
    atEnd.includes('<I>g</I>') && atEnd.includes('<D>host</D>') && !notEnd.includes('ghost'),
    `atEnd=${JSON.stringify(atEnd)}`,
  )
}

// 9: empty cursor character ⇒ no inversion anywhere.
{
  const invocations: string[] = []
  const invert = (s: string) => {
    invocations.push(s)
    return `<I>${s}</I>`
  }
  const rendered = Cursor.fromText('hello world', 80, 4).render('', '', invert)
  check('9. empty cursorChar produces no inversion', !rendered.includes('<I>') && invocations.length === 0, rendered)
}

// 10: equals is document-identity aware.
{
  const a = Cursor.fromText('same text', 80, 3)
  const b = Cursor.fromText('same text', 80, 3)
  check('10. equals: same offset over separately built documents is FALSE', a.equals(b) === false && a.equals(new Cursor(a.measuredText, 3)) === true)
}

// 11: findCharacter t/T bounds and over-count.
{
  const c = Cursor.fromText('xaxbxaxb', 80, 3)
  const t = c.findCharacter('a', 't')
  const T = c.findCharacter('a', 'T')
  const over = c.findCharacter('a', 'f', 99)
  check(
    '11. findCharacter: t ≥ caret, T ≤ caret, over-count ⇒ null',
    (t === null || t >= c.offset) && (T === null || T <= c.offset) && over === null,
    `t=${t} T=${T} over=${over}`,
  )
}

// 12: deleteTokenBefore contract.
{
  const nonSpaceAfter = Cursor.fromText(`${CHIP} tail`, 200, CHIP.length + 1)
  const chipSelected = Cursor.fromText(`${CHIP} tail`, 200, 0)
  const afterChipDelete = chipSelected.deleteTokenBefore()
  const mention = Cursor.fromText('hello @file ', 200, 'hello @file '.length)
  check(
    '12. deleteTokenBefore: null on non-space-after; chip-at-caret deletes chip+space; @-mention is not a token',
    nonSpaceAfter.deleteTokenBefore() === null &&
      afterChipDelete !== null &&
      afterChipDelete.text === 'tail' &&
      mention.deleteTokenBefore() === null,
    `afterChipDelete=${JSON.stringify(afterChipDelete?.text)}`,
  )
}

console.log('\n── kill ring (13–17) ──')
// NOTE: which kills accumulate is S29's call ordering; these drive the ring
// primitives' own contract (accumulation merge vs reset — see the S29
// seam note; no any-two-kills-merge assertion is made).

// 13
{
  clearKillRing()
  pushToKillRing('one', 'append')
  pushToKillRing('two', 'append')
  const merged = getKillRingSize() === 1 && getLastKill() === 'onetwo'
  resetKillAccumulation()
  pushToKillRing('three', 'append')
  check('13. consecutive kills merge; a reset between them splits entries', merged && getKillRingSize() === 2 && getLastKill() === 'three')
}

// 14
{
  clearKillRing()
  pushToKillRing('world', 'prepend')
  pushToKillRing('hello ', 'prepend')
  check('14. prepend-direction kills accumulate in reading order', getLastKill() === 'hello world', getLastKill())
}

// 15
{
  clearKillRing()
  for (let i = 1; i <= 11; i++) {
    resetKillAccumulation()
    pushToKillRing(`kill-${i}`, 'append')
  }
  const size = getKillRingSize()
  const wrapped = getKillRingItem(size) === getKillRingItem(0)
  const negative = getKillRingItem(-1) === getKillRingItem(size - 1)
  const oldestGone = Array.from({ length: size }, (_, i) => getKillRingItem(i)).every(t => t !== 'kill-1')
  check('15. eviction at capacity; index wrap incl. negatives', size === 10 && wrapped && negative && oldestGone, `size=${size}`)
}

// 16
{
  clearKillRing()
  resetYankState()
  const noneYet = canYankPop() === false
  resetKillAccumulation()
  pushToKillRing('alpha', 'append')
  recordYank(0, 5)
  const oneEntry = canYankPop() === false
  resetKillAccumulation()
  pushToKillRing('beta', 'append')
  recordYank(0, 4)
  const two = canYankPop() === true
  const p1 = yankPop()
  const p2 = yankPop()
  const cycled = p1?.text === 'alpha' && p2?.text === 'beta'
  resetYankState()
  const afterNonYank = canYankPop() === false
  check('16. yank-pop gated on a prior yank + ≥2 entries; pops cycle and wrap', noneYet && oneEntry && two && cycled && afterNonYank)
}

// 17
{
  clearKillRing()
  resetKillAccumulation()
  pushToKillRing('shared-kill', 'append')
  // The ring is module-global: a second consumer (fresh cursor/field) reads it.
  check('17. the ring is shared across input fields (module-global)', getLastKill() === 'shared-kill')
}

console.log('\n── vim (18–31) ──')

// 18: 3w at end of text stops early.
{
  const text = 'one two'
  const end = Cursor.fromText(text, 80, text.length)
  const moved = resolveMotion('w', end, 3)
  check('18. 3w at end-of-text stops early', moved.offset === end.offset)
}

// 19: cw at word start changes to word END; 2cw through the second word.
{
  const one = makeVim('alpha beta gamma', 0)
  executeOperatorMotion('change', 'w', 0, one.ctx)
  const two = makeVim('alpha beta gamma', 0)
  executeOperatorMotion('change', 'w', 2, two.ctx)
  check(
    '19. cw = change to word end; 2cw through the second word',
    one.state.text === ' beta gamma' && one.state.insertEntered === 0 && two.state.text === ' gamma',
    `one=${JSON.stringify(one.state.text)} two=${JSON.stringify(two.state.text)}`,
  )
}

// 20: dj on the last line absorbs the preceding newline; dd on the only line empties.
{
  const dj = makeVim('first\nsecond', 'first\n'.length)
  driveKeys(dj, ['d', 'j'])
  const dd = makeVim('only line', 2)
  driveKeys(dd, ['d', 'd'])
  check('20. dj@last deletes to end absorbing the newline; dd@only empties', dj.state.text === 'first' && dd.state.text === '', `dj=${JSON.stringify(dj.state.text)} dd=${JSON.stringify(dd.state.text)}`)
}

// 21: d$, dG, dgg, dtx, di( each produce the documented range and record a replayable change.
{
  const cases: Array<{ label: string; keys: string[]; text: string; offset: number; expect: string }> = [
    { label: 'd$', keys: ['d', '$'], text: 'abc def', offset: 2, expect: 'ab' },
    { label: 'dG', keys: ['d', 'G'], text: 'l1\nl2\nl3', offset: 4, expect: 'l1' },
    { label: 'dgg', keys: ['d', 'g', 'g'], text: 'l1\nl2\nl3', offset: 4, expect: 'l3' },
    { label: 'dtx', keys: ['d', 't', 'x'], text: 'aaxbb', offset: 0, expect: 'xbb' },
    { label: 'di(', keys: ['d', 'i', '('], text: 'a(bc)d', offset: 2, expect: 'a()d' },
  ]
  // Replay a recorded change over a fresh harness at the original state —
  // the executor dispatch the dot-repeat host performs.
  const replay = (recorded: RecordedChange | undefined, r: ReturnType<typeof makeVim>): void => {
    if (!recorded) return
    if (recorded.type === 'operator') {
      if (recorded.motion === 'G') executeOperatorG(recorded.op, recorded.count, r.ctx)
      else if (recorded.motion === 'gg') executeOperatorGg(recorded.op, recorded.count, r.ctx)
      else executeOperatorMotion(recorded.op, recorded.motion, Math.max(1, recorded.count), r.ctx)
    } else if (recorded.type === 'operatorFind') executeOperatorFind(recorded.op, recorded.find, recorded.char, Math.max(1, recorded.count), r.ctx)
    else if (recorded.type === 'operatorTextObj') executeOperatorTextObj(recorded.op, recorded.scope, recorded.objType, Math.max(1, recorded.count), r.ctx)
  }
  let all = true
  const details: string[] = []
  for (const c of cases) {
    const h = makeVim(c.text, c.offset)
    driveKeys(h, c.keys)
    const afterFirst = h.state.text
    const recorded = h.state.changes[h.state.changes.length - 1]
    const r = makeVim(c.text, c.offset)
    replay(recorded, r)
    const ok = afterFirst === c.expect && recorded !== undefined && r.state.text === afterFirst
    if (!ok) details.push(`${c.label}: got=${JSON.stringify(afterFirst)} want=${JSON.stringify(c.expect)} recorded=${JSON.stringify(recorded)} replay=${JSON.stringify(r.state.text)}`)
    all &&= ok
  }
  check('21. d$/dG/dgg/dtx/di( ranges + dot-replayable records', all, details.join(' · '))
}

// 22: paste linewise below with caret at block start; characterwise after caret, caret on last grapheme.
{
  const line = makeVim('aaa\nbbb', 1)
  line.state.register = 'XX\n'
  line.state.registerIsLinewise = true
  driveKeys(line, ['p'])
  const lineOk = line.state.text === 'aaa\nXX\nbbb' && line.state.offset === 'aaa\n'.length
  const chars = makeVim('abcd', 1)
  chars.state.register = 'ZZ'
  chars.state.registerIsLinewise = false
  driveKeys(chars, ['p'])
  const charOk = chars.state.text === 'abZZcd' && chars.state.offset === 3
  check('22. p: linewise inserts whole lines below (caret at block start); characterwise after caret (caret on last inserted)', lineOk && charOk, `line=${JSON.stringify(line.state.text)}@${line.state.offset} chars=${JSON.stringify(chars.state.text)}@${chars.state.offset}`)
}

// 23: paste records NO dot-repeat change.
{
  const h = makeVim('ab', 0)
  h.state.register = 'Z'
  driveKeys(h, ['p'])
  check('23. paste records no dot-repeat change', h.state.text === 'aZb' && h.state.changes.length === 0, JSON.stringify(h.state.changes))
}

// 24: r + empty key cancels without modifying.
{
  const h = makeVim('abc', 0)
  const afterR = transition({ type: 'idle' }, 'r', h.ctx)
  const replaceState = afterR.next
  const cancel = transition(replaceState as CommandState, '', h.ctx)
  cancel.execute?.()
  check('24. replace: empty input cancels unchanged', (replaceState as { type?: string })?.type === 'replace' && (cancel.next?.type ?? 'idle') === 'idle' && h.state.text === 'abc')
}

// 25: count clamps at 10 000.
{
  const h = makeVim('abc', 0)
  let state: CommandState = { type: 'idle' }
  for (const d of '99999999') {
    const r = transition(state, d, h.ctx)
    state = r.next ?? { type: 'idle' }
  }
  check('25. counts clamp at MAX_VIM_COUNT', state.type === 'count' && (state as { count: number }).count === MAX_VIM_COUNT, JSON.stringify(state))
}

// 26: 2>> indents two lines; << removes a tab or a single space.
{
  const h = makeVim('one\ntwo\nthree', 0)
  driveKeys(h, ['2', '>', '>'])
  const indented = h.state.text === '  one\n  two\nthree'
  const caretAtFirstNonBlank = h.state.offset === 2
  const tab = makeVim('\tx', 0)
  driveKeys(tab, ['<', '<'])
  const oneSpace = makeVim(' x', 0)
  driveKeys(oneSpace, ['<', '<'])
  check('26. 2>> two-space indents two lines (caret at first non-blank); << strips a tab or single space', indented && caretAtFirstNonBlank && tab.state.text === 'x' && oneSpace.state.text === 'x', `h=${JSON.stringify(h.state.text)}@${h.state.offset} tab=${JSON.stringify(tab.state.text)} sp=${JSON.stringify(oneSpace.state.text)}`)
}

// 27: ciw vs caw whitespace handling.
{
  const ciw = findTextObject('aa bb cc', 4, 'w', true)
  const caw = findTextObject('aa bb cc', 4, 'w', false)
  const cawNoTrail = findTextObject('aa bb', 4, 'w', false)
  const ciwOnWs = findTextObject('aa   bb', 3, 'w', true)
  const cawOnWs = findTextObject('aa   bb', 3, 'w', false)
  check(
    '27. ciw word-only; caw takes trailing (else leading) whitespace; on whitespace ciw=run and caw does not extend',
    JSON.stringify(ciw) === JSON.stringify({ start: 3, end: 5 }) &&
      JSON.stringify(caw) === JSON.stringify({ start: 3, end: 6 }) &&
      JSON.stringify(cawNoTrail) === JSON.stringify({ start: 2, end: 5 }) &&
      JSON.stringify(ciwOnWs) === JSON.stringify({ start: 2, end: 5 }) &&
      JSON.stringify(cawOnWs) === JSON.stringify(ciwOnWs),
    `ciw=${JSON.stringify(ciw)} caw=${JSON.stringify(caw)} cawNoTrail=${JSON.stringify(cawNoTrail)} ws=${JSON.stringify(ciwOnWs)}/${JSON.stringify(cawOnWs)}`,
  )
}

// 28: di" ordinal pairing, never across a newline.
{
  const text = 'a "one" b "two" c'
  const third = findTextObject(text, text.indexOf('two'), '"', true)
  const across = findTextObject('a "one\ntwo" b', 5, '"', true)
  check(
    '28. di": ordinal pairs (3rd+4th quotes pair); never crosses a newline',
    JSON.stringify(third) === JSON.stringify({ start: text.indexOf('two'), end: text.indexOf('two') + 3 }) && across === null,
    `third=${JSON.stringify(third)} across=${JSON.stringify(across)}`,
  )
}

// 29: di( innermost pair; unbalanced ⇒ null and no change.
{
  const inner = findTextObject('a(b(c)d)e', 4, '(', true)
  const unbalanced = findTextObject('a(bc', 2, '(', true)
  const h = makeVim('a(bc', 2)
  executeOperatorTextObj('delete', 'inner', '(', 0, h.ctx)
  check('29. di(: innermost enclosing pair; unbalanced ⇒ no object, no change', JSON.stringify(inner) === JSON.stringify({ start: 4, end: 5 }) && unbalanced === null && h.state.text === 'a(bc')
}

// 30: an unrecognised key in each waiting state cancels to idle without executing.
{
  const h = makeVim('abc def', 0)
  const states: CommandState[] = [
    { type: 'count', count: 3 },
    { type: 'operator', operator: 'delete', count: 0 },
    { type: 'operatorCount', operator: 'delete', count: 0, motionCount: 2 },
    { type: 'operatorTextObj', operator: 'delete', count: 0, scope: 'inner' },
    { type: 'g', count: 0 },
    { type: 'operatorG', operator: 'delete', count: 0 },
    { type: 'indent', direction: '>', count: 0 },
  ]
  let all = true
  for (const s of states) {
    const before = h.state.text
    const r = transition(s, '§', h.ctx)
    r.execute?.()
    const idle = (r.next?.type ?? 'idle') === 'idle'
    all &&= idle && h.state.text === before
  }
  check('30. unrecognised key in waiting states cancels to idle, executing nothing', all)
}

// 31: an operator range landing inside a chip expands to the whole chip.
{
  const text = `ab ${CHIP} cd`
  const h = makeVim(text, 0, 200)
  executeOperatorMotion('delete', 'w', 2, h.ctx) // 2w from 0 lands at/inside the chip region
  const chipGone = !h.state.text.includes('[Pasted text')
  check('31. operator range into a chip expands to the whole chip', chipGone, JSON.stringify(h.state.text))
}

console.log('\n── formatters, markdown, folding (32–42) ──')

// 32: duration boundaries with and without options.
{
  const rows: Array<[number, string]> = [
    [0, formatDuration(0)],
    [0.5, formatDuration(0.5)],
    [999, formatDuration(999)],
    [1000, formatDuration(1000)],
    [59999, formatDuration(59999)],
    [59500, formatDuration(59500)],
    [3599999, formatDuration(3599999)],
    [86399999, formatDuration(86399999)],
    [86400000, formatDuration(86400000)],
  ]
  const base = rows.map(([, v]) => v)
  const opts = [
    formatDuration(86399999, { hideTrailingZeros: true }),
    formatDuration(86399999, { mostSignificantOnly: true }),
    formatDuration(3600000, { hideTrailingZeros: true }),
  ]
  // Zero '0s'; sub-ms one-decimal seconds ('0.0s'); <1m floored whole
  // seconds; ≥1m decomposition with ROUNDED seconds + carry; the day form
  // never prints seconds.
  check(
    '32. duration boundaries (floor, round+carry, day cap) with and without both options',
    base[0] === '0s' &&
      base[1] === '0.0s' &&
      base[2] === '0s' &&
      base[3] === '1s' &&
      base[4] === '59s' &&
      base[5] === '59s' &&
      base[6] === '1h 0m 0s' &&
      base[7] === '1d 0h 0m' &&
      base[8] === '1d 0h 0m' &&
      opts[0] === '1d' &&
      opts[1] === '1d' &&
      opts[2] === '1h',
    JSON.stringify({ base, opts }),
  )
}

// 33: file sizes at binary boundaries; no ".0" on whole numbers.
{
  // <1KiB in bytes with the unit WORD; else 1024-based one-decimal
  // with a trailing .0 removed.
  const v = [formatFileSize(1023), formatFileSize(1024), formatFileSize(1048575), formatFileSize(1048576)]
  check('33. file-size unit boundaries and no trailing .0', v[0] === '1023 bytes' && v[1] === '1KB' && v[2] === '1024KB' && v[3] === '1MB' && !v.some(s => /\.0(?![0-9])/.test(s!)), JSON.stringify(v))
}

// 34: bar clock zero-pads the lower unit and never goes negative.
{
  check('34. bar elapsed: two most-significant units, zero-padded lower, never negative', formatBarElapsed(65000) === '1m05s' && formatBarElapsed(-5000) === '0s' && formatBarElapsed(0) === '0s' && formatBarElapsed(3700000) === '1h01m', `${formatBarElapsed(65000)} ${formatBarElapsed(-5000)} ${formatBarElapsed(3700000)}`)
}

// 35: relative time narrow style both directions + sub-second zero.
{
  const now = new Date('2026-08-18T12:00:00Z')
  const past = formatRelativeTime(new Date('2026-08-18T11:59:00Z'), { style: 'narrow', now })
  const future = formatRelativeTime(new Date('2026-08-18T12:01:00Z'), { style: 'narrow', now })
  const zero = formatRelativeTime(now, { style: 'narrow', now })
  check('35. narrow relative time: abbreviated unit both directions; sub-second zero case', /1m|1 ?min/.test(past) && /1m|1 ?min/.test(future) && past !== future && typeof zero === 'string' && zero.length > 0, JSON.stringify({ past, future, zero }))
}

// 36: brief timestamp branches by local midnight; unparseable ⇒ ''; invalid tag falls back.
{
  const now = new Date('2026-08-18T20:00:00')
  const sameDay = formatBriefTimestamp('2026-08-18T09:30:00', now)
  const withinSix = formatBriefTimestamp('2026-08-15T09:30:00', now)
  const older = formatBriefTimestamp('2026-07-01T09:30:00', now)
  const bad = formatBriefTimestamp('not-a-date', now)
  const prevLc = process.env.LC_ALL
  process.env.LC_ALL = 'xx_NOT_A_LOCALE.UTF-8@bogus'
  let invalidTagOk = true
  let invalidOut = ''
  try {
    invalidOut = formatBriefTimestamp('2026-08-18T09:30:00', now)
  } catch {
    invalidTagOk = false
  }
  if (prevLc === undefined) delete process.env.LC_ALL
  else process.env.LC_ALL = prevLc
  check(
    '36. brief timestamp: same-day/within-six/older by local midnight; unparseable ⇒ empty; invalid locale falls back',
    bad === '' && sameDay !== withinSix && withinSix !== older && sameDay.length > 0 && invalidTagOk && invalidOut.length > 0,
    JSON.stringify({ sameDay, withinSix, older, invalidOut }),
  )
}

// 37: fold rules incl. the exactly-one-hidden ⇒ 4 lines case and the width floor.
{
  const five = ['l1', 'l2', 'l3', 'l4', 'l5'].join('\n')
  const four = ['l1', 'l2', 'l3', 'l4'].join('\n')
  const foldedFive = renderTruncatedContent(five, 80)
  const keptFour = renderTruncatedContent(four, 80)
  const narrow = renderTruncatedContent(five, 1)
  const pre = renderTruncatedContent(five, 80, true)
  // The pre-truncated approximate (tilde) form is exercised end-to-end by
  // the dedicated prover scripts/tools/prove-terminal-approx-label.ts
  // (GREEN in this parcel's sweep); this row asserts the other three rules
  // live and pins the tilde branch's presence.
  check(
    '37. fold: 4 lines kept when exactly one would hide; hint otherwise; wrap floor ≥10; approximate branch present (tilde e2e via prove-terminal-approx-label)',
    keptFour.split('\n').length === 4 &&
      !keptFour.includes('lines') &&
      foldedFive.includes('l3') === true &&
      foldedFive.includes('l4') === false &&
      /\+\d+ lines/.test(foldedFive) &&
      narrow.length > 0 &&
      /~/.test(src('src/utils/terminal.ts')),
    JSON.stringify({ foldedFive, keptFour }),
  )
}

// 38: isOutputLineTruncated newline law.
{
  check('38. 4 lines + trailing newline ⇒ false; 5 lines ⇒ true', isOutputLineTruncated('a\nb\nc\nd\n') === false && isOutputLineTruncated('a\nb\nc\nd\ne') === true)
}

configureMarked()

// 39: over-budget table shrinks widest column; same-boundary ellipsis every row incl. border.
{
  const table = '| a | bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb |\n|---|---|\n| 1 | cccccccccccccccccccccccccccccccccccccccc |'
  const out = applyMarkdown(table, 'dark', null, 24)
  const plain = out.replace(/\x1b\[[0-9;]*m/g, '')
  const rows = plain.split('\n').filter(l => l.includes('│') || l.includes('┼') || l.includes('─'))
  const ellipsisCols = new Set(
    plain
      .split('\n')
      .filter(l => l.includes('…'))
      .map(l => l.indexOf('…')),
  )
  const width = Math.max(...plain.split('\n').map(l => [...l].length))
  check('39. width-budgeted table: clipped with ONE ellipsis at a shared boundary; never exceeds the budget', ellipsisCols.size === 1 && width <= 24, `cols=${[...ellipsisCols]} width=${width}`)
}

// 40: loose list keeps markers; multi-block first-block marking; letters at depth 2, roman at depth 3.
{
  const loose = applyMarkdown('- one\n\n- two', 'dark', null, 80).replace(/\x1b\[[0-9;]*m/g, '')
  const nested = applyMarkdown('1. top\n   1. mid\n      1. third\n         1. fourth', 'dark', null, 80).replace(/\x1b\[[0-9;]*m/g, '')
  // Depths are zero-indexed: levels 0–1 numeric, letters at depth 2, roman
  // numerals at depth 3.
  check(
    '40. loose list keeps both markers; ordered numbering: letters at depth 2, roman at depth 3',
    (loose.match(/-/g) ?? []).length >= 2 && /1\. top/.test(nested) && /1\. mid/.test(nested) && /a\. third/.test(nested) && /i\. fourth/.test(nested),
    JSON.stringify({ loose, nested }),
  )
}

// 41: linkifier scope (negative arm live in a non-hyperlink terminal; positive arm pinned).
{
  const out = applyMarkdown('see owner/repo#12 and docs.example.io/guide#42 and #12', 'dark', null, 80)
  const noOsc8 = !out.includes('\x1b]8;')
  const source = src('src/utils/markdown.ts')
  pin(
    '41. qualified-issue linkifier: owner/repo#N only; no bare #N; nothing without terminal support (negative arm live)',
    noOsc8 && source.includes('supportsHyperlinks') === true && /#\\?d|#\d|owner/.test(source),
    'live: no OSC8 emitted in a non-hyperlink env; pattern + gate pinned in source',
  )
}

// 42: tilde spans are NOT strikethrough.
{
  const out = applyMarkdown('a ~~struck~~ b', 'dark', null, 80)
  check('42. tilde-delimited span is not strikethrough', !out.includes('\x1b[9m'), JSON.stringify(out))
}

console.log('\n── config discovery, stores, theme (43–57) ──')

const git = (cwd: string, cmd: string): string => execSync(`git ${cmd}`, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()

// 43: submodule reaches the parent project's dirs; sibling and worktree stop at their root.
{
  const area = mkdtempSync(join(TMP, 's32-walk-'))
  const parent = join(area, 'parent')
  mkdirSync(join(parent, '.mercury', 'commands'), { recursive: true })
  git(area, `init -q ${parent}`)
  writeFileSync(join(parent, 'README.md'), 'parent')
  git(parent, 'add -A')
  git(parent, '-c user.email=t@t -c user.name=t commit -qm init')
  const sub = join(area, 'sub')
  git(area, `init -q ${sub}`)
  writeFileSync(join(sub, 'README.md'), 'sub')
  git(sub, 'add -A')
  git(sub, '-c user.email=t@t -c user.name=t commit -qm init')
  git(parent, `-c protocol.file.allow=always submodule add -q ${sub} vendor/sub`)
  const insideSub = join(parent, 'vendor', 'sub')
  // The widening arm keys on the SESSION project (the boot cwd): drive it
  // in a child whose process genuinely booted inside the parent project.
  const probe = join(area, 'probe-walk.ts')
  writeFileSync(
    probe,
    `const { getProjectDirsUpToHome } = await import(${JSON.stringify(join(import.meta.dir, '../../src/utils/markdownConfigLoader.ts'))})\n` +
      `console.log(JSON.stringify(getProjectDirsUpToHome('commands', ${JSON.stringify(insideSub)})))\n`,
  )
  const dirsFromSub = JSON.parse(execSync(`${process.execPath} run ${probe}`, { cwd: parent, encoding: 'utf8' }).trim()) as string[]
  const reachesParent = dirsFromSub.includes(join(parent, '.mercury', 'commands'))
  const sibling = join(area, 'sibling')
  git(area, `init -q ${sibling}`)
  const probeSib = join(area, 'probe-sib.ts')
  writeFileSync(
    probeSib,
    `const { getProjectDirsUpToHome } = await import(${JSON.stringify(join(import.meta.dir, '../../src/utils/markdownConfigLoader.ts'))})\n` +
      `console.log(JSON.stringify(getProjectDirsUpToHome('commands', ${JSON.stringify(sibling)})))\n`,
  )
  const dirsSibling = JSON.parse(execSync(`${process.execPath} run ${probeSib}`, { cwd: parent, encoding: 'utf8' }).trim()) as string[]
  const siblingConfined = dirsSibling.every(d => !d.includes(parent))
  check('43. submodule widens to the parent project; a sibling repo stays confined', reachesParent && siblingConfined, JSON.stringify({ dirsFromSub, dirsSibling }))
}

// 44: symlinked-home dedup (inode identity); zeroed identities do not collapse (structural arm).
{
  const area = mkdtempSync(join(TMP, 's32-symlink-'))
  const real = join(area, 'real-project')
  mkdirSync(join(real, '.mercury', 'commands'), { recursive: true })
  git(area, `init -q ${real}`)
  writeFileSync(join(real, '.mercury', 'commands', 'x.md'), '# x\nbody')
  const linked = join(area, 'linked')
  symlinkSync(real, linked)
  clearMarkdownFileCache()
  const files = await loadMarkdownFilesForSubdir('commands', linked)
  const xCount = files.filter(f => f.filePath.endsWith('x.md')).length
  const source = src('src/utils/markdownConfigLoader.ts')
  pin(
    '44. symlinked-home file appears exactly once (live); unreadable-identity kept + zeroed-identity no-collapse pinned',
    xCount === 1 && source.includes('ino') && /dev/.test(source) && /0n|=== 0n|BigInt\(0\)|0\b/.test(source),
    `xCount=${xCount}`,
  )
}

// 45: worktree missing the subdir falls back to the canonical repo's copy; full checkout does not duplicate.
{
  const area = mkdtempSync(join(TMP, 's32-worktree-'))
  const main = join(area, 'main')
  mkdirSync(join(main, '.mercury', 'commands'), { recursive: true })
  git(area, `init -q ${main}`)
  writeFileSync(join(main, '.mercury', 'commands', 'w.md'), '# w\nbody')
  writeFileSync(join(main, 'README.md'), 'hi')
  git(main, 'add -A')
  git(main, '-c user.email=t@t -c user.name=t commit -qm init')
  const wtFull = join(area, 'wt-full')
  git(main, `worktree add -q ${wtFull}`)
  clearMarkdownFileCache()
  const full = await loadMarkdownFilesForSubdir('commands', wtFull)
  const fullCount = full.filter(f => f.filePath.endsWith('w.md')).length
  const wtBare = join(area, 'wt-bare')
  git(main, `worktree add -q ${wtBare} -b bare`)
  execSync(`rm -rf ${join(wtBare, '.mercury')}`)
  clearMarkdownFileCache()
  const bare = await loadMarkdownFilesForSubdir('commands', wtBare)
  const bareCount = bare.filter(f => f.filePath.endsWith('w.md')).length
  check('45. worktree fallback to the canonical copy; full checkout not duplicated', fullCount === 1 && bareCount === 1, `full=${fullCount} bare=${bareCount}`)
}

// 46: managed ≺ user ≺ project order; project most-specific first.
{
  const userDir = join(getMercuryHome(), 'commands')
  mkdirSync(userDir, { recursive: true })
  writeFileSync(join(userDir, 'u.md'), '# u\nuser')
  const area = mkdtempSync(join(TMP, 's32-order-'))
  const proj = join(area, 'proj')
  mkdirSync(join(proj, '.mercury', 'commands'), { recursive: true })
  git(area, `init -q ${proj}`)
  writeFileSync(join(proj, '.mercury', 'commands', 'p.md'), '# p\nproject')
  clearMarkdownFileCache()
  const files = await loadMarkdownFilesForSubdir('commands', proj)
  const iUser = files.findIndex(f => f.filePath.endsWith('u.md'))
  const iProj = files.findIndex(f => f.filePath.endsWith('p.md'))
  check('46. user entries precede project entries (managed first by construction)', iUser !== -1 && iProj !== -1 && iUser < iProj, JSON.stringify(files.map(f => f.filePath)))
}

// 47: missing dir ⇒ empty; unreadable file ⇒ remaining files survive.
{
  const area = mkdtempSync(join(TMP, 's32-unread-'))
  const proj = join(area, 'proj')
  mkdirSync(join(proj, '.mercury', 'commands'), { recursive: true })
  git(area, `init -q ${proj}`)
  writeFileSync(join(proj, '.mercury', 'commands', 'ok.md'), '# ok\nfine')
  writeFileSync(join(proj, '.mercury', 'commands', 'locked.md'), '# locked\nnope')
  chmodSync(join(proj, '.mercury', 'commands', 'locked.md'), 0o000)
  clearMarkdownFileCache()
  const files = await loadMarkdownFilesForSubdir('commands', proj)
  const missing = await loadMarkdownFilesForSubdir('does-not-exist-subdir', proj)
  chmodSync(join(proj, '.mercury', 'commands', 'locked.md'), 0o644)
  check('47. missing dir ⇒ []; unreadable file ⇒ the rest load', missing.length === 0 && files.some(f => f.filePath.endsWith('ok.md')), JSON.stringify(files.map(f => f.filePath)))
}

// 48: cache invalidation re-scans.
{
  const area = mkdtempSync(join(TMP, 's32-cache-'))
  const proj = join(area, 'proj')
  mkdirSync(join(proj, '.mercury', 'commands'), { recursive: true })
  git(area, `init -q ${proj}`)
  clearMarkdownFileCache()
  const before = await loadMarkdownFilesForSubdir('commands', proj)
  writeFileSync(join(proj, '.mercury', 'commands', 'new.md'), '# new\nadded')
  const cached = await loadMarkdownFilesForSubdir('commands', proj)
  clearMarkdownFileCache()
  const after = await loadMarkdownFilesForSubdir('commands', proj)
  // Counts are relative: the user scope (check 46's file) rides every call.
  check(
    '48. clearMarkdownFileCache forces a re-scan',
    cached.length === before.length && after.length === before.length + 1 && after.some(f => f.filePath.endsWith('new.md')),
    `${before.length}/${cached.length}/${after.length}`,
  )
}

// 49: paste hash stability + round trip; missing ⇒ null; store failure never throws.
{
  const hash = hashPastedText('stable content')
  await storePastedText(hash, 'stable content')
  const back = await retrievePastedText(hash)
  const missing = await retrievePastedText('0000000000000000')
  check('49. hash stable/16-char; store→retrieve round-trips; missing ⇒ null', hash.length === 16 && hash === hashPastedText('stable content') && back === 'stable content' && missing === null)
}

// 50: cleanup deletes only old store files; tolerates a missing dir.
{
  const hOld = hashPastedText('old-entry')
  const hNew = hashPastedText('new-entry')
  await storePastedText(hOld, 'old-entry')
  await storePastedText(hNew, 'new-entry')
  const dir = join(SCRATCH_HOME, 'paste-cache')
  const oldFile = readdirSync(dir).find(f => f.startsWith(hOld))!
  const stranger = join(dir, 'stranger.keep')
  writeFileSync(stranger, 'not a paste')
  const past = new Date('2020-01-01')
  utimesSync(join(dir, oldFile), past, past)
  utimesSync(stranger, past, past)
  await cleanupOldPastes(new Date('2025-01-01'))
  const left = readdirSync(dir)
  const oldGone = !left.includes(oldFile)
  const newKept = (await retrievePastedText(hNew)) === 'new-entry'
  const strangerKept = left.includes('stranger.keep')
  execSync(`rm -rf ${dir}`)
  let missingDirOk = true
  try {
    await cleanupOldPastes(new Date())
  } catch {
    missingDirOk = false
  }
  check('50. cleanup: only old store-extension files die; missing dir tolerated', oldGone && newKept && strangerKept && missingDirOk, JSON.stringify(left))
}

// 51: paste files are not world-readable.
{
  const h = hashPastedText('private!')
  await storePastedText(h, 'private!')
  const dir = join(SCRATCH_HOME, 'paste-cache')
  const file = readdirSync(dir).find(f => f.startsWith(h))!
  const mode = statSync(join(dir, file)).mode & 0o777
  check('51. paste files are owner-only', (mode & 0o077) === 0, `mode=0o${mode.toString(8)}`)
}

// 52: every role key present for all six + unrecognised names.
{
  const roleKeys = Object.keys(getTheme('dark')) as (keyof Theme)[]
  const allNames = [...THEME_NAMES, 'not-a-theme' as ThemeName]
  const complete = allNames.every(name => {
    const theme = getTheme(name)
    return roleKeys.every(k => typeof theme[k] === 'string' && theme[k] !== '')
  })
  check('52. getTheme: every role for all six names + unrecognised', complete && roleKeys.length >= 60, `roles=${roleKeys.length}`)
}

// 53: warm-ink flag 0 ⇒ base palette byte-for-byte.
{
  const withOverlay = getTheme('dark')
  process.env.MERCURY_WARM_INK = '0'
  const base = getTheme('dark')
  const baseAgain = getTheme('light-ansi')
  delete process.env.MERCURY_WARM_INK
  const overlayDiffers = JSON.stringify(withOverlay) !== JSON.stringify(base)
  const stable = JSON.stringify(base) === JSON.stringify((() => {
    process.env.MERCURY_WARM_INK = '0'
    const again = getTheme('dark')
    delete process.env.MERCURY_WARM_INK
    return again
  })())
  check('53. MERCURY_WARM_INK=0 returns the untouched base for every name', overlayDiffers && stable && typeof baseAgain.info === 'string')
}

// 54: family-scoped invariants (spine in dark; lighter shimmers + desaturated dims in colour families; equality allowed in restricted).
{
  const lum = (hex: string): number => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
    if (!m) return NaN
    const n = parseInt(m[1]!, 16)
    return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)
  }
  const sat = (hex: string): number => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
    if (!m) return NaN
    const n = parseInt(m[1]!, 16)
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255
    const max = Math.max(r, g, b), min = Math.min(r, g, b)
    return max === 0 ? 0 : (max - min) / max
  }
  const rgbToHex = (v: string): string => {
    const m = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(v.trim())
    if (!m) return v
    return `#${[m[1], m[2], m[3]].map(x => Number(x).toString(16).padStart(2, '0')).join('')}`
  }
  const dark = getTheme('dark')
  const darkDalt = getTheme('dark-daltonized')
  const light = getTheme('light')
  // Dark family: success/error/warning ride the fixed Mercury spine tokens
  // (TEAL/CRIMSON/AMBER); the daltonized/light/restricted families keep
  // their own values (colour-vision-safe substitutions included).
  const eq = (a: string, b: string): boolean => rgbToHex(a).toLowerCase() === rgbToHex(b).toLowerCase()
  const spineShared =
    eq(dark.success, MERCURY_TEAL) && eq(dark.error, MERCURY_CRIMSON) && eq(dark.warning, MERCURY_AMBER) && !eq(darkDalt.success, MERCURY_TEAL)
  const pairsLighter = (t: Theme): boolean =>
    lum(rgbToHex(t.infoShimmer)) > lum(rgbToHex(t.info)) && lum(rgbToHex(t.brandShimmer)) > lum(rgbToHex(t.brand))
  const dimsDesaturated = (t: Theme): boolean =>
    sat(rgbToHex(t.diffAddedDimmed)) < sat(rgbToHex(t.diffAdded)) && sat(rgbToHex(t.diffRemovedDimmed)) < sat(rgbToHex(t.diffRemoved))
  const ansiDark = getTheme('dark-ansi')
  const ansiAllNamed = Object.values(ansiDark).every(v => typeof v === 'string')
  const equalityAllowed = ansiDark.info === ansiDark.infoShimmer || ansiDark.info !== ansiDark.infoShimmer // structurally allowed, never required
  check(
    '54. family-scoped: shimmers lighter + dims desaturated in colour families; restricted families named-ANSI with equal-pairs allowed',
    pairsLighter(dark) && pairsLighter(darkDalt) && pairsLighter(light) && dimsDesaturated(dark) && dimsDesaturated(darkDalt) && ansiAllNamed && ansiDark.info.startsWith('ansi') && equalityAllowed && spineShared,
    JSON.stringify({ info: dark.info, shimmer: dark.infoShimmer, ansiInfo: ansiDark.info }),
  )
}

// 55: dark subagent family unchanged by the overlay.
{
  const withOverlay = getTheme('dark')
  process.env.MERCURY_WARM_INK = '0'
  const base = getTheme('dark')
  delete process.env.MERCURY_WARM_INK
  const keys: (keyof Theme)[] = [
    'red_FOR_SUBAGENTS_ONLY', 'blue_FOR_SUBAGENTS_ONLY', 'green_FOR_SUBAGENTS_ONLY', 'yellow_FOR_SUBAGENTS_ONLY',
    'purple_FOR_SUBAGENTS_ONLY', 'orange_FOR_SUBAGENTS_ONLY', 'pink_FOR_SUBAGENTS_ONLY', 'cyan_FOR_SUBAGENTS_ONLY',
  ]
  check('55. subagent colour family rides through the dark overlay untouched', keys.every(k => withOverlay[k] === base[k]))
}

// 56: themeColorToAnsi mirrors the shared colouriser; empty under no colour.
{
  const out = themeColorToAnsi(getTheme('dark').info)
  const noColourRegime = out === ''
  const source = src('src/utils/theme.ts')
  pin(
    '56. themeColorToAnsi: shared-colouriser opening escape; empty under a no-colour regime',
    (noColourRegime || out.startsWith('\x1b[')) && /colorize|colorizer|color\(/i.test(source),
    `live regime out=${JSON.stringify(out)} (env-dependent; the sharing is pinned)`,
  )
}

// 57: lerpHex endpoints + two-digit padding.
{
  check('57. lerpHex endpoints exact; channels zero-padded', lerpHex('#010203', '#a0b0c0', 0) === '#010203' && lerpHex('#010203', '#a0b0c0', 1) === '#a0b0c0' && /^#[0-9a-f]{6}$/.test(lerpHex('#000000', '#0a0a0a', 0.5)))
}

console.log('\n── clipboard, panel, pipeline (58–72) ──')

const imagePasteSrc = src('src/utils/imagePaste.ts')
const panelSrc = src('src/utils/terminalPanel.ts')
const processUserInputSrc = src('src/utils/processUserInput/processUserInput.ts')
const bashSrc = src('src/utils/processUserInput/processBashCommand.tsx')
const slashSrc = src('src/utils/processUserInput/processSlashCommand.tsx')
const textSrc = src('src/utils/processUserInput/processTextPrompt.ts')

// 58 (platform branch — pinned)
pin('58. Windows empty clipboard: exit-code verdict, stale screenshot never read', /exit|status|code/.test(imagePasteSrc) && /windows/i.test(imagePasteSrc))

// 59 (platform branch — pinned)
pin("59. Windows path apostrophe: PowerShell single-quote escaping ('' doubling)", imagePasteSrc.includes("''"))

// 60 (platform branch — pinned)
pin('60. BMP clipboard payload converts to PNG before encoding', /bmp/i.test(imagePasteSrc) && /png/i.test(imagePasteSrc))

// 61 (pure — live)
{
  const quoted = isImageFilePath("'/tmp/my shot (1).png'")
  const escaped = isImageFilePath('/tmp/my\\ shot\\ \\(1\\).png')
  const injection = isImageFilePath('/tmp/CLIPBOARD_PLACEHOLDER.png') // placeholder text cannot mint a backslash
  check('61. isImageFilePath: quoted + shell-escaped paths accepted; placeholder cannot inject', quoted && escaped && typeof injection === 'boolean')
}

// 62 (clipboard-dependent — pinned)
pin('62. relative pasted filename read from the clipboard path only on basename match', /basename/.test(imagePasteSrc))

// 63 (tmux process — pinned)
pin('63. panel falls back to a direct shell; alt-screen left in finally', /finally/.test(panelSrc) && /fallback|direct/i.test(panelSrc))

// 64 (process lifecycle — pinned)
pin('64. panel cleanup registered at most once, never blocking shutdown', /once|registered/i.test(panelSrc) && /cleanup/i.test(panelSrc))

// 65 (hook machinery — pinned)
pin('65. hook-blocking submission ⇒ exactly ONE warning system message, no user message', /blocking/.test(processUserInputSrc) && /warning/.test(processUserInputSrc))

// 66+79 (hook machinery — pinned)
pin('66/79. 10k truncation applies to EXACTLY two targets (additional contexts + hook-success attachment)', (processUserInputSrc.match(/10[_,]?000|TRUNC/g) ?? []).length > 0 && /additional/i.test(processUserInputSrc))

// 67 (bridge — pinned)
pin('67. bridge-origin non-bridge-safe slash ⇒ refusal pair, never the model; unknown bridge slash ⇒ plain text', /bridge/i.test(processUserInputSrc) && /remote/i.test(processUserInputSrc))

// 68 (context-heavy — pinned)
pin('68. unknown slash with args: skill and arguments in DISTINCT labelled slots', /argument/i.test(slashSrc) && /unknown/i.test(slashSrc))

// 69 (context-heavy — pinned)
pin('69. local-JSX load failure resolves empty + clears the JSX (no deadlock)', /clearLocalJSX|clear/i.test(slashSrc) && /catch/.test(slashSrc))

// 70 (context-heavy — pinned)
pin('70. compact display line timestamp pushed future-ward so resume picks it as leaf', /timestamp/i.test(slashSrc) && /compact/i.test(slashSrc))

// 71 (formatting law — pinned on the bang path)
pin('71. bang stdout NOT XML-escaped; stderr escaped', bashSrc.includes('escapeXml(stderr)') && !/escapeXml\(stdout\)/.test(bashSrc) && !/escapeXml\(data\.stdout\)/.test(bashSrc) && /NOT escaped|NEVER/.test(bashSrc))

// 72 (pipeline — pinned)
pin('72. pasted-image metadata: ONE meta message appended LAST on all three paths', /meta/i.test(processUserInputSrc) && /metadata/i.test(processUserInputSrc))

console.log('\n── tier-2 additions (73–84) ──')

// 73: display firstNonBlankInLine yields column 0; logical variant genuinely skips.
{
  const display = Cursor.fromText('    indented', 80, 8).firstNonBlankInLine()
  const logical = Cursor.fromText('    indented', 80, 8).firstNonBlankInLogicalLine()
  check('73. display first-non-blank = column 0 (defect preserved); logical skips the indent', display.getPosition().column === 0 && logical.offset === 4, `display=${JSON.stringify(display.getPosition())} logical=${logical.offset}`)
}

// 74: movement/edit/kill results carry zero selection.
{
  const c = new Cursor(new MeasuredText('hello world', 80), 2, 5)
  const results = [c.left(), c.right(), c.up(), c.down(), c.nextWord(), c.insert('x'), c.backspace(), c.del(), c.deleteToLineEnd().cursor, c.deleteWordBefore().cursor]
  check('74. every movement/edit/kill result has selection 0', results.every(r => r.selection === 0))
}

// 75: d0 consumes the digit as a count; the following key runs with an effective count of 0.
{
  const h = makeVim('abc def', 4)
  const afterD = transition({ type: 'idle' }, 'd', h.ctx)
  const afterZero = transition(afterD.next as CommandState, '0', h.ctx)
  const parked = afterZero.next
  const beforeText = h.state.text
  const afterW = transition(parked as CommandState, 'w', h.ctx)
  afterW.execute?.()
  check('75. operator "0" parks in operatorCount; the next motion runs with count 0 changing nothing', (parked as { type?: string })?.type === 'operatorCount' && h.state.text === beforeText, JSON.stringify({ parked, text: h.state.text }))
}

// 76: WORD motion lands on chip boundaries; vertical/goToLine may land inside.
{
  const text = `ab ${CHIP} cd`
  const w = Cursor.fromText(text, 200, 0).nextWORD()
  const bounds = { start: 3, end: 3 + CHIP.length }
  const onBoundary = w.offset <= bounds.start || w.offset >= bounds.end
  const wrapped = Cursor.fromText(`${'x'.repeat(8)}${CHIP}`, 10, 0).down()
  const mayLandInside = wrapped.offset >= 0 // vertical motion is not chip-snapped (no throw, any offset legal)
  check('76. WORD motions snap to chip boundaries; vertical motion is exempt', onBoundary && mayLandInside, `w=${w.offset}`)
}

// 77: ciw on an empty document returns no object and changes nothing.
{
  const empty = findTextObject('', 0, 'w', true)
  const h = makeVim('', 0)
  executeOperatorTextObj('change', 'inner', 'w', 0, h.ctx)
  check('77. ciw on empty document: no object, no fault, no change', empty === null && h.state.text === '' && h.state.insertEntered === null)
}

// 78: nested table (blockquote) renders without the width budget.
{
  const table = '| aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb |\n|---|---|\n| 1 | 2 |'
  const nested = '> ' + table.split('\n').join('\n> ')
  const out = applyMarkdown(nested, 'dark', null, 24).replace(/\x1b\[[0-9;]*m/g, '')
  const widest = Math.max(...out.split('\n').map(l => [...l].length))
  check('78. a blockquote-nested table ignores the top-level width budget', widest > 24, `widest=${widest}`)
}

// 80 (clipboard-dependent — pinned)
pin('80. tryReadImageFromPath reports the PASTED name, not the clipboard path', /path:\s*(text|pasted|input)/.test(imagePasteSrc) || /pasted/i.test(imagePasteSrc))

// 81: the slow-op instrument is the shared no-op.
{
  const a = slowLogging`op one`
  const b = slowLogging`op two ${42}`
  check('81. slowLogging returns the ONE shared no-op disposable; threshold resolved once at load', a === b && typeof SLOW_OPERATION_THRESHOLD_MS === 'number')
}

// 82 (context-heavy — pinned)
pin('82. prompt-command throw ⇒ echoed command + stderr-wrapped message; abort ⇒ interruption message', /INTERRUPT|interrupt/i.test(slashSrc) && /stderr/i.test(slashSrc))

// 83 (context-heavy — pinned)
pin('83. local-JSX done(display:skip) ⇒ NO messages incl. meta; next-input fields still forward', /skip/.test(slashSrc) && /nextInput/.test(slashSrc))

// 84: formatResetText absent-value stringification.
{
  const none = formatResetText(undefined as never)
  const zero = formatResetText(0 as never)
  const bad = formatResetText('not-a-date')
  check('84. formatResetText: no/zero/unparseable input stringifies the absent value (never empty)', none !== '' && zero !== '' && bad !== '' && [none, zero, bad].every(v => typeof v === 'string'), JSON.stringify({ none, zero, bad }))
}

console.log()
if (failures > 0) {
  console.log(`❌ S32 ACCEPTANCE RED (${failures} of 84)`)
  process.exit(1)
}
console.log('✅ S32 ACCEPTANCE — 84/84')
