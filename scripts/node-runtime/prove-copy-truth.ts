#!/usr/bin/env bun
// ============================================================================
//  scripts/node-runtime/prove-copy-truth.ts — every live product surface says
//  "Node 24 LTS"; no live surface still claims Node 18/20. Third-party tool
//  requirements quoted inside bundled skills are excluded through the
//  REVIEWED allowlist below (each entry carries its reason), never rewritten.
// ============================================================================
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NODE_SUPPORT } from '../../src/utils/runtime/nodePolicy.js'

const REPO = join(import.meta.dir, '..', '..')
let failures = 0
const check = (name: string, cond: boolean, detail?: string): void => {
  if (cond) console.log(`  [PASS] ${name}`)
  else {
    failures++
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
const section = (s: string): void => console.log(`\n── ${s} ──`)
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')

// ---------------------------------------------------------------------------
section('(1) live surfaces carry the generated label')
const LABEL = NODE_SUPPORT.label
const LIVE: Array<[string, (t: string) => boolean, string]> = [
  ['README.md', t => (t.match(/Node 24 LTS/g) ?? []).length >= 3 && t.includes(NODE_SUPPORT.range), 'three sites + the range'],
  ['BUILD-NOTES.md', t => t.includes('three truths') && t.includes(NODE_SUPPORT.range) && t.includes('.node-version'), 'the runtime-contract section'],
  ['.github/workflows/private-release.yml', t => t.includes('carries its own Node 24 LTS runtime'), 'generated release notes'],
]
for (const [rel, ok, what] of LIVE) {
  check(`${rel}: ${what}`, ok(read(rel)))
}

// ---------------------------------------------------------------------------
section('(2) the stale-claim ratchet (reviewed allowlist, never a rewrite)')
// Reviewed exclusions — every entry names its reason:
const ALLOW: Array<[string, string]> = [
  ['src/skills/bundled/', 'bundled skill content describes third-party tool requirements, not Mercury (category 7)'],
  ['mercury-skills/', 'the same content at its source (category 7)'],
  ['src/constants/changelog.ts', 'dated release history — 1.1.0 shipped on Node 20 (category 6)'],
  ['src/services/providers/anthropic/streamCore.ts', 'eslint justification naming the Node version an API landed in (category 8)'],
  ['src/run-core/turn-machine.ts', 'bug-context comment naming the Node-18-era cause (category 6)'],
  ['src/utils/filePersistence/outputsScanner.ts', 'API-availability comment (parentPath, category 8)'],
  ['scripts/node-runtime/', 'these provers name the forbidden strings'],
]
const STALE = [
  /\bNode(\.js)?\s*(18|20)\s*\+/, // "Node 20+", "Node.js 18+"
  /\bNode\s*(18|20)\s+or\s+(higher|newer)/i,
  /\bNode\s*(18|20)\b/, // any bare live claim — the census says only fixed/allowlisted files carry one
]
const tracked = execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' }).trim().split('\n')
const offenders: string[] = []
for (const rel of tracked) {
  if (ALLOW.some(([prefix]) => rel.startsWith(prefix))) continue
  if (/\.(png|jpg|jpeg|gif|webp|ico|wasm|zip|gz|pdf|woff2?)$/i.test(rel)) continue
  let text: string
  try {
    text = read(rel)
  } catch {
    continue
  }
  for (const re of STALE) {
    const m = re.exec(text)
    if (m) {
      offenders.push(`${rel}: "${m[0]}"`)
      break
    }
  }
}
check('no live tracked surface claims Node 18/20', offenders.length === 0, offenders.slice(0, 8).join(' · '))
check('the allowlist is itself reviewed (every entry carries a reason)', ALLOW.every(([, reason]) => reason.length > 10))

// ---------------------------------------------------------------------------
section('(3) never "Node 24+" — the unqualified-major claim is banned in live copy')
const PLUS_ALLOW = new Set(['scripts/node-runtime/prove-copy-truth.ts'])
const plusOffenders: string[] = []
for (const rel of tracked) {
  if (ALLOW.some(([prefix]) => rel.startsWith(prefix)) || PLUS_ALLOW.has(rel)) continue
  if (/\.(png|jpg|jpeg|gif|webp|ico|wasm|zip|gz|pdf|woff2?)$/i.test(rel)) continue
  let text: string
  try {
    text = read(rel)
  } catch {
    continue
  }
  if (/\bNode(\.js)?\s*24\s*\+/.test(text)) plusOffenders.push(rel)
}
check('no live surface says "Node 24+"', plusOffenders.length === 0, plusOffenders.slice(0, 5).join(', '))

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ COPY TRUTH PROOFS PASS')
  process.exit(0)
}
console.log(` ❌ ${failures} CHECK(S) FAILED`)
process.exit(1)
