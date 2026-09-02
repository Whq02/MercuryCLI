#!/usr/bin/env bun
// ============================================================================
//  scripts/lsp/prove-ide-detect.ts
//  PROOF: /ide's running-IDE detection matches EXECUTABLE
//  paths/names, never full command lines — and the /ide command can never
//  auto-install into an IDE without consent or claim an install it never saw.
//
//  The live incident this pins: `ps aux | grep <names>` matched Spotify's
//  Chromium helper argv `--disable-features=…MacAppCodeSignClone…` ('AppCode'
//  substring) ⇒ detectRunningIDEs() returned ['appcode'] on a machine with no
//  JetBrains IDE at all ⇒ the single-match path AUTO-INSTALLED a plugin on
//  mount and printed past-tense "Installed plugin to AppCode" while the real
//  async install went on to fail invisibly. The operator's report: "/ide does
//  nothing".
//
//  Run:  ~/.bun/bin/bun run scripts/lsp/prove-ide-detect.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' /ide running-IDE detection + consent — proof')
console.log('============================================================')

const { matchRunningIdeComms } = await import('../../src/utils/ide.js')

section('1 · the production false-positive is DEAD (comm lines carry no args)')
{
  // Real `ps -axo comm=` shapes from the incident machine: Spotify's helpers
  // and the macOS UserEventAgent — the processes whose ARGVS ('MacAppCodeSignClone',
  // '(Aqua)') poisoned the old whole-command-line grep. As comm paths they
  // must match nothing.
  const nonIde = [
    '/Applications/Spotify.app/Contents/Frameworks/Spotify Helper.app/Contents/MacOS/Spotify Helper',
    '/Applications/Spotify.app/Contents/Frameworks/Spotify Helper (Renderer).app/Contents/MacOS/Spotify Helper (Renderer)',
    '/usr/libexec/UserEventAgent',
    '/bin/zsh',
    '/usr/local/bin/node',
    '/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer',
  ]
  const got = matchRunningIdeComms(nonIde, 'darwin')
  check('Spotify helpers + UserEventAgent + shells ⇒ NO IDEs', got.length === 0, JSON.stringify(got))
}

section('2 · real IDE bundle paths still detect (the .app path carries the name)')
{
  const lines = [
    '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
    '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Renderer).app/Contents/MacOS/Code Helper (Renderer)',
    '/Applications/IntelliJ IDEA.app/Contents/MacOS/idea',
    '/Applications/AppCode.app/Contents/MacOS/appcode',
    '/Applications/Cursor.app/Contents/MacOS/Cursor',
  ]
  const got = new Set(matchRunningIdeComms(lines, 'darwin'))
  check('VS Code detected', got.has('vscode'))
  check('IntelliJ detected', got.has('intellij'))
  check('a REAL AppCode still detects', got.has('appcode'))
  check('Cursor detected (Cursor.app path)', got.has('cursor'))
}

section('3 · linux per-line collision guard (code ⊂ appcode; cursor helpers)')
{
  check(
    "an 'appcode' binary is NOT VS Code",
    !matchRunningIdeComms(['appcode'], 'linux').includes('vscode'),
  )
  check(
    "a bare 'code' binary IS VS Code",
    matchRunningIdeComms(['code'], 'linux').includes('vscode'),
  )
  const both = matchRunningIdeComms(['cursor', 'code'], 'linux')
  check(
    'cursor + code on separate lines ⇒ BOTH detected (per-line, not blob-level)',
    both.includes('cursor') && both.includes('vscode'),
    JSON.stringify(both),
  )
}

section('4 · impl feeds comm=, never an argv grep (structural)')
{
  const src = readFileSync(join(import.meta.dir, '..', '..', 'src', 'utils', 'ide.ts'), 'utf-8')
  const impl = src.slice(src.indexOf('async function scanRunningEditorProcesses'))
  const implOnly = impl.slice(0, impl.indexOf('\n}\n') + 2)
  check("macOS path uses ps ['-axo', 'comm=']", /'-axo', 'comm='/.test(implOnly))
  check("linux path uses ps ['-eo', 'comm=']", /'-eo', 'comm='/.test(implOnly))
  check('NO `ps aux | grep` pipeline survives on mac/linux', !/ps aux \| grep/.test(implOnly))
  check('the unix path routes through the pure matcher seam', (implOnly.match(/matchRunningIdeComms\(/g) ?? []).length === 1)
}

section('5 · /ide consent + honest tense (structural on the command)')
{
  const tsx = readFileSync(join(import.meta.dir, '..', '..', 'src', 'commands', 'ide', 'ide.tsx'), 'utf-8')
  check('InstallOnMount (zero-consent auto-install) is GONE', !/InstallOnMount/.test(tsx))
  check('a single candidate still goes through the install OFFER (length > 0, no ===1 fast path)', /running\.length > 0/.test(tsx) && !/running\.length === 1/.test(tsx))
  check('no past-tense install claim before the async install runs', !/Installed (plugin|extension) to/.test(tsx))
  check('the message routes the operator to the real result surface', /\/status → IDE/.test(tsx))
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL /ide DETECTION PROOFS PASS')
else console.log(`❌ ${failures} /ide DETECTION PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
