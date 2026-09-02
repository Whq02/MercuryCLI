#!/usr/bin/env bun
// ============================================================================
//  scripts/tools/prove-search-salvage-tail.ts — an interrupted search keeps
//  the last COMPLETE line it received (FC-111). The salvage unconditionally
//  dropped the final split line ("the last line may be incomplete") without
//  testing whether the received bytes end in a newline — a search cut short
//  by timeout, cancel, or the output cap reported one result fewer than it
//  had, and splitOutput's trim erased the very newline that proves the tail
//  arrived whole.
//
//  Driven through the REAL failure path: a controlled rg on PATH
//  (USE_BUILTIN_RIPGREP=0 routes resolution to the system road) writes its
//  lines, then sleeps; the caller aborts. The abort arm shares the one
//  salvage line with the timeout and overflow arms, so the newline
//  discriminator is proven for all three without a 20-second wait.
//
//  §0 the controlled rg is actually the one resolved (loud, not silent).
//  §1 a newline-terminated tail survives whole.
//  §2 a mid-line tail still drops exactly the partial line.
//
//  Run: ~/.bun/bin/bun run scripts/tools/prove-search-salvage-tail.ts
// ============================================================================
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (process.platform === 'win32') {
  console.log('SKIP: the controlled-rg fixture is a POSIX shell script; the salvage line itself is platform-free')
  process.exit(0)
}

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'salvage-home-')))
const BIN = join(HOME, 'bin')
const WORK = join(HOME, 'work')
mkdirSync(BIN, { recursive: true })
mkdirSync(WORK, { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
process.env.USE_BUILTIN_RIPGREP = '0'
process.env.PATH = `${BIN}:${process.env.PATH ?? ''}`
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

// The controlled rg reads a mode file so ONE resolved binary serves every
// leg (resolveRipgrep caches its resolution for the process lifetime).
const MODE = join(HOME, 'mode')
writeFileSync(
  join(BIN, 'rg'),
  `#!/bin/sh\nmode=$(cat ${MODE})\nif [ "$mode" = "complete" ]; then printf 'alpha.txt\\nbeta.txt\\n'\nelif [ "$mode" = "partial" ]; then printf 'alpha.txt\\nbeta.txt\\ngamma-partial'\nelse printf 'probe-ok\\n'; exit 0\nfi\nsleep 20\n`,
)
chmodSync(join(BIN, 'rg'), 0o755)

const { ripGrep } = await import('../../src/utils/ripgrep.js')

const abortedSearch = async (): Promise<string[]> => {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 500)
  return ripGrep(['--files'], WORK, controller.signal)
}

section('§0 THE CONTROLLED RG IS THE RESOLVED ONE')
{
  writeFileSync(MODE, 'probe')
  const probe = await ripGrep(['--files'], WORK, new AbortController().signal)
  check(
    'the PATH-provided rg answers (a silent fall-through to a real engine would void every leg below)',
    probe.length === 1 && probe[0] === 'probe-ok',
    probe.join(', '),
  )
}

section('§1 A NEWLINE-TERMINATED TAIL SURVIVES WHOLE')
{
  writeFileSync(MODE, 'complete')
  const salvaged = await abortedSearch()
  check(
    'both received lines are reported — the newline proves the tail arrived complete',
    salvaged.length === 2 && salvaged[0] === 'alpha.txt' && salvaged[1] === 'beta.txt',
    salvaged.join(', '),
  )
}

section('§2 A MID-LINE TAIL STILL DROPS EXACTLY THE PARTIAL LINE')
{
  writeFileSync(MODE, 'partial')
  const salvaged = await abortedSearch()
  check(
    'the incomplete third line is dropped, the two whole ones stay',
    salvaged.length === 2 && salvaged[1] === 'beta.txt' && !salvaged.includes('gamma-partial'),
    salvaged.join(', '),
  )
}

console.log(failures === 0 ? '\nprove-search-salvage-tail: all green' : `\nprove-search-salvage-tail: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
