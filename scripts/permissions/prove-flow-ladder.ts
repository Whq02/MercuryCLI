#!/usr/bin/env bun
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

console.log('============================================================')
console.log(' Permission ladder / flow — surface proof')
console.log('============================================================')


section('dist ships the flow decision branches (the five, the floors, kill deny)')
{
  const dist = join(import.meta.dir, '..', '..', 'dist', 'mercury.mjs')
  if (!existsSync(dist)) {
    console.log('  [SKIP] dist/mercury.mjs not built — run `bun run build.ts` to grep-verify the shipped branches')
  } else {
    const present = (needle: string): boolean =>
      execSync(`grep -F -c ${JSON.stringify(needle)} ${JSON.stringify(dist)} || true`, { encoding: 'utf-8' }).trim() !== '0'
    check('the ask sentence shape ships', present('Flow asks before '), 'rebuild with `bun run build.ts`; the ask sentence comes from the ask builder in src/utils/permissions/flowLaw.ts')
    check('the five\'s reasons ship', present('it runs with elevated rights') && present('it publishes history') && present('it publishes a package') && present(', outside the project'), 'rebuild with `bun run build.ts`; the reason strings live in src/utils/permissions/flowLaw.ts')
    check('the Flow allow log ships', present('none of the five'), 'rebuild with `bun run build.ts`; the log line is in src/utils/permissions/decision/wrapper.ts')
    check('no denial ledger ships', !present('actions were blocked this session') && !present('consecutive actions were blocked') && !present('denial limit reached'), 'remove the denial ledger text from src/ and rebuild with `bun run build.ts`')
    check('capability kill-switch deny message ships', present('capability switched off by operator'), 'rebuild with `bun run build.ts`; the deny message is in src/utils/permissions/decision/engine.ts')
    check('the old shortcuts do not ship', !present('implement mode would allow this outright') && !present('PowerShell runs only with interactive approval'), 'remove the old shortcut text from src/utils/permissions and rebuild with `bun run build.ts`')
  }
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL PERMISSION / FLOW PROOFS PASS')
else console.log(`❌ ${failures} PERMISSION / FLOW PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
