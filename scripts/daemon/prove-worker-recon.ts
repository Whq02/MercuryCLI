#!/usr/bin/env bun
// ============================================================================
//  scripts/daemon/prove-worker-recon.ts — the daemon-worker recon allowlist
//  (src/daemon/workerRecon.ts), the read-only rule set every daemon-spawned
//  worker rides so a classifier fault can never blind it.
//
//  The laws (the successor of the retired router party's return-leg rows,
//  which pinned the same resolver under its old name):
//    §1 unset ⇒ the builtin read-only set; every entry is a Tool(specifier)
//       rule and none can mutate, execute repo content or leave the machine
//    §2 '0' ⇒ EMPTY (the operator kills the allowlist; every bash rides the
//       classifier)
//    §3 a CSV extension APPENDS the valid rules and DROPS the invalid ones
//       loudly — a bare tool name (`Bash`) or a wildcard specifier
//       (`Bash(*)`, `Read(:*)`) never widens the set
//    §4 every daemon worker kind reads THIS resolver (source pins): the crew
//       spawn, the roster's one-shots, the daemon's scheduled runs
//
//  Run:  ~/.bun/bin/bun run scripts/daemon/prove-worker-recon.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const saved = process.env.MERCURY_WORKER_RECON_ALLOW
delete process.env.MERCURY_WORKER_RECON_ALLOW

const { SEAT_RECON_ALLOW, isValidReconAllowRule, resolveWorkerReconAllow } = await import('../../src/daemon/workerRecon.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' daemon — the worker recon allowlist')
console.log('============================================================')

console.log('\n§1 unset ⇒ the builtin read-only set')
{
  const set = resolveWorkerReconAllow()
  check('unset resolves to the builtin set, by reference', set === SEAT_RECON_ALLOW)
  check('the builtin set is non-empty', set.length > 0)
  check('every builtin entry is a Tool(specifier) rule', set.every(isValidReconAllowRule), set.join(','))
  const MUTATING = /Bash\((find|rm|mv|cp|git (branch|push|reset|checkout|commit)|curl|wget|node|bun|python)/
  check('no builtin entry can mutate, execute repo content or leave the machine', !set.some(r => MUTATING.test(r)))
}

console.log('\n§2 the operator kill')
{
  process.env.MERCURY_WORKER_RECON_ALLOW = '0'
  check("'0' ⇒ EMPTY (every bash rides the classifier)", resolveWorkerReconAllow().length === 0)
  process.env.MERCURY_WORKER_RECON_ALLOW = '  '
  check('blank ⇒ the builtin set', resolveWorkerReconAllow() === SEAT_RECON_ALLOW)
  delete process.env.MERCURY_WORKER_RECON_ALLOW
}

console.log('\n§3 the CSV extension')
{
  process.env.MERCURY_WORKER_RECON_ALLOW = 'Bash(bun run scripts/x/run-all.sh),Bash,Bash(*),Read(*),Read(:*),nonsense,Edit(src/*)'
  const extended = resolveWorkerReconAllow()
  check('a valid CSV extension is appended', extended.includes('Bash(bun run scripts/x/run-all.sh)'))
  check('…after the builtin set, which is kept whole', SEAT_RECON_ALLOW.every(r => extended.includes(r)) && extended.length === SEAT_RECON_ALLOW.length + 2)
  check('a bare tool name never widens the set', !extended.includes('Bash'))
  check('wildcard specifiers never widen the set', !extended.includes('Bash(*)') && !extended.includes('Read(*)') && !extended.includes('Read(:*)'))
  check('a non-rule entry is dropped', !extended.includes('nonsense'))
  check('a scoped rule for another tool is accepted', extended.includes('Edit(src/*)'))
  delete process.env.MERCURY_WORKER_RECON_ALLOW
  check('isValidReconAllowRule: shape law', isValidReconAllowRule('Bash(git status:*)') && !isValidReconAllowRule('Bash') && !isValidReconAllowRule('Bash(*)') && !isValidReconAllowRule('bash(ls)'))
}

console.log('\n§4 every daemon worker kind reads the one resolver')
{
  const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
  const crew = read('src/daemon/crewSpawn.ts')
  const roster = read('src/daemon/roster.ts')
  const main = read('src/daemon/main.ts')
  check('the crew spawn floor rides resolveWorkerReconAllow', crew.includes("from './workerRecon.js'") && crew.includes('allowedTools: resolveWorkerReconAllow()'))
  check("the roster's one-shots ride it", roster.includes("from './workerRecon.js'") && roster.includes('allowedTools: resolveWorkerReconAllow()'))
  // The scheduled-run site died with the legacy engine and the daemon's own
  // seat block left with its estate: the crew spawn and the roster are the
  // two readers, and main.ts carries none of its own.
  check('the daemon main carries no recon read of its own (the two spawn seams are the readers)', !main.includes("from './workerRecon.js'") && !/allowedTools: resolveWorkerReconAllow\(\)/.test(main))
  check('no worker builder carries a second recon table', !/SEAT_RECON_ALLOW\s*[:=]/.test(crew + roster + main))
}

if (saved !== undefined) process.env.MERCURY_WORKER_RECON_ALLOW = saved
console.log(failures === 0 ? '\n ✅ WORKER RECON ALLOWLIST HOLDS' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
