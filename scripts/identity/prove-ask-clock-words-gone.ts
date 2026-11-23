#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(import.meta.dir, '..', '..')
const J = (...parts: string[]): string => parts.join('')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

console.log('§1 the spellings the per-mode ask clock shed are on no file name and in no file under src, scripts or docs')
const RETIRED_SPELLINGS = [
  J('FLOW_AWAY_', 'TIMEOUT_MS'),
  J('FLOW_AWAY_', 'MESSAGE'),
  J('the user is away; ', 'continue with an allowed tool call instead'),
  J('DEFAULT_PERMISSION_ASK_', 'EXPIRY_MINUTES'),
  J('permissionAsk', 'ExpiryMs'),
]
const TEXT = /\.(tsx?|mts|cts|[cm]?jsx?|sh|bash|json|jsonl|md|txt|tsv|csv|ya?ml|toml|html|css|ps1|py)$/
const SELF = relative(REPO, fileURLToPath(import.meta.url)).replaceAll('\\', '/')
const tree = execFileSync('git', ['-C', REPO, 'ls-files', '-z', '--', 'src', 'scripts', 'docs'], { encoding: 'utf8', maxBuffer: 1 << 28 })
  .split('\0')
  .filter(rel => rel !== '' && rel !== SELF && TEXT.test(rel))
const hits = new Map<string, string[]>()
for (const rel of tree) {
  const text = readFileSync(join(REPO, rel), 'utf8')
  for (const spelling of RETIRED_SPELLINGS) {
    if (rel.includes(spelling) || text.includes(spelling)) hits.set(spelling, [...(hits.get(spelling) ?? []), rel])
  }
}
check(`the seal reads the three trees (${tree.length} files)`, tree.length > 1000, 'git ls-files read too few files under src, scripts and docs; run this from the repository checkout')
for (const spelling of RETIRED_SPELLINGS) {
  const where = hits.get(spelling) ?? []
  check(`${spelling}: on no file name and in no file`, where.length === 0, where.slice(0, 6).join(' · ') + (where.length > 6 ? ` … (${where.length})` : '') + ' — remove the retired spelling from these files and from any file name, and use the ask clock owner src/permissions/rules/askClock.ts instead')
}

console.log('§2 the one owner stands')
{
  const { CREWMATE_ASK_LIMIT_MINUTES, FLOW_ASK_LIMIT_MINUTES, SOVEREIGN_ASK_LIMIT_MINUTES } = await import('../../src/permissions/rules/askClock.ts')
  check('the owner spells the three clocks', FLOW_ASK_LIMIT_MINUTES === 10 && SOVEREIGN_ASK_LIMIT_MINUTES === 3 && CREWMATE_ASK_LIMIT_MINUTES === 10, 'restore the three clock constants (flow 10, sovereign 3, crewmate 10 minutes) in src/permissions/rules/askClock.ts')
}

console.log(`\nask clock words gone: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
