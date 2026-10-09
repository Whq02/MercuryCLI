#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

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
const SELF = relative(REPO, new URL(import.meta.url).pathname)
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
check(`the seal reads the three trees (${tree.length} files)`, tree.length > 1000)
for (const spelling of RETIRED_SPELLINGS) {
  const where = hits.get(spelling) ?? []
  check(`${spelling}: on no file name and in no file`, where.length === 0, where.slice(0, 6).join(' · ') + (where.length > 6 ? ` … (${where.length})` : ''))
}

console.log('§2 the one owner stands and the three roads read it')
{
  const owner = readFileSync(join(REPO, 'src/utils/permissions/askClock.ts'), 'utf8')
  check('the owner spells the three clocks', owner.includes('FLOW_ASK_LIMIT_MINUTES = 10') && owner.includes('SOVEREIGN_ASK_LIMIT_MINUTES = 3') && owner.includes('CREWMATE_ASK_LIMIT_MINUTES = 10'))
  for (const road of ['src/hooks/toolPermission/handlers/interactiveHandler.ts', 'src/cli/headless/runnerAsks.ts', 'src/daemon/permissionAsks.ts']) {
    const text = readFileSync(join(REPO, road), 'utf8')
    check(`${road} reads the owner`, text.includes("from '../../../utils/permissions/askClock.js'") || text.includes("from '../../utils/permissions/askClock.js'") || text.includes("from '../utils/permissions/askClock.js'"))
    check(`${road} spells no clock of its own`, !/\b(?:5|10|3)\s*\*\s*60_000\b/.test(text) && !/\b(?:300_000|600_000|180_000)\b/.test(text))
  }
}

console.log(`\nask clock words gone: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
