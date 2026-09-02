#!/usr/bin/env bun
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const REPO = resolve(import.meta.dir, '..', '..')
const SRC = join(REPO, 'src')
const BASELINE = join(import.meta.dir, 'write-routes.baseline.json')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) sources(p, out)
    else if (/\.tsx?$/.test(e)) out.push(relative(REPO, p))
  }
  return out.sort()
}

const importsModule = (text: string, base: string): boolean =>
  new RegExp(`from\\s+'[^']*(?<![\\w-])${base}(\\.js|\\.ts)?'`).test(text) ||
  new RegExp(`require\\('[^']*(?<![\\w-])${base}'\\)`).test(text)

const files = sources(SRC)
const publish: string[] = []
const lock: string[] = []
const rawProperLockfile: string[] = []
const LOCK_OWNER = 'src/utils/lockfile.ts'

for (const f of files) {
  const text = readFileSync(join(REPO, f), 'utf8')
  if (importsModule(text, 'durablePublish')) publish.push(f)
  if (importsModule(text, 'lockfile') && f !== LOCK_OWNER) lock.push(f)
  if (/from\s+'proper-lockfile'|require\('proper-lockfile'\)/.test(text) && f !== LOCK_OWNER) {
    if (!/declare module 'proper-lockfile'/.test(text)) rawProperLockfile.push(f)
  }
}

if (process.argv.includes('--regen')) {
  writeFileSync(
    BASELINE,
    JSON.stringify({ note: 'legacy write-route ratchet — may only SHRINK', publish, lock }, null, 2) + '\n',
  )
  console.log(`regenerated baseline: ${publish.length} publish · ${lock.length} lock`)
  process.exit(0)
}

console.log('============================================================')
console.log(' legacy write-route ratchet')
console.log('============================================================')

const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as { publish: string[]; lock: string[] }

for (const [route, found, allowed] of [
  ['PUBLISH', publish, baseline.publish],
  ['LOCK', lock, baseline.lock],
] as const) {
  const added = found.filter(f => !allowed.includes(f))
  const removed = allowed.filter(f => !found.includes(f))
  check(
    `${route}: no NEW direct write route (${found.length} of ${allowed.length} baseline)`,
    added.length === 0,
    added.join(', '),
  )
  check(
    `${route}: baseline carries no migrated file (remove it from the baseline)`,
    removed.length === 0,
    removed.join(', '),
  )
}

check(
  `proper-lockfile is required only by its owner (${LOCK_OWNER})`,
  rawProperLockfile.length === 0,
  rawProperLockfile.join(', '),
)

const total = publish.length + lock.length
const start = baseline.publish.length + baseline.lock.length
console.log(
  `     ratchet: ${total} legacy write route(s) remain of ${start} pinned` +
    ` — ${publish.length} publish · ${lock.length} lock`,
)

console.log('════════════════════════════════════════════════════════════')
if (failures > 0) {
  console.error(`❌ ${failures} write-route check(s) failed`)
  process.exit(1)
}
console.log('✅ WRITE-ROUTE RATCHET HELD')
