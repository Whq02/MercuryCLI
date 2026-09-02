#!/usr/bin/env bun
// ============================================================================
//  scripts/health/prove-keybindings-row-loads.ts — the keybindings doctor
//  row LOADS the file instead of trusting a cache the CLI verb never fills
//  (FC-152): a truncated keybindings.json read "no keybinding-file warnings
//  this session" on every doctor run.
//
//  Run: ~/.bun/bin/bun run scripts/health/prove-keybindings-row-loads.ts
// ============================================================================
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'kb-row-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

// A truncated, invalid keybindings.json in the scratch home.
writeFileSync(join(HOME, 'keybindings.json'), '{ "bindings": [ { "key": "ctrl+')

const kbRow = async (): Promise<{ status: string; evidence: string }> => {
  const report = await import('../../src/utils/healthReport.js')
  const cert = await report.runHealthReport({ depth: 'fast' })
  const row = cert.sections.flatMap(s => s.checks).find(c => c.id === 'keybindings')
  return { status: String(row?.status), evidence: String(row?.evidence) }
}

const row = await kbRow()
check(
  'a broken keybindings.json WARNS on a one-shot doctor run (the cache was never the answer)',
  row.status === 'warn' && !row.evidence.includes('no keybinding-file warnings'),
  `${row.status}: ${row.evidence.slice(0, 120)}`,
)

writeFileSync(join(HOME, 'keybindings.json'), JSON.stringify({ bindings: [] }))
const { invalidateKeybindingsCache } = await import('../../src/keybindings/loadUserBindings.js')
invalidateKeybindingsCache()
const clean = await kbRow()
check('a clean file reads ok (control)', clean.status === 'ok', `${clean.status}: ${clean.evidence.slice(0, 80)}`)

rmSync(HOME, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-keybindings-row-loads: all green' : `\nprove-keybindings-row-loads: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
