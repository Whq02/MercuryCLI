#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let fail = 0
function check(label: string, cond: boolean): void {
  if (!cond) fail++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`)
}
const roster = readFileSync(join(import.meta.dir, '..', '..', 'src', 'daemon', 'roster.ts'), 'utf-8')

console.log('============================================================')
console.log(' reconfigure-respawn — accurate respawnTimer, no stuck flag / dropped retarget')
console.log('============================================================')

const spawnIdx = roster.indexOf('private spawnLongLived(')
const spawnBody = spawnIdx !== -1 ? roster.slice(spawnIdx, spawnIdx + 1200) : ''
check('spawnLongLived clears the fired respawnTimer (clearTimeout)', /clearTimeout\(ll\.respawnTimer\)/.test(spawnBody))
check('spawnLongLived nulls ll.respawnTimer so it is not a stale truthy handle', /ll\.respawnTimer = undefined/.test(spawnBody))

const recfgIdx = roster.indexOf('private respawnForReconfigure(')
const recfgBody = recfgIdx !== -1 ? roster.slice(recfgIdx, recfgIdx + 1200) : ''
check('respawnForReconfigure: settled child (outcome) ⇒ direct revive', /if \(h\.entry\.outcome\)/.test(recfgBody) && /this\.spawnLongLived\(short\)/.test(recfgBody))
check('respawnForReconfigure: a PENDING respawn (respawnTimer) ⇒ let it fire (no SIGTERM of a dead child)', /if \(h\.longLived\.respawnTimer\)/.test(recfgBody))
check('respawnForReconfigure: a live child IS bounced (SIGTERM) when neither guard trips', /h\.child\?\.kill\('SIGTERM'\)/.test(recfgBody))

check('respawnTimer is set on the crash-backoff / reconfigure-respawn paths', /ll\.respawnTimer = setTimeout\(\(\) => this\.spawnLongLived\(short\)/.test(roster))

console.log('\n' + '═'.repeat(60))
if (fail === 0) console.log('✅ ALL RECONFIGURE-RESPAWN PROOFS PASS')
else console.log(`❌ ${fail} RECONFIGURE-RESPAWN PROOF(S) FAILED`)
console.log('═'.repeat(60))
process.exit(fail === 0 ? 0 : 1)
