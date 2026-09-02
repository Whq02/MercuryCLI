#!/usr/bin/env bun
// ============================================================================
//  scripts/winreg/prove-file-index-separator.ts
//
//  The @-file typeahead must match across path-separator dialects. On Windows
//  the file index is populated from `rg`, whose paths are '\'-separated, while
//  a user types the natural '/'; a git-sourced listing is '/'-separated even
//  on win32. The matcher canonicalises separators for MATCHING only (never the
//  stored/displayed path), so every {index-sep} × {query-sep} combination
//  resolves. Provable on any host — pure string matching, no console.
//
//  Field origin: windows-tasks2-edgar TASK-E004 `INPUT-at-typeahead-forward-
//  slash-dead-win32` (S1) — a single '/' in the query killed the menu on a
//  '\'-separated index.
//
//  Run: ~/.bun/bin/bun run scripts/winreg/prove-file-index-separator.ts
// ============================================================================
import { FileIndex } from '../../src/native-ts/file-index/index.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  [PASS] ${label}`)
  } else {
    failures++
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/** True iff SOME returned path ends with `suffix` (native separators). */
function has(results: { path: string }[], suffix: string): boolean {
  return results.some(r => r.path.endsWith(suffix))
}

console.log('============================================================')
console.log(' file-index separator canonicalisation (@ typeahead)')
console.log('============================================================')

// A '\'-separated index (the Windows `rg` shape) — the field repro's source.
const backslashIndex = new FileIndex()
backslashIndex.loadFromFileList(['src\\Tool.ts', 'src\\Task.ts', 'src\\ink.ts', 'lib\\deep\\foo.ts'])

// The exact field failure: one '/' in the query used to return zero rows.
check('forward-slash query matches a backslash index', has(backslashIndex.search('src/T', 20), 'src\\Tool.ts'))
check('forward-slash query keeps every sibling', has(backslashIndex.search('src/T', 20), 'src\\Task.ts'))
check('backslash query matches a backslash index', has(backslashIndex.search('src\\T', 20), 'src\\Tool.ts'))
check('deep forward-slash query matches', has(backslashIndex.search('lib/deep/foo', 20), 'lib\\deep\\foo.ts'))
// Smart-case (uppercase ⇒ case-sensitive) still folds the separator.
check('case-sensitive forward-slash query matches a backslash index', has(backslashIndex.search('src/Tool', 20), 'src\\Tool.ts'))
// The stored/returned path stays NATIVE — folding is match-only.
check('returned path is the native (backslash) spelling', backslashIndex.search('src/Tool', 20)[0]?.path === 'src\\Tool.ts')

// A '/'-separated index (git listing, or POSIX) — a '\'-typed query must fold.
const slashIndex = new FileIndex()
slashIndex.loadFromFileList(['src/Tool.ts', 'src/Task.ts', 'lib/deep/foo.ts'])
check('backslash query matches a slash index', has(slashIndex.search('src\\T', 20), 'src/Tool.ts'))
// POSIX regression floor: the ordinary '/'-on-'/' path is unchanged.
check('slash query still matches a slash index (POSIX floor)', has(slashIndex.search('src/T', 20), 'src/Tool.ts'))
check('bare segment query still matches (no separator)', has(slashIndex.search('foo', 20), 'lib/deep/foo.ts'))

console.log(failures === 0 ? '\nALL FILE-INDEX SEPARATOR CHECKS PASS' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
