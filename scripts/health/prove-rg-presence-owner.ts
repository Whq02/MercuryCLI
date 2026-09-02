#!/usr/bin/env bun
// ============================================================================
//  scripts/health/prove-rg-presence-owner.ts — the runtime row's ripgrep
//  presence never flips on the working directory (FC-151). System mode's
//  path is the BARE name by design, and the row's local existsSync answered
//  for a file named rg in the process cwd: a 0-byte non-executable rg there
//  read present while a working PATH rg read MISSING.
//
//  Run: ~/.bun/bin/bun run scripts/health/prove-rg-presence-owner.ts
// ============================================================================
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const ROOT = join(import.meta.dir, '..', '..')

const { getRipgrepStatus } = await import('../../src/utils/ripgrep.ts')

// The cwd-independence drive: the same status from two working directories,
// one of which holds a 0-byte decoy named rg.
const decoyDir = realpathSync(mkdtempSync(join(tmpdir(), 'rg-decoy-')))
writeFileSync(join(decoyDir, 'rg'), '')
const before = getRipgrepStatus()
const savedCwd = process.cwd()
process.chdir(decoyDir)
const inDecoy = getRipgrepStatus()
process.chdir(savedCwd)
check(
  'the presence verdict is cwd-independent (a 0-byte ./rg decoy changes nothing)',
  before.present === inDecoy.present && typeof before.present === 'boolean',
  `before=${before.present} inDecoy=${inDecoy.present} mode=${before.mode} path=${before.path}`,
)
check('this tree resolves a real engine (present)', before.present === true, `${before.mode} @ ${before.path}`)
{
  const healthSrc = readFileSync(join(ROOT, 'src', 'utils', 'healthReport.ts'), 'utf8')
  check('the row consumes the OWNER presence (rg.present, no local existsSync on rg.path)', healthSrc.includes('const rgPresent = rg.present') && !healthSrc.includes('const rgPresent = existsSync(rg.path)'))
}

rmSync(decoyDir, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-rg-presence-owner: all green' : `\nprove-rg-presence-owner: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
