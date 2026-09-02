#!/usr/bin/env bun
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const hits = execSync(`grep -rln '<MessageRow' src/components src/screens src/tools 2>/dev/null || true`, {
  cwd: ROOT,
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .filter(Boolean)
  .sort()

const INVENTORY = ['src/components/Messages.tsx', 'src/components/concourse/SessionMirror.tsx']
t('§1 the MessageRow mount census matches the inventory', JSON.stringify(hits) === JSON.stringify(INVENTORY), `found: ${hits.join(', ') || '(none)'}`)

for (const file of INVENTORY) {
  const lines = readFileSync(join(ROOT, file), 'utf8').split('\n')
  const mounts: number[] = []
  lines.forEach((l, i) => {
    if (l.includes('<MessageRow') && !l.includes('import')) mounts.push(i)
  })
  t(`§2 ${file} mounts MessageRow at least once`, mounts.length > 0)
  for (const at of mounts) {
    const above = lines.slice(Math.max(0, at - 30), at).join('\n')
    t(`§2 ${file}:${at + 1} mount is contained (SentryErrorBoundary opens above it)`, above.includes('<SentryErrorBoundary'), 'a bare MessageRow mount — one poisoned row would end the session here')
  }
}

console.log(failures === 0 ? 'ROW-BOUNDARY CENSUS: ALL PASS' : 'ROW-BOUNDARY CENSUS: RED')
process.exit(failures)
