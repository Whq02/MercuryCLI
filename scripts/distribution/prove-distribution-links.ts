#!/usr/bin/env bun
// ============================================================================
//  scripts/distribution/prove-distribution-links.ts — presentation link integrity.
//
//  Every inline MARKDOWN LINK ([label](path)) in the ACTIVE reader route
//  must resolve: README.md, docs/README.md (the documentation map),
//  docs/COMPATIBILITY.md. (Backticked prose
//  paths and reference-style links are outside this prover's scope.) Also
//  pins the presentation truths: the README carries the private/non-launch
//  status, the notices pointer, the model default, and the two map links.
//
//  Run: ~/.bun/bin/bun run scripts/distribution/prove-distribution-links.ts
// ============================================================================
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

console.log('signature links — active-route presentation integrity')

const ACTIVE = [
  'README.md',
  'docs/README.md',
  'docs/COMPATIBILITY.md',
]

for (const rel of ACTIVE) {
  const p = join(ROOT, rel)
  if (!existsSync(p)) {
    check(`${rel} exists`, false)
    continue
  }
  const text = readFileSync(p, 'utf8')
  const broken: string[] = []
  // Markdown links to local targets: [label](path) — skip http(s) + anchors.
  for (const m of text.matchAll(/\]\(([^)#\s]+)(?:#[^)\s]*)?\)/g)) {
    const target = m[1]
    if (/^[a-z]+:\/\//.test(target) || target.startsWith('mailto:')) continue
    const abs = resolve(dirname(p), target)
    if (!existsSync(abs)) broken.push(target)
  }
  check(`${rel}: all local links resolve`, broken.length === 0, broken.slice(0, 5).join(', '))
}

const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
// The README carries no privacy/no-launch-date sentence; the standing
// presentation truth is the PRIVATE RELEASE CHANNEL the install section
// speaks.
check('README names the private release channel', /private release channel/.test(readme))
check('README carries the notices pointer', readme.includes('THIRD_PARTY_NOTICES.md'))
check('README states the computed default: the provider of the most recent sign-in', /most recent sign-in/.test(readme))
check('README links the documentation map', readme.includes('docs/README.md'))
check('README links the root guide', readme.includes('AGENTS.md'))
check('README compatibility section points at the seam map', readme.includes('docs/COMPATIBILITY.md'))

// The docs map must route every standing subject.
const map = readFileSync(join(ROOT, 'docs/README.md'), 'utf8')
// 'Multiplayer' left this list when the estate left the tree (the guest
// verbs answer typed retirements; the docs speak the shipped product).
// 'Saturn' and 'Kit' joined when their pages landed.
for (const subject of ['Getting started', 'Operator guide', 'Keyboard', 'Capabilities', 'Architecture', 'Providers', 'Sessions', 'Extensions', 'Saturn', 'Kit', 'Releases', 'Direction']) {
  check(`docs map routes: ${subject}`, new RegExp(subject, 'i').test(map))
}

if (failures > 0) {
  console.log(`\nsignature links: RED (${failures})`)
  process.exit(1)
}
console.log('\nsignature links: green')
