#!/usr/bin/env bun
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

function has(results: { path: string }[], suffix: string): boolean {
  return results.some(r => r.path.endsWith(suffix))
}

console.log('============================================================')
console.log(' file-index separator canonicalisation (@ typeahead)')
console.log('============================================================')

const backslashIndex = new FileIndex()
backslashIndex.loadFromFileList(['src\\Tool.ts', 'src\\Task.ts', 'src\\ink.ts', 'lib\\deep\\foo.ts'])

check('forward-slash query matches a backslash index', has(backslashIndex.search('src/T', 20), 'src\\Tool.ts'))
check('forward-slash query keeps every sibling', has(backslashIndex.search('src/T', 20), 'src\\Task.ts'))
check('backslash query matches a backslash index', has(backslashIndex.search('src\\T', 20), 'src\\Tool.ts'))
check('deep forward-slash query matches', has(backslashIndex.search('lib/deep/foo', 20), 'lib\\deep\\foo.ts'))
check('case-sensitive forward-slash query matches a backslash index', has(backslashIndex.search('src/Tool', 20), 'src\\Tool.ts'))
check('returned path is the native (backslash) spelling', backslashIndex.search('src/Tool', 20)[0]?.path === 'src\\Tool.ts')

const slashIndex = new FileIndex()
slashIndex.loadFromFileList(['src/Tool.ts', 'src/Task.ts', 'lib/deep/foo.ts'])
check('backslash query matches a slash index', has(slashIndex.search('src\\T', 20), 'src/Tool.ts'))
check('slash query still matches a slash index (POSIX floor)', has(slashIndex.search('src/T', 20), 'src/Tool.ts'))
check('bare segment query still matches (no separator)', has(slashIndex.search('foo', 20), 'lib/deep/foo.ts'))

console.log(failures === 0 ? '\nALL FILE-INDEX SEPARATOR CHECKS PASS' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
