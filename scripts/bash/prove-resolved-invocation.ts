#!/usr/bin/env bun
// ============================================================================
//  scripts/bash/prove-resolved-invocation.ts
//  PROOF: — the canonical ResolvedInvocation owner + the ONE
//  legacy command-string parser (quoting corpus, §10.6 shapes): quoted and
//  escaped spaced paths stay ONE executable token (the WP-2 class), args
//  propagate, no shell semantics ever apply, and the editor derivation
//  rides the owner (source pin).
// ============================================================================

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const { parseLegacyCommandString } = await import(join(ROOT, 'src/utils/resolvedInvocation.ts'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
const eq = (raw: string, exe: string, args: string[]): boolean => {
  const p = parseLegacyCommandString(raw)
  return p.executablePath === exe && JSON.stringify(p.args) === JSON.stringify(args)
}

console.log('============================================================')
console.log(' ResolvedInvocation legacy parser — corpus')
console.log('============================================================')

check('plain command + args', eq('code --wait -n', 'code', ['--wait', '-n']))
check('double-quoted spaced path is ONE token', eq('"/Applications/My Editor.app/Contents/MacOS/ed" -n', '/Applications/My Editor.app/Contents/MacOS/ed', ['-n']))
check('win32 quoted Program Files path is ONE token', eq('"C:\\Program Files\\Editor\\ed.exe" --goto', 'C:\\Program Files\\Editor\\ed.exe', ['--goto']))
check('backslash-escaped space is ONE token', eq('my\\ editor --flag', 'my editor', ['--flag']))
check("single quotes group (apostrophe path via double quotes)", eq('"/Users/O\'Brien/bin/ed" -w', "/Users/O'Brien/bin/ed", ['-w']))
check('single-quoted arg preserves inner double quote', eq("ed '--title=\"x\"'", 'ed', ['--title="x"']))
check('CJK + emoji tokens survive', eq('編集者 --タブ', '編集者', ['--タブ']))
check('collapsed whitespace separates (tabs too)', eq('  ed\t--a   --b  ', 'ed', ['--a', '--b']))
check('empty string ⇒ empty executable (not-configured)', eq('', '', []))
check('quoted EMPTY arg is preserved', eq('ed "" -n', 'ed', ['', '-n']))
check('no shell semantics: $() stays literal', eq('ed $(rm -rf /) --x', 'ed', ['$(rm', '-rf', '/)', '--x']))
check('cwd rides the invocation when given', parseLegacyCommandString('ed', '/w').cwd === '/w' && parseLegacyCommandString('ed').cwd === undefined)

// Editor derivation rides the owner (the naive space split is absent).
const editorSrc = readFileSync(join(ROOT, 'src/utils/editor.ts'), 'utf8')
check('editor.ts derives base/args through the canonical parser', editorSrc.includes('parseLegacyCommandString(editor)') && !editorSrc.includes("const parts = editor.split(' ')"))

console.log(failures === 0 ? '\n ✅ ALL RESOLVED-INVOCATION PROOFS PASS' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
