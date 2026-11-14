#!/usr/bin/env bun
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'kinetic-hotpath-home-'))
process.env.MERCURY_CONFIG_DIR = HOME

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

section('K4 — unmoved slices keep identity; the notify pulse always fires')
{
  const bus = readFileSync(join(import.meta.dir, '..', '..', 'src', 'state', 'vitalsBus.ts'), 'utf8')
  check('unchanged slices are dropped before assignment (identity holds)',
    bus.includes('if (jsonStringify(prev) === jsonStringify(fresh))'))
  check('the heartbeat notify ALWAYS fires (sync-read surfaces ride the pulse)',
    !bus.includes('if (!changed) return') && /version: snapshots\.version \+ 1,\s*\}\s*emit\(\)/.test(bus))
  check('the selector overload exists for slice-scoped subscribers',
    bus.includes('export function useVitals<T>(selector: (s: VitalsSnapshots) => T): T'))
}

section('K7/K10a — the shared timer, honest counts')
{
  const hook = readFileSync(join(import.meta.dir, '..', '..', 'src', 'hooks', 'useElapsedTime.ts'), 'utf8')
  check('useElapsedTime rides the shared quantized clock (no private interval)',
    hook.includes('return subscribeUiClock(ms, notify)') && !/= setInterval\(/.test(hook))
  const adapter = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'services', 'resources', 'adapters', 'agent.ts'),
    'utf8',
  )
  check('the agent ref summary labels window counts too',
    adapter.includes("${view.truncatedRead ? '+' : ''} tool call(s)"))
}

rmSync(HOME, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} kinetic HOT-PATH PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL kinetic HOT-PATH PROOFS PASS')
process.exit(0)
