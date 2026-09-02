#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'fs'
import { join } from 'path'
import { isRetryableSpawnReplyCode } from '../../src/utils/crew/crewClient.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('crew spawn retry + hidden daemon console (the field class)')

check('ESTARTING retries', isRetryableSpawnReplyCode('ESTARTING'))
check('ENOCONN retries (the field ENOENT class)', isRetryableSpawnReplyCode('ENOCONN'))
check('ETIMEOUT retries', isRetryableSpawnReplyCode('ETIMEOUT'))
check('EUNKNOWN is a real refusal', !isRetryableSpawnReplyCode('EUNKNOWN'))
check('ECAP-style refusals never retry', !isRetryableSpawnReplyCode('ECAP'))
check('undefined code never retries', !isRetryableSpawnReplyCode(undefined))

const repoRoot = join(import.meta.dir, '..', '..')
const crewClient = readFileSync(join(repoRoot, 'src/utils/crew/crewClient.ts'), 'utf8')
check(
  'spawn loop consults isRetryableSpawnReplyCode (never an ESTARTING-only branch)',
  /isRetryableSpawnReplyCode\(reply\.code\)/.test(crewClient),
)
const ownedDaemon = readFileSync(join(repoRoot, 'src/daemon/ownedDaemon.ts'), 'utf8')
check('spawnOwnedDaemon hides the win32 console (windowsHide)', /windowsHide: true/.test(ownedDaemon))
const headlessRun = readFileSync(join(repoRoot, 'src/daemon/headlessRun.ts'), 'utf8')
check(
  'EVERY daemon worker spawn hides the win32 console (one-shot + long-lived)',
  (headlessRun.match(/windowsHide: true/g) ?? []).length >= 2,
)

const { decideOwnedSpawn, OWNED_SPAWN_SESSION_CAP } = await import('../../src/daemon/ownedDaemon.js')
check('first spawn fires', decideOwnedSpawn(undefined, 1_000_000) === 'spawn')
check(
  'an immediate respawn cools down',
  decideOwnedSpawn({ lastAt: 1_000_000, count: 1 }, 1_000_500) === 'cooldown',
)
check(
  'a respawn after the cooldown fires',
  decideOwnedSpawn({ lastAt: 1_000_000, count: 1 }, 1_040_000) === 'spawn',
)
check(
  'the session cap ends the loop for good',
  decideOwnedSpawn({ lastAt: 0, count: OWNED_SPAWN_SESSION_CAP }, 9_999_999_999) === 'capped',
)
check(
  'spawnOwnedDaemon consults the breaker before any spawn',
  /const verdict = decideOwnedSpawn\(history, now\)/.test(ownedDaemon),
)

console.log('\n' + '='.repeat(76))
if (failures === 0) {
  console.log('✅ CREW SPAWN RETRY: green')
  process.exit(0)
} else {
  console.log(`❌ CREW SPAWN RETRY: ${failures} check(s) failed`)
  process.exit(1)
}
