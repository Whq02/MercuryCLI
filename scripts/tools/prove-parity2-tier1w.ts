#!/usr/bin/env bun
// ============================================================================
//  prove-parity2-tier1w — frontier-sweep #2, tier 1W (Windows: ship +
//  field-verify). The POSIX-provable arms, mechanism-pinned; the win32 legs
//  ride scripts/winreg/field-packet-parity2-TASK-E005.md.
//
//   1. A child that reads standard input meets EOF at once (packet 70): the
//      REAL shell path runs `cat` and settles in well under its timeout. The
//      bash lane already redirected stdin from /dev/null for plain commands;
//      the spawn-seam close (child.stdin.end()) is what reaches the
//      PowerShell lane, whose live arm rides the field packet (no pwsh on
//      the macOS side) — here the seam is pinned structurally.
//   2. Valid-negative exit codes on the PowerShell lane (packet 71):
//      where/fc/comp/diff/cmp report 1 as an answer, 2+ as an error.
//   3. The UTF-8 output prelude rides every assembled PowerShell command,
//      after the plain-render pin and before the user command (packet 72).
// ============================================================================
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'parity2-1w-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
delete process.env.MERCURY_HOME
delete process.env.MERCURY_HOME

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

// —— 1. stdin EOF through the real shell path (packet 70) ———————————————
{
  const { exec } = await import('../../src/utils/Shell.ts')
  const started = Date.now()
  const handle = await exec('cat', new AbortController().signal, 'bash', { timeout: 6_000 })
  const result = await handle.result
  const elapsed = Date.now() - started
  t('`cat` with nothing on stdin settles at EOF instead of waiting for the timeout', elapsed < 3_000 && !result.interrupted, `${elapsed}ms, code ${result.code}, interrupted=${String(result.interrupted)}`)
  t('the settled command exited cleanly', result.code === 0, `code ${result.code}`)
  handle.cleanup()
  const ok = await exec('echo still-fine', new AbortController().signal, 'bash', { timeout: 6_000 })
  const okResult = await ok.result
  t('a command that never reads stdin is unaffected', okResult.code === 0 && /still-fine/.test(okResult.stdout))
  ok.cleanup()
  const { readFileSync } = await import('node:fs')
  const shell = readFileSync('src/utils/Shell.ts', 'utf8')
  t('the spawn seam closes the child\'s stdin for every lane (structural — the PowerShell arm is field-verified)', /const child = spawn\(spawnFile, spawnArgs, \{[\s\S]*?\}\)\s*\/\/[\s\S]*?child\.stdin\?\.end\(\)/.test(shell))
}

// —— 2. valid-negative exit codes (packet 71) ——————————————————————————
{
  const { interpretCommandResult } = await import('../../src/tools/PowerShellTool/commandSemantics.ts')
  const verdict = (cmd: string, code: number) => interpretCommandResult(cmd, code, '', '')
  t('where.exe exit 1 is a not-found answer, not an error', verdict('where.exe git', 1).isError === false && /not found/.test(verdict('where.exe git', 1).message ?? ''))
  t('where exit 0 is plain success', verdict('where git', 0).isError === false)
  t('where exit 2 is an error', verdict('where git', 2).isError === true)
  for (const tool of ['fc', 'fc.exe', 'comp', 'diff', 'cmp']) {
    t(`${tool} exit 1 reads as "files differ"`, verdict(`${tool} a.txt b.txt`, 1).isError === false && /differ/.test(verdict(`${tool} a.txt b.txt`, 1).message ?? ''))
    t(`${tool} exit 2 stays an error`, verdict(`${tool} a.txt missing.txt`, 2).isError === true)
  }
  t('a pipeline takes its last segment (fc after a pipe)', verdict('Get-Content a | fc b c', 1).isError === false)
  t('findstr keeps its existing rule', verdict('findstr /C:x a.txt', 1).isError === false && /no matches/.test(verdict('findstr /C:x a.txt', 1).message ?? ''))
  t('an unrelated tool still fails on non-zero', verdict('robocopy-not x', 1).isError === true)
}

// —— 3. the UTF-8 prelude rides every assembled command (packet 72) ————
{
  const { createPowerShellProvider, UTF8_OUTPUT_PRELUDE } = await import('../../src/utils/shell/powershellProvider.ts')
  const provider = createPowerShellProvider('pwsh')
  const assembled = await provider.buildExecCommand('Get-ChildItem', { id: 'e005', useSandbox: false } as never)
  const command = assembled.commandString
  const plainAt = command.indexOf('$PSStyle.OutputRendering')
  const utf8At = command.indexOf("$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'")
  const userAt = command.indexOf('Get-ChildItem')
  t('the UTF-8 prelude is present', utf8At !== -1)
  t('order: plain-render pin → UTF-8 pins → the user command', plainAt !== -1 && plainAt < utf8At && utf8At < userAt, `${plainAt}/${utf8At}/${userAt}`)
  t('the prelude pins Set-Content and Add-Content too', UTF8_OUTPUT_PRELUDE.includes("'Set-Content:Encoding'] = 'utf8'") && UTF8_OUTPUT_PRELUDE.includes("'Add-Content:Encoding'] = 'utf8'"))
  t('the prelude pins the console output encoding to UTF-8 without a BOM', UTF8_OUTPUT_PRELUDE.includes('[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)'))
  t('the prelude never fails the command (try/catch wrapped)', /^try \{.*\} catch \{\}\n$/s.test(UTF8_OUTPUT_PRELUDE))
  const sandboxed = await provider.buildExecCommand('Get-ChildItem', { id: 'e005s', useSandbox: true, sandboxTmpDir: '/tmp/sb' } as never)
  const decoded = Buffer.from((sandboxed.commandString.match(/-EncodedCommand (\S+)/)?.[1] ?? ''), 'base64').toString('utf16le')
  t('the sandboxed (encoded) lane carries the same prelude', decoded.includes("$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'") && decoded.indexOf('$PSStyle.OutputRendering') !== -1 && decoded.indexOf('$PSStyle.OutputRendering') < decoded.indexOf('Out-File:Encoding'))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures ? '\nFAILURES' : '\nALL GREEN')
process.exit(failures)
