#!/usr/bin/env bun
// ============================================================================
//  scripts/health/prove-policy-cache-salvage.ts — one malformed entry no
//  longer voids the whole organisation policy cache (FC-158). The
//  all-or-nothing schema parse meant a stringified boolean, an unknown-key
//  shape, a bare boolean, a trailing comma, or a BOM lifted EVERY
//  restriction at once — no log line, no doctor row. The loader now
//  salvages per entry (valid entries keep their restrictions; malformed
//  ones drop, named, reading unrestricted — the module's documented
//  per-policy fail-open bounded to the broken entry), and the doctor's
//  policy-limits-cache row shows the drops.
//
//  The card's five cache shapes drive readPolicyCacheState (the
//  eligibility-blind file reader; isPolicyAllowed keeps its eligibility
//  gate untouched).
//
//  Run: ~/.bun/bin/bun run scripts/health/prove-policy-cache-salvage.ts
// ============================================================================
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'polcache-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const policy = (await import('../../src/services/policyLimits/index.ts')) as unknown as {
  readPolicyCacheState?: () => {
    present: boolean
    restrictions: Record<string, { allowed: boolean }> | null
    problems: string[]
  }
  clearPolicyLimitsCache: () => void
}
check('the state reader is exported (readPolicyCacheState)', typeof policy.readPolicyCacheState === 'function')
const CACHE = join(HOME, 'policy-limits.json')
const state = (raw: string): { restrictions: Record<string, { allowed: boolean }> | null; problems: string[] } => {
  // clear FIRST — clearPolicyLimitsCache deletes the cache file too.
  policy.clearPolicyLimitsCache()
  writeFileSync(CACHE, raw)
  const s = policy.readPolicyCacheState?.() ?? { present: false, restrictions: null, problems: [] }
  return { restrictions: s.restrictions, problems: s.problems }
}

section('§1 a valid cache parses whole (control)')
{
  const s = state(
    JSON.stringify({ restrictions: { a: { allowed: false }, b: { allowed: false }, c: { allowed: false }, d: { allowed: true } } }),
  )
  check('three restricted policies survive', s.restrictions !== null && Object.values(s.restrictions).filter(r => !r.allowed).length === 3)
  check('no problems recorded', s.problems.length === 0)
}

section('§2 a stringified boolean voids ONE entry, not the document')
{
  const s = state(JSON.stringify({ restrictions: { a: { allowed: false }, b: { allowed: 'false' }, c: { allowed: false } } }))
  check(
    'the two valid restrictions SURVIVE',
    s.restrictions !== null && s.restrictions['a']?.allowed === false && s.restrictions['c']?.allowed === false,
    JSON.stringify(s.restrictions),
  )
  check("the malformed entry is dropped, NAMED", s.problems.some(p => p.includes("'b'")), s.problems.join(' | '))
}

section('§3 a bare-boolean entry: same bounded salvage')
{
  const s = state(JSON.stringify({ restrictions: { a: { allowed: false }, b: true } }))
  check('the valid restriction survives', s.restrictions?.['a']?.allowed === false)
  check('the bare boolean is a named drop', s.problems.length === 1 && s.problems[0]!.includes("'b'"))
}

section('§4 an unknown extra key on a valid entry is tolerated')
{
  const s = state(JSON.stringify({ restrictions: { a: { allowed: false, extra: null } } }))
  check('the entry keeps its restriction (unknown keys are not junk)', s.restrictions?.['a']?.allowed === false, JSON.stringify(s))
}

section('§5 a BOM is stripped; a trailing comma is named unparseable')
{
  const bom = state('﻿' + JSON.stringify({ restrictions: { a: { allowed: false } } }))
  check('a BOM-prefixed cache parses', bom.restrictions?.['a']?.allowed === false, bom.problems.join(' | '))
  const torn = state('{"restrictions": {"a": {"allowed": false},}}')
  check(
    'a trailing comma cannot salvage but IS a named problem now',
    torn.restrictions === null && torn.problems.length === 1 && torn.problems[0]!.includes('unparseable'),
    torn.problems.join(' | '),
  )
}

section('§6 the doctor row shows the drops')
{
  policy.clearPolicyLimitsCache()
  writeFileSync(CACHE, JSON.stringify({ restrictions: { a: { allowed: false }, b: { allowed: 'false' } } }))
  const report = await import('../../src/utils/healthReport.js')
  const cert = await report.runHealthReport({ depth: 'fast' })
  const row = cert.sections.flatMap(s => s.checks).find(c => c.id === 'policy-limits-cache')
  check('the row exists (policy-limits-cache)', row !== undefined)
  check(
    'the drops WARN with the salvage counts',
    row?.status === 'warn' && String(row.evidence).includes('1 malformed') && String(row.evidence).includes('1 salvaged'),
    `${row?.status}: ${String(row?.evidence).slice(0, 140)}`,
  )
}

console.log(failures === 0 ? '\nprove-policy-cache-salvage: all green' : `\nprove-policy-cache-salvage: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
