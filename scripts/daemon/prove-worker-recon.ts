#!/usr/bin/env bun
import { join } from 'node:path'

const saved = process.env.MERCURY_WORKER_RECON_ALLOW
delete process.env.MERCURY_WORKER_RECON_ALLOW

const { SEAT_RECON_ALLOW, isValidReconAllowRule, resolveWorkerReconAllow } = await import('../../src/daemon/concourse-workers/workerRecon.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  const hint = 'change: SEAT_RECON_ALLOW, isValidReconAllowRule or resolveWorkerReconAllow in src/daemon/concourse-workers/workerRecon.ts'
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${[detail, hint].filter(Boolean).join(' | ')}` : ''}`)
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
  process.env.MERCURY_WORKER_RECON_ALLOW = 'Bash(bun run scripts/x/run-all.sh),Bash,Bash(*),Read(*),Read( *),nonsense,Edit(src/*)'
  const extended = resolveWorkerReconAllow()
  check('a valid CSV extension is appended', extended.includes('Bash(bun run scripts/x/run-all.sh)'))
  check('…after the builtin set, which is kept whole', SEAT_RECON_ALLOW.every(r => extended.includes(r)) && extended.length === SEAT_RECON_ALLOW.length + 2)
  check('a bare tool name never widens the set', !extended.includes('Bash'))
  check('wildcard specifiers never widen the set', !extended.includes('Bash(*)') && !extended.includes('Read(*)') && !extended.includes('Read( *)'))
  check('a non-rule entry is dropped', !extended.includes('nonsense'))
  check('a scoped rule for another tool is accepted', extended.includes('Edit(src/*)'))
  delete process.env.MERCURY_WORKER_RECON_ALLOW
  check('isValidReconAllowRule: shape law', isValidReconAllowRule('Bash(git status *)') && !isValidReconAllowRule('Bash') && !isValidReconAllowRule('Bash(*)') && !isValidReconAllowRule('bash(ls)'))
}


if (saved !== undefined) process.env.MERCURY_WORKER_RECON_ALLOW = saved
console.log(failures === 0 ? '\n ✅ WORKER RECON ALLOWLIST HOLDS' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
