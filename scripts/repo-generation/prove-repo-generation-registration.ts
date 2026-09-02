#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const bun = process.env.BUN ?? join(process.env.HOME ?? '', '.bun', 'bin', 'bun')
const worker = join(import.meta.dir, 'registration-worker.ts')

interface Probe {
  names: string[]
  daedalus: { hidden: boolean; source: string; phases: string[]; hasScript: boolean } | null
}
function probe(mode: 'fork' | 'plain', flag: string | undefined): Probe {
  const env = { ...process.env }
  delete env.MERCURY_DAEDALUS
  delete env.MERCURY_WORKFLOWS
  if (flag !== undefined) env.MERCURY_DAEDALUS = flag
  const r = spawnSync(bun, ['run', worker, mode], { env, encoding: 'utf8', timeout: 60_000 })
  if (r.status !== 0) {
    throw new Error(`registration worker (${mode}, flag=${String(flag)}) failed: ${r.stderr}`)
  }
  const lines = r.stdout.trim().split('\n').filter(l => l.trim())
  return JSON.parse(lines[lines.length - 1]!) as Probe
}

console.log('============================================================')
console.log(' DAEDALUS — registration gating proof (fresh-process probes)')
console.log('============================================================')

const off = probe('fork', undefined)
check('flag unset ⇒ EXACTLY the base built-in pair', JSON.stringify(off.names) === JSON.stringify(['code-review', 'deep-research']), off.names.join(','))
check('fork + flag unset ⇒ no daedalus descriptor', off.daedalus === null)

const zero = probe('fork', '0')
check("fork + flag='0' ⇒ still absent (opt-in requires '1')", !zero.names.includes('daedalus'))

const on = probe('fork', '1')
check('fork + flag=1 ⇒ daedalus registered beside the base pair', JSON.stringify(on.names) === JSON.stringify(['code-review', 'daedalus', 'deep-research']), on.names.join(','))
check('browsable (NOT hidden) + built-in source', on.daedalus !== null && on.daedalus.hidden === false && on.daedalus.source === 'built-in')
check('descriptor meta parsed from the script itself (6 phases)', on.daedalus !== null && on.daedalus.phases.join(',') === 'Preflight,Spec,Design,Implement,Test,Finalize')
check('descriptor carries the full script', on.daedalus !== null && on.daedalus.hasScript === true)

const plain = probe('plain', '1')
check('plain stamp + flag=1 ⇒ daedalus registered (stamp-independence)', plain.names.includes('daedalus'))

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(` FAIL — ${failures} check(s) failed`)
  process.exit(1)
}
console.log(' ALL DAEDALUS REGISTRATION PROOFS PASS')
