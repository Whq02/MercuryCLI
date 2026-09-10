#!/usr/bin/env bun
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
  const cleanExpected = [{ matcher: 'Bash|Read', hooks: [{ type: 'command', command: 'echo ok', timeout: 30 }] }]
  const stable = (v: unknown): string => JSON.stringify(v, (_k, val) => (val !== null && typeof val === 'object' && !Array.isArray(val) ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : val))
  check('and byte-faithfully', stable(clean.matchers) === stable(cleanExpected), stable(clean.matchers))
  const cleanHook = (clean.matchers[0]?.hooks as Array<Record<string, unknown>> | undefined)?.[0]
  check('…the matcher, type, command and timeout all survive as given (no default filled in, no leaf pruned)', clean.matchers[0]?.matcher === 'Bash|Read' && cleanHook?.type === 'command' && cleanHook?.command === 'echo ok' && cleanHook?.timeout === 30 && Object.keys(cleanHook ?? {}).sort().join(',') === 'command,timeout,type', JSON.stringify(cleanHook))
  const noMatcher = parseHooks({ PreToolUse: [{ hooks: [{ type: 'command', command: 'echo everywhere' }] }] })
  check('a DELIBERATELY matcher-less entry stays legal (matcher is optional)', noMatcher.errors.length === 0 && noMatcher.matchers.length === 1)
}

rmSync(HOME, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-hook-schema-teeth: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-hook-schema-teeth: all green')
