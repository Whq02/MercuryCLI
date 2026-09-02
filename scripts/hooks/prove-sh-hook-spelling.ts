#!/usr/bin/env bun
// ============================================================================
//  scripts/hooks/prove-sh-hook-spelling.ts — the win32 .sh accommodation
//  keeps the operator's path spelling runnable (FC-084). Prepending `bash`
//  UNQUOTED made every backslash a bash escape: `C:\hooks\probe.sh` was
//  looked up as `C:hooksprobe.sh` and never ran — the accommodation that
//  exists to make a .sh hook runnable destroyed the only spelling a
//  Windows operator can write. Pure matrix over the exported composer.
//
//  Run: ~/.bun/bin/bun run scripts/hooks/prove-sh-hook-spelling.ts
// ============================================================================
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

const mod = (await import('../../src/utils/hooks/execution.js')) as {
  winShHookCommand?: (command: string) => string
}
check('the composer is exported (winShHookCommand)', typeof mod.winShHookCommand === 'function')
const compose = mod.winShHookCommand ?? ((c: string): string => c)

check(
  "the Windows absolute spelling SURVIVES: backslashes become forward slashes, quoted (the card's own path)",
  compose('C:\\Users\\op\\.mercury\\hooks\\probe.sh') === "bash 'C:/Users/op/.mercury/hooks/probe.sh'",
  compose('C:\\Users\\op\\.mercury\\hooks\\probe.sh'),
)
check(
  'a quoted Windows path with spaces survives the same way',
  compose('"C:\\my hooks\\probe.sh"') === "bash 'C:/my hooks/probe.sh'",
  compose('"C:\\my hooks\\probe.sh"'),
)
check(
  'arguments ride along after the re-spelled script',
  compose('C:\\hooks\\p.sh --fast now') === "bash 'C:/hooks/p.sh' --fast now",
  compose('C:\\hooks\\p.sh --fast now'),
)
check(
  'the POSIX spelling keeps the plain prepend (byte-identical to the old road)',
  compose('/c/hooks/probe.sh') === 'bash /c/hooks/probe.sh',
)
check(
  'a relative ./x.sh keeps the plain prepend',
  compose('./fix.sh') === 'bash ./fix.sh',
)
check(
  'a compound whose FIRST token is not a .sh stays untouched (TASK-017 pin)',
  compose('npm run format && ./fix.sh') === 'npm run format && ./fix.sh',
)
check(
  'an already-bash-prefixed command stays untouched',
  compose('bash C:\\hooks\\p.sh') === 'bash C:\\hooks\\p.sh',
)
check('a non-.sh command stays untouched', compose('echo hello') === 'echo hello')

console.log(failures === 0 ? '\nprove-sh-hook-spelling: all green' : `\nprove-sh-hook-spelling: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
