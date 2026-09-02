#!/usr/bin/env bun
// ============================================================================
//  scripts/tools/prove-grep-drive-colon.ts — Grep's content-mode
//  relativiser survives a Windows drive colon (FC-136). Content mode
//  splits the `path:line:match` prefix at the FIRST colon — which on
//  Windows is the drive letter's, so `C:\repo\file.ts:12:x` split into
//  the path `C` and content mode was the one output mode whose paths
//  never relativised there. The split now starts past a drive designator.
//  Pure matrix over the exported split point (platform-independent); the
//  live win32 drive is field-owed.
//
//  Run: ~/.bun/bin/bun run scripts/tools/prove-grep-drive-colon.ts
// ============================================================================
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

const mod = (await import('../../src/tools/GrepTool/GrepTool.ts')) as unknown as {
  prefixSplitIndex?: (line: string, splitOn: 'first' | 'last') => number
}
check('the split point is exported (prefixSplitIndex)', typeof mod.prefixSplitIndex === 'function')
const split = mod.prefixSplitIndex ?? ((): number => -1)

console.log("§1 content mode ('first')")
{
  const win = 'C:\\repo\\file.ts:12:  const x = 1'
  check(
    'a Windows absolute line splits AFTER the full path, never at the drive colon',
    win.slice(0, split(win, 'first')) === 'C:\\repo\\file.ts',
    win.slice(0, split(win, 'first')),
  )
  const winFwd = 'C:/repo/file.ts:12:x'
  check('the forward-slash drive spelling too', winFwd.slice(0, split(winFwd, 'first')) === 'C:/repo/file.ts')
  const posix = '/repo/file.ts:12:  const x = 1'
  check('a POSIX line splits at its first colon exactly as before', posix.slice(0, split(posix, 'first')) === '/repo/file.ts')
  const rel = 'src/a.ts:3:x'
  check('a relative line is unchanged behaviour', rel.slice(0, split(rel, 'first')) === 'src/a.ts')
  const context = 'C:\\repo\\file.ts-11-  context line'
  check('a context line (dash separators) still finds no split', split(context, 'first') === -1)
}

console.log("\n§2 count mode ('last') keeps its contract")
{
  const winCount = 'C:\\repo\\file.ts:7'
  check('a Windows count line splits before the count', winCount.slice(0, split(winCount, 'last')) === 'C:\\repo\\file.ts')
  const posixCount = '/repo/file.ts:7'
  check('a POSIX count line too', posixCount.slice(0, split(posixCount, 'last')) === '/repo/file.ts')
}

console.log(failures === 0 ? '\nprove-grep-drive-colon: all green' : `\nprove-grep-drive-colon: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
