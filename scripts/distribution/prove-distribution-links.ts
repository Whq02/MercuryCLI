#!/usr/bin/env bun
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
  for (const m of text.matchAll(/\]\(([^)#\s]+)(?:#[^)\s]*)?\)/g)) {
    const target = m[1]
    if (/^[a-z]+:\/\//.test(target) || target.startsWith('mailto:')) continue
    const abs = resolve(dirname(p), target)
    if (!existsSync(abs)) broken.push(target)
  }
  check(`${rel}: all local links resolve`, broken.length === 0, broken.slice(0, 5).join(', '))
}

const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
check('README carries the notices pointer', readme.includes('THIRD_PARTY_NOTICES.md'))

if (failures > 0) {
  console.log(`\nsignature links: RED (${failures})`)
  process.exit(1)
}
console.log('\nsignature links: green')
