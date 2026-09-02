#!/usr/bin/env bun
// ============================================================================
//  scripts/node-runtime/prove-field-findings-exit-writes.ts — exits speak
// through the SYNC fd (TASK-017 supplement S1,
//  `gitbash-boot-refusal-can-print-nothing`, the L4 class).
//
//  Node's contract: process.stdout/stderr writes are ASYNC for TTYs on
//  win32 (sync on POSIX), so `stream.write(...)` immediately followed by
//  `process.exit(...)` can discard the queued bytes — the operator gets a
//  bare exit code and a blank console. The git-bash refusal was the worst
//  case: the ONLY line ever shown before Mercury declines to boot on a
//  Windows box without git-bash. House discipline (gracefulShutdown's
//  failLoud): writeSync(2, …) in a try/catch, then exit.
//
//  §1 pins the class OUT of the owners the audit fixed; §2 pins the
//  discipline IN (writeSync beside every one of those exits).
//
//  Run: ~/.bun/bin/bun run scripts/node-runtime/prove-field-findings-exit-writes.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

/** A stream write with process.exit within the next three lines — the
 *  discardable-bytes shape. */
const hasAdjacentStreamWriteExit = (src: string): boolean => {
  const lines = src.split('\n')
  return lines.some((l, i) => {
    if (!/process\.std(err|out)\.write\(/.test(l)) return false
    return lines.slice(i + 1, i + 4).some(n => /process\.exit\(/.test(n))
  })
}

console.log('§1 the discardable write-then-exit shape is out of the fixed owners')
for (const rel of [
  'src/utils/windowsPaths.ts',
  'src/cli/structuredIO.ts',
  'src/services/tcpBridge/entry.ts',
  'src/cli/handlers/auth.ts',
  'src/main.tsx',
]) {
  check(`${rel} carries no stream-write-then-exit pair`, !hasAdjacentStreamWriteExit(read(rel)))
}
{
  // cli.tsx keeps its statically light entry (the boot contract pins its
  // one static value import) — the usage exit imports writeSync lazily.
  const cli = read('src/entrypoints/cli.tsx')
  check(
    'cli.tsx: the acp usage exit is a lazy writeSync, not the stream',
    cli.includes("const { writeSync } = await import('node:fs')") && !cli.includes("process.stderr.write('Usage: mercury acp --stdio"),
  )
}

console.log('§2 the discipline is in: writeSync beside the exits the audit fixed')
{
  const wp = read('src/utils/windowsPaths.ts')
  check(
    'the git-bash refusal writes sync (both arms)',
    (wp.match(/writeSync\(\s*2,/g) ?? []).length >= 2 && wp.includes('requires git-bash'),
  )
  const main = read('src/main.tsx')
  check('the --version line writes sync', main.includes('writeSync(1, `${MERCURY_VERSION}'))
  check('the rollback refusal writes sync', main.includes("writeSync(2, 'Rollback is an update operation"))
  const auth = read('src/cli/handlers/auth.ts')
  check("both sign-in results write sync", (auth.match(/writeSync\(1, /g) ?? []).length >= 4)
  const sio = read('src/cli/structuredIO.ts')
  check('fatalProtocolError writes sync', sio.includes('writeSync(2, `${reason}\\n`)'))
}
// Residue recorded, not pinned: `console.error(...)` + exit pairs are the
// same hazard through the console wrapper — a wider fold (the S1's own
// anchors are all closed above).
// NEEDS-REAL-BOX (the finder's drill): a Windows box with no git.exe on
// PATH and MERCURY_GIT_BASH_PATH unset — every WT/conhost launch prints the
// two-sentence git-bash message; none yields exit 1 with a blank console.

process.exit(failures === 0 ? 0 : 1)
