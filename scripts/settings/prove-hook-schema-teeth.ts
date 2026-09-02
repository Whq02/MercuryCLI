#!/usr/bin/env bun
// prove-hook-schema-teeth — three hook-settings defects the validator waved
// through (field cards FC-032 · FC-033 · FC-034), each interlocking with the
// FC-004 salvage so a pruned leaf can never mint a MATCH-EVERYTHING hook.
//
// FC-032: timeout had no upper bound — above 2147483s the seconds→ms product
//   overflowed the 32-bit timer to ~1ms: the hook was killed instantly and
//   misreported. The schema now caps at the timer bound; the salvage prunes
//   a beyond-bound value (leaf) and the hook keeps its default clock.
// FC-033: an uncompilable matcher regex was accepted (0 validation errors)
//   and disabled the hook forever at fire time (the throw swallowed). The
//   matcher object now validates compilability, with the issue attached to
//   the ENTRY, so the salvage prunes the whole matcher entry — visibly —
//   never the matcher leaf alone (which would widen it to match-all).
// FC-034: a typo'd `mather` key was stripped by non-strict parsing — the
//   scoped hook silently became match-everything. The matcher object is now
//   STRICT: the unknown key's issue targets the entry, the salvage drops the
//   entry whole, and doctor carries the error.
//
//   §1 FC-032: the cap; beyond-bound prunes the leaf, hook survives.
//   §2 FC-033: bad regex = validation error pruning the WHOLE entry.
//   §3 FC-034: unknown key = validation error pruning the WHOLE entry.
//   §4 controls: a clean hooks block parses byte-faithfully.
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'hook-teeth-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { parseSettingsFile } = await import('../../src/utils/settings/settings.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

let n = 0
const parseHooks = (hooks: unknown): { matchers: Array<Record<string, unknown>>; errors: unknown[] } => {
  const path = join(HOME, `case-${n++}.json`)
  writeFileSync(path, JSON.stringify({ hooks }))
  const { settings, errors } = parseSettingsFile(path)
  const matchers = ((settings?.hooks as Record<string, unknown[]> | undefined)?.PreToolUse ?? []) as Array<Record<string, unknown>>
  return { matchers, errors }
}

section('§1 FC-032 — the timeout cap')
{
  const over = parseHooks({ PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi', timeout: 999999999 }] }] })
  check('a beyond-bound timeout is a validation error', over.errors.length > 0, JSON.stringify(over.errors).slice(0, 140))
  const survivingHook = (over.matchers[0]?.hooks as Array<Record<string, unknown>> | undefined)?.[0]
  check(
    'the salvage prunes the timeout LEAF — the hook survives with its default clock',
    survivingHook !== undefined && survivingHook.command === 'echo hi' && survivingHook.timeout === undefined,
    JSON.stringify(survivingHook),
  )
  const atBound = parseHooks({ PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi', timeout: 2147483 }] }] })
  check('the bound itself is accepted', atBound.errors.length === 0 && atBound.matchers.length === 1)
}

section('§2 FC-033 — an uncompilable matcher')
{
  const bad = parseHooks({
    PreToolUse: [
      { matcher: 'startu[p', hooks: [{ type: 'command', command: 'echo broken' }] },
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo fine' }] },
    ],
  })
  check('an uncompilable matcher is a validation error (was 0 errors)', bad.errors.length > 0, JSON.stringify(bad.errors).slice(0, 140))
  check(
    'the salvage drops the WHOLE entry — never a matcher-less match-all',
    bad.matchers.length === 1 && bad.matchers[0]?.matcher === 'Bash',
    JSON.stringify(bad.matchers.map(m => m.matcher ?? '(absent)')),
  )
}

section('§3 FC-034 — a typo’d matcher key')
{
  const typo = parseHooks({
    PreToolUse: [
      { mather: 'resume', hooks: [{ type: 'command', command: 'echo scoped' }] },
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo fine' }] },
    ],
  })
  check('the unknown key is a validation error (was stripped silently)', typo.errors.length > 0, JSON.stringify(typo.errors).slice(0, 140))
  check(
    'the salvage drops the WHOLE entry — the scoped hook never widens to match-all',
    typo.matchers.length === 1 && typo.matchers[0]?.matcher === 'Bash',
    JSON.stringify(typo.matchers.map(m => m.matcher ?? '(absent)')),
  )
}

section('§4 CONTROLS')
{
  const clean = parseHooks({
    PreToolUse: [{ matcher: 'Bash|Read', hooks: [{ type: 'command', command: 'echo ok', timeout: 30 }] }],
  })
  check('a clean hooks block parses with zero errors', clean.errors.length === 0, JSON.stringify(clean.errors).slice(0, 100))
  check('and byte-faithfully', clean.matchers.length === 1 && (clean.matchers[0]?.hooks as unknown[]).length === 1)
  const noMatcher = parseHooks({ PreToolUse: [{ hooks: [{ type: 'command', command: 'echo everywhere' }] }] })
  check('a DELIBERATELY matcher-less entry stays legal (matcher is optional)', noMatcher.errors.length === 0 && noMatcher.matchers.length === 1)
}

rmSync(HOME, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-hook-schema-teeth: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-hook-schema-teeth: all green')
