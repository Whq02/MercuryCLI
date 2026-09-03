#!/usr/bin/env bun
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

const MODE = join(HOME, 'mode')
writeFileSync(
  join(BIN, 'rg'),
  `#!/bin/sh\nmode=$(cat ${MODE})\nif [ "$mode" = "complete" ]; then printf 'alpha.txt\\nbeta.txt\\n'\nelif [ "$mode" = "partial" ]; then printf 'alpha.txt\\nbeta.txt\\ngamma-partial'\nelse printf 'probe-ok\\n'; exit 0\nfi\nsleep 20\n`,
)
chmodSync(join(BIN, 'rg'), 0o755)

const { ripGrep, ripGrepAnswer, RipgrepTimeoutError } = await import('../../src/utils/ripgrep.js')

const abortedSearch = async (): Promise<{ lines: string[]; complete: boolean; reason?: string }> => {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 500)
  return ripGrepAnswer(['--files'], WORK, controller.signal)
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
  const answer = await abortedSearch()
  const salvaged = answer.lines
  check(
    'both received lines are reported — the newline proves the tail arrived complete',
    salvaged.length === 2 && salvaged[0] === 'alpha.txt' && salvaged[1] === 'beta.txt',
    salvaged.join(', '),
  )
  check(
    'the answer says it is PARTIAL — an interrupted walk never reads complete',
    answer.complete === false && /interrupted before it finished/.test(answer.reason ?? '') && /2 line\(s\) kept/.test(answer.reason ?? ''),
    `complete=${answer.complete} reason=${answer.reason ?? '(none)'}`,
  )
}

section('§2 A MID-LINE TAIL STILL DROPS EXACTLY THE PARTIAL LINE')
{
  writeFileSync(MODE, 'partial')
  const answer = await abortedSearch()
  const salvaged = answer.lines
  check(
    'the incomplete third line is dropped, the two whole ones stay',
    salvaged.length === 2 && salvaged[1] === 'beta.txt' && !salvaged.includes('gamma-partial'),
    salvaged.join(', '),
  )
  check('…and the answer still says PARTIAL', answer.complete === false, `complete=${answer.complete}`)
}

section('§3 THE PLAIN DOOR THROWS ON THE CUT WALK, CARRYING THE SALVAGE')
{
  writeFileSync(MODE, 'complete')
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 500)
  let thrown: unknown = null
  try {
    await ripGrep(['--files'], WORK, controller.signal)
  } catch (e) {
    thrown = e
  }
  check(
    'ripGrep throws the typed timeout error (a caller that reads no completeness can never mistake a cut walk for a finished one)',
    thrown instanceof RipgrepTimeoutError,
    thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown),
  )
  check(
    'the thrown error carries the two whole lines as partialResults',
    thrown instanceof RipgrepTimeoutError && thrown.partialResults.length === 2 && thrown.partialResults[0] === 'alpha.txt' && thrown.partialResults[1] === 'beta.txt',
    thrown instanceof RipgrepTimeoutError ? thrown.partialResults.join(', ') : '(no partialResults)',
  )
}

console.log(failures === 0 ? '\nprove-search-salvage-tail: all green' : `\nprove-search-salvage-tail: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
