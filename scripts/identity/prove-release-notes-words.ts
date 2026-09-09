#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

function sectionOf(changelog: string, version: string | null): { bullets: string[]; strays: string[] } {
  const lines = changelog.split('\n')
  const start = version === null ? lines.findIndex(l => l.startsWith('## ')) : lines.findIndex(l => l.trim() === `## ${version}`)
  if (start < 0) return { bullets: [], strays: [`no section ${version ?? '(newest)'}`] }
  const body: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ') || line.startsWith('`')) break
    body.push(line)
  }
  return {
    bullets: body.filter(l => l.trim().startsWith('- ')).map(l => l.trim().slice(2)),
    strays: body.filter(l => l.trim() !== '' && !l.trim().startsWith('- ')),
  }
}

const HOUSE_WORDS: Array<[string, RegExp]> = [
  ['door', /\bdoors?\b/i],
  ['road', /\broads?\b/i],
  ['seat (outside /seats)', /(?<!\/)\bseats?\b/i],
  ['fold', /\bfold(s|ed|ing)?\b/i],
  ['ladder', /\bladders?\b/i],
  ['lane', /\blanes?\b/i],
  ['owner', /\bowners?\b/i],
  ['law', /\blaws?\b/i],
  ['pin', /\bpin(s|ned)?\b/i],
  ['prover', /\bprovers?\b/i],
  ['turn receipt', /turn receipt/i],
  ['supercode (outside /supercode)', /(?<!\/)\bsupercode\b/i],
]
const houseWordHits = (bullets: string[]): string[] =>
  bullets.flatMap((b, i) => HOUSE_WORDS.filter(([, re]) => re.test(b)).map(([label]) => `bullet ${i + 1}: ${label}`))

console.log('============================================================')
console.log(' release notes — the plain words')
console.log('============================================================')

{
  const fixture = ['# x', '', '## 9.9.9', '- Added a browser road for /bug, each with its own door', '- a note wrapped', '  onto a second line', '- /supercode and /seats are commands', '', '## 9.9.8', '- older', '`'].join('\n')
  const s = sectionOf(fixture, null)
  check('self-test: the newest section is the first one, strays counted', s.bullets.length === 3 && s.strays.length === 1, JSON.stringify(s))
  check('self-test: the planted words trip (road · door)', houseWordHits(s.bullets).length === 2, houseWordHits(s.bullets).join(' · '))
  check('self-test: the slash commands stay silent', houseWordHits(['/supercode and /seats are commands']).length === 0)
  check('self-test: an older section is reachable by name', sectionOf(fixture, '9.9.8').bullets.length === 1)
}

const changelog = readFileSync(join(ROOT, 'src', 'constants', 'changelog.ts'), 'utf8')
const newest = sectionOf(changelog, null)
check(`§1 the newest section is bullets only (${newest.bullets.length} bullets)`, newest.bullets.length > 0 && newest.strays.length === 0, newest.strays.slice(0, 3).join(' | '))
const hits = houseWordHits(newest.bullets)
check('§2 the newest section carries no house word', hits.length === 0, hits.slice(0, 8).join(' · '))

const beta4 = sectionOf(changelog, '1.0.0-beta.4').bullets.join('\n')
check('§3 beta.4: the speech model is fetched behind /speak download and nothing downloads on first use', beta4.includes('/speak download') && !beta4.includes('first use downloads'))
check("§3 beta.4: the shell engine's two Windows limits are named", beta4.includes('cmd /c npm') && beta4.includes('relative path after a cd'))

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ release-notes words: ${failures} FAILED`)
  process.exit(1)
}
console.log('✅ release-notes words: clean')
