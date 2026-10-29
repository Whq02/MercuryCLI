#!/usr/bin/env bun

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'diff-hunks-home-'))
delete process.env.MERCURY_HOME

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const j = (v: unknown): string => JSON.stringify(v)

const { adjustHunkLineNumbers, countLinesChanged, getPatchForDisplay, getPatchFromContents } = await import('../../src/utils/diff.ts')
const { getTotalLinesAdded, getTotalLinesRemoved } = await import('../../src/bootstrap/state.ts')

section('§1 ampersands and dollar signs survive the diff untouched, on both sides')
{
  const hunks = getPatchFromContents({ filePath: 'a.sh', oldContent: 'echo $HOME && ls\nkeep\n', newContent: 'echo $USER && ls -a\nkeep\n' })
  const lines = hunks.flatMap(h => h.lines)
  check('the removed line reads back with its $ and &&', lines.includes('-echo $HOME && ls'), j(lines))
  check('the added line reads back with its $ and &&', lines.includes('+echo $USER && ls -a'), j(lines))
  check('no sentinel token leaks into a hunk line', !lines.some(l => l.includes('\x00')), j(lines))
  check('the hunk keeps its line numbers', hunks.length === 1 && hunks[0]!.oldStart === 1 && hunks[0]!.newStart === 1, j(hunks))
}

section('§2 a new string with a dollar pattern is inserted literally, and replace_all reaches every occurrence')
{
  const once = getPatchForDisplay({ filePath: 'x.txt', fileContents: 'ab\nab\n', edits: [{ old_string: 'ab', new_string: '$& $1 $$' }] })
  const onceLines = once.flatMap(h => h.lines)
  check('the first occurrence alone is replaced, with the $ sequence verbatim', onceLines.includes('+$& $1 $$') && onceLines.filter(l => l.startsWith('-')).length === 1, j(onceLines))
  const all = getPatchForDisplay({ filePath: 'x.txt', fileContents: 'ab\nab\n', edits: [{ old_string: 'ab', new_string: 'cd', replace_all: true }] })
  const allLines = all.flatMap(h => h.lines)
  check('replace_all rewrites both occurrences', allLines.filter(l => l === '-ab').length === 2 && allLines.filter(l => l === '+cd').length === 2, j(allLines))
  const tabbed = getPatchForDisplay({ filePath: 'x.txt', fileContents: '\tlead\n', edits: [{ old_string: '\tlead', new_string: '\tled' }] })
  check('leading tabs render as spaces on both sides', tabbed.flatMap(h => h.lines).every(l => !l.includes('\t')), j(tabbed))
  check('an identical result makes no hunk', getPatchForDisplay({ filePath: 'x.txt', fileContents: 'same\n', edits: [{ old_string: 'zz', new_string: 'yy' }] }).length === 0)
}

section('§3 a single-hunk request collapses a far-apart change, three lines of context otherwise')
{
  const far = 'first\n' + 'mid\n'.repeat(40) + 'last\n'
  const changed = 'FIRST\n' + 'mid\n'.repeat(40) + 'LAST\n'
  check('the default context yields two hunks', getPatchFromContents({ filePath: 'f', oldContent: far, newContent: changed }).length === 2)
  check('singleHunk yields one', getPatchFromContents({ filePath: 'f', oldContent: far, newContent: changed, singleHunk: true }).length === 1)
}

section('§4 shifting hunks: a zero offset is the same array, another offset moves both starts')
{
  const hunks = getPatchFromContents({ filePath: 'f', oldContent: 'a\nb\n', newContent: 'a\nc\n' })
  check('offset 0 answers the input by reference', adjustHunkLineNumbers(hunks, 0) === hunks)
  const moved = adjustHunkLineNumbers(hunks, 9)
  check('offset 9 shifts oldStart and newStart and copies the hunk', moved[0]!.oldStart === hunks[0]!.oldStart + 9 && moved[0]!.newStart === hunks[0]!.newStart + 9 && moved[0] !== hunks[0], j(moved))
}

section('§5 the line counter: + and - lines across hunks, or every line of a new file')
{
  const added0 = getTotalLinesAdded()
  const removed0 = getTotalLinesRemoved()
  countLinesChanged(getPatchFromContents({ filePath: 'f', oldContent: 'a\nb\nc\n', newContent: 'a\nB\nC\nd\n' }))
  check('two removed and three added lines are reported', getTotalLinesAdded() - added0 === 3 && getTotalLinesRemoved() - removed0 === 2, `${getTotalLinesAdded() - added0}/${getTotalLinesRemoved() - removed0}`)
  const added1 = getTotalLinesAdded()
  countLinesChanged([], 'one\r\ntwo\nthree')
  check('a new file counts its CRLF-or-LF lines as additions', getTotalLinesAdded() - added1 === 3)
  const added2 = getTotalLinesAdded()
  const removed2 = getTotalLinesRemoved()
  countLinesChanged([])
  check('no hunks and no content report nothing', getTotalLinesAdded() === added2 && getTotalLinesRemoved() === removed2)
}

console.log(failures === 0 ? '\nprove-diff-hunks: ALL PASS' : `\nprove-diff-hunks: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
