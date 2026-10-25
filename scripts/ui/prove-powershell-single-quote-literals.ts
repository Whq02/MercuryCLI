#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`)

const { escapeForPowershellSingleQuotes } = await import('../../src/utils/powershellLiteral.ts')
const { resumeHintArgument } = await import('../../src/utils/shutdownRestoration.ts')

const units = (text: string): string => Array.from({ length: text.length }, (_, i) => text.charCodeAt(i)).join(',')
const CASES = [
  "it's here",
  'Don\u2019t stop',
  'a\u201Ab\u201Bc\u2018d\u2019e',
  'x\u2019; Write-Output PWNED; \u2019y',
  'C:\\Users\\O\u2019Brien\\AppData\\Local\\Temp\\paste-1.png',
]
const OLD = (text: string): string => text.replace(/'/g, "''")

section('§1 the escaper doubles every character PowerShell reads as a single quote')
{
  check("an ASCII quote doubles", escapeForPowershellSingleQuotes("it's") === "it''s")
  check('each typographic single quote doubles as itself', escapeForPowershellSingleQuotes('\u2018\u2019\u201A\u201B') === '\u2018\u2018\u2019\u2019\u201A\u201A\u201B\u201B')
  check('other text is untouched', escapeForPowershellSingleQuotes('C:\\Temp\\a "b" `c` $d') === 'C:\\Temp\\a "b" `c` $d')
  check('the resume hint speaks the same literal on win32', resumeHintArgument('Don\u2019t', 'sid', 'win32') === "'Don\u2019\u2019t'")
  check('…and keeps the exact ASCII form the older proof pins', resumeHintArgument("it's here", 'sid', 'win32') === "'it''s here'")
  check('…and leaves the POSIX form alone', resumeHintArgument('Don\u2019t "x"', 'sid', 'darwin') === '"Don\u2019t \\"x\\""')
}

section('§2 a real PowerShell reads the literal back unchanged (Windows hosts)')
if (process.platform !== 'win32') {
  console.log('  [skip] no Windows PowerShell on this host — §1 pins the escaper itself')
} else {
  const run = (script: string): { status: number | null; out: string } => {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 60_000 })
    return { status: r.status, out: (r.stdout ?? '').replace(/\r?\n$/, '') }
  }
  const readBack = (literalOf: (text: string) => string): { status: number | null; out: string } =>
    run(CASES.map(text => `$s = ${literalOf(text)}; (($s.ToCharArray() | ForEach-Object { [int]$_ }) -join ',')`).join('; '))
  const expected = CASES.map(units).join('\n')
  const fixed = readBack(text => `'${escapeForPowershellSingleQuotes(text)}'`)
  check('every case reads back with the same UTF-16 units, nothing else printed', fixed.status === 0 && fixed.out.replace(/\r/g, '') === expected, JSON.stringify(fixed))
  check('the injection case printed nothing of its own', !fixed.out.includes('PWNED'))
  const hint = readBack(text => resumeHintArgument(text, 'sid', 'win32'))
  check('the printed resume hint, pasted into PowerShell, is the title', hint.status === 0 && hint.out.replace(/\r/g, '') === expected, JSON.stringify(hint))
  const old = readBack(text => `'${OLD(text)}'`)
  check('CONTROL: the ASCII-only doubling this replaced does not survive the same cases on this host', old.status !== 0 || old.out.replace(/\r/g, '') !== expected, JSON.stringify(old))
}

console.log(failures === 0 ? '\nPASS prove-powershell-single-quote-literals' : `\nFAIL prove-powershell-single-quote-literals (${failures} failure(s))`)
process.exit(failures === 0 ? 0 : 1)
