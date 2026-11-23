#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerGeneratedAsset, registerOnlyRequested } from '../lib/generated-assets-map.mjs'

const INVENTORY = join(import.meta.dir, 'contract-inventory.json')
const record = process.argv.includes('--record')
const ROW = {
  assets: 'scripts/ownership/contract-inventory.json',
  generator: 'bun scripts/ownership/prove-contract-inventory.ts --record',
  check: 'bun scripts/ownership/prove-contract-inventory.ts',
  sources: 'files-of:scripts/ownership/contract-inventory.json',
}
if (registerOnlyRequested(ROW)) process.exit(0)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' Core-ownership contract inventory — settings keys')
console.log('============================================================')

section('(1) settings-key registry (live SettingsSchema shape)')
let settingsKeys: string[] = []
{
  const { SettingsSchema } = await import('../../src/platform/settings/settingsSchema.ts')
  const schema = SettingsSchema() as unknown as { shape?: Record<string, unknown> }
  const shape =
    schema.shape ??
    (schema as unknown as { _def?: { shape?: () => Record<string, unknown> } })._def?.shape?.()
  settingsKeys = shape ? Object.keys(shape).sort() : []
  check('SettingsSchema shape enumerable', settingsKeys.length > 0, 'SettingsSchema in src/platform/settings/settingsSchema.ts no longer exposes a readable key shape; keep it a zod object, or change how this script reads it')
}

interface Inventory {
  settingsKeys: string[]
  [key: string]: unknown
}

if (record) {
  const existing = existsSync(INVENTORY)
    ? (JSON.parse(readFileSync(INVENTORY, 'utf-8')) as Record<string, unknown>)
    : {}
  const inv: Inventory = { ...existing, settingsKeys }
  writeFileSync(INVENTORY, JSON.stringify(inv, null, 1) + '\n')
  registerGeneratedAsset(ROW)
  console.log(`  [RECORDED] ${settingsKeys.length} settings key(s) → ${INVENTORY}`)
} else {
  section('(2) verify against the recorded inventory')
  if (!existsSync(INVENTORY)) {
    check('inventory exists (run --record first)', false, 'run bun scripts/ownership/prove-contract-inventory.ts --record to write scripts/ownership/contract-inventory.json')
  } else {
    const inv = JSON.parse(readFileSync(INVENTORY, 'utf-8')) as Inventory
    const curKeys = new Set(settingsKeys)
    const recKeys = new Set(inv.settingsKeys)
    const missingKeys = inv.settingsKeys.filter(k => !curKeys.has(k))
    const addedKeys = settingsKeys.filter(k => !recKeys.has(k))
    check(
      `settings keys (${inv.settingsKeys.length} recorded)`,
      missingKeys.length === 0 && addedKeys.length === 0,
      [
        missingKeys.length ? `DISAPPEARED: ${missingKeys.join(', ')}` : '',
        addedKeys.length ? `UNRECORDED: ${addedKeys.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join(' · ') + ' · if the change is intended, run bun scripts/ownership/prove-contract-inventory.ts --record and commit scripts/ownership/contract-inventory.json; otherwise restore the key in SettingsSchema (src/platform/settings/settingsSchema.ts)',
    )
  }
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(record ? ' ✅ INVENTORY RECORDED' : ' ✅ CONTRACT INVENTORY GREEN')
  process.exit(0)
} else {
  console.log(` ❌ ${failures} CONTRACT-INVENTORY FAILURE(S)`)
  process.exit(1)
}
