#!/usr/bin/env bun
import { cellAt, markNoSelectRegion, type Screen } from '../../src/screen/renderer/cell-grid.ts'
import { OverlayRecord } from '../../src/screen/renderer/geometry/selectionOverlay.ts'
import { applySearchHighlight } from '../../src/screen/renderer/searchHighlight.ts'
import { composeScene, makeContext, screenLines, type FrameScene } from './frameHarness.ts'

const WHERE = 'applySearchHighlight in src/screen/renderer/searchHighlight.ts'
const COLS = 24
const ROWS = ['Alpha beta ALPHA', 'nothing here', '\u65e5\u672c\u8a9e alpha', 'aaaaa', 'ab cd', 'caf\u00e9 CAF\u00c9', '\u0130stanbul i']
const scene: FrameScene = { name: 'search-highlight', cols: COLS, rows: ROWS.length, root: { kind: 'box', style: { flexDirection: 'column' }, children: ROWS.map(text => ({ kind: 'text' as const, text })) } }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)

type Outcome = { applied: boolean; marked: string; strange: string[] }
function highlight(query: string, prepare?: (screen: Screen) => void, withRecord = false): Outcome {
  const context = makeContext()
  const screen = composeScene(scene, context).screen
  prepare?.(screen)
  const before: number[][] = ROWS.map((_, y) => Array.from({ length: COLS }, (_cell, x) => cellAt(screen, x, y)?.styleId ?? -1))
  const applied = withRecord ? applySearchHighlight(screen, query, context.stylePool, new OverlayRecord()) : applySearchHighlight(screen, query, context.stylePool)
  const rows: string[] = []
  const strange: string[] = []
  ROWS.forEach((_, y) => {
    const columns: number[] = []
    for (let x = 0; x < COLS; x++) {
      const now = cellAt(screen, x, y)?.styleId ?? -1
      if (now === before[y]![x]) continue
      columns.push(x)
      if (now !== context.stylePool.withInverse(before[y]![x]!)) strange.push(`${x},${y}`)
    }
    if (columns.length > 0) rows.push(`${y}:${columns.join(',')}`)
  })
  return { applied, marked: rows.join(' '), strange }
}
function expectMarks(label: string, query: string, marks: string, prepare?: (screen: Screen) => void): void {
  const got = highlight(query, prepare)
  check(label, got.applied === (marks !== '') && got.marked === marks && got.strange.length === 0, `query ${JSON.stringify(query)} answered ${got.applied} and restyled [${got.marked}], expected [${marks}]${got.strange.length > 0 ? `; cells ${got.strange.join(' ')} did not get the inverse of their own style` : ''}; see ${WHERE}`)
}

section('§0 the screen the cases stand on')
{
  const lines = screenLines(composeScene(scene, makeContext()).screen)
  check('seven rows, a wide character taking two cells', lines.length === 7 && lines[0] === 'Alpha beta ALPHA' && lines[2] === '\u65e5 \u672c \u8a9e  alpha' && lines[4] === 'ab cd', JSON.stringify(lines))
}

section('§1 nothing to find')
{
  expectMarks('an empty query answers false and restyles nothing', '', '')
  expectMarks('a word that is not on the screen answers false and restyles nothing', 'zzz', '')
  expectMarks('a query longer than any row answers false', 'x'.repeat(30), '')
  expectMarks('a match never runs from the end of one row into the next', 'ALPHAnothing', '')
}

section('§2 every match is restyled, each cell with the inverse of the style it had')
{
  expectMarks('a word is found wherever it stands, on every row, whatever its case on the screen', 'alpha', '0:0,1,2,3,4,11,12,13,14,15 2:7,8,9,10,11')
  expectMarks('and whatever the case of the query', 'ALPHA', '0:0,1,2,3,4,11,12,13,14,15 2:7,8,9,10,11')
  expectMarks('a query with a space in it matches across the words of a row', 'beta alpha', '0:6,7,8,9,10,11,12,13,14,15')
  expectMarks('a query that ends in a space takes the cell after the word', 'here ', '1:8,9,10,11,12')
  expectMarks('one letter marks each cell that shows it', 'a', '0:0,4,9,11,15 2:7,11 3:0,1,2,3,4 4:0 5:1,6 6:3')
  expectMarks('matches do not overlap: in a row of five a, the pair is found twice and the fifth a is left', 'aa', '3:0,1,2,3')
  expectMarks('an accented letter matches itself in either case', 'caf\u00e9', '5:0,1,2,3,5,6,7,8')
  expectMarks('a capital dotted I on the screen is found by a plain i', 'i', '1:4 6:0,9')
}

section('§3 wide characters')
{
  expectMarks('two wide characters: the first cell of each is restyled', '\u672c\u8a9e', '2:2,4')
  expectMarks('a wide character, a space and a letter', '\u8a9e a', '2:4,6,7')
  expectMarks('the word after wide characters is marked at its own cells', 'alpha', '0:0,1,2,3,4,11,12,13,14,15 2:7,8,9,10,11')
}

section('§4 the blank cells of a row are spaces')
{
  expectMarks('a space finds every blank cell, to the right edge of each row', ' ', ['0:5,10,16,17,18,19,20,21,22,23', '1:7,12,13,14,15,16,17,18,19,20,21,22,23', '2:6,12,13,14,15,16,17,18,19,20,21,22,23', '3:5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23', '4:2,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23', '5:4,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23', '6:8,10,11,12,13,14,15,16,17,18,19,20,21,22,23'].join(' '))
}

section('§5 cells marked as not selectable are not searched')
{
  expectMarks('a match that begins inside such a region is not found; the same word elsewhere is', 'alpha', '0:11,12,13,14,15 2:7,8,9,10,11', screen => markNoSelectRegion(screen, 0, 0, 3, 1))
  expectMarks('a whole row marked so yields nothing', 'alpha', '2:7,8,9,10,11', screen => markNoSelectRegion(screen, 0, 0, COLS, 1))
  expectMarks('the text closes over a cell left out: the match is restyled from its first cell to its last, the cell between included', 'bc', '4:1,2,3', screen => markNoSelectRegion(screen, 2, 4, 1, 1))
}

section('§6 asked twice, and with a record')
{
  const context = makeContext()
  const screen = composeScene(scene, context).screen
  const first = applySearchHighlight(screen, 'beta', context.stylePool)
  const once = Array.from({ length: COLS }, (_, x) => cellAt(screen, x, 0)?.styleId ?? -1)
  const second = applySearchHighlight(screen, 'beta', context.stylePool)
  const twice = Array.from({ length: COLS }, (_, x) => cellAt(screen, x, 0)?.styleId ?? -1)
  check('highlighting the same query again answers true and leaves the cells as they are', first && second && once.join(',') === twice.join(','), `${once.join(',')} then ${twice.join(',')}; an inverse style stays the inverse style`)
  const recorded = highlight('alpha', undefined, true)
  check('with an overlay record handed in, the same cells are restyled', recorded.applied && recorded.marked === '0:0,1,2,3,4,11,12,13,14,15 2:7,8,9,10,11' && recorded.strange.length === 0, recorded.marked)
}

if (failures > 0) {
  console.error(`\nprove-search-highlight-behaviour: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-search-highlight-behaviour: all green')
