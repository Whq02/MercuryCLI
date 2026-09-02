#!/usr/bin/env bun
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' /accent — session accent override (explicit beats derived)')
console.log('============================================================')

const sa = (await import('../../src/components/mercury-ui/sessionAccent.js')) as typeof import('../../src/components/mercury-ui/sessionAccent.js')

const baseline = sa.getSessionAccent()
check('baseline: no override active', sa.getSessionAccentOverride() === null)

check('set #dd44aa → accepted', sa.setSessionAccentOverride('#dd44aa') === true)
check('override wins getSessionAccent()', sa.getSessionAccent().accent === '#dd44aa')
check('deep companion derived darker', sa.getSessionAccent().accentDeep !== '#dd44aa' && /^#[0-9a-f]{6}$/.test(sa.getSessionAccent().accentDeep))
check('set bare dd44bb (no #) → accepted', sa.setSessionAccentOverride('dd44bb') === true && sa.getSessionAccent().accent === '#dd44bb')
check('set #fa0 shorthand → expands', sa.setSessionAccentOverride('#fa0') === true && sa.getSessionAccent().accent === '#ffaa00')

check('junk "cute" refused', sa.setSessionAccentOverride('cute') === false && sa.getSessionAccent().accent === '#ffaa00')
check('junk "#12345" refused', sa.setSessionAccentOverride('#12345') === false)

check('clear → true (was active)', sa.setSessionAccentOverride(null) === true)
check('cleared: derived chain restored', sa.getSessionAccent().accent === baseline.accent && sa.getSessionAccent().accentDeep === baseline.accentDeep)
check('clear again → false (no-op)', sa.setSessionAccentOverride(null) === false)

check('deepOf darkens each channel', sa.deepOf('#808080') === '#484848')
check('deepOf passes junk through', sa.deepOf('nope') === 'nope')

check('snapshot key: baseline carries no override', !sa.getSessionAccentSnapshotKey().includes('#'))
sa.setSessionAccentOverride('#00ff00')
check('snapshot key CHANGES on override set (the re-render trigger)', sa.getSessionAccentSnapshotKey().includes('#00ff00'))
sa.setSessionAccentOverride(null)
check('snapshot key reverts on clear', !sa.getSessionAccentSnapshotKey().includes('#'))
{
  const srcText = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'components', 'mercury-ui', 'sessionAccent.ts'),
    'utf-8',
  )
  const overrideMerges = (srcText.match(/accent: accentOverride\.accent, accentDeep: accentOverride\.accentDeep/g) ?? []).length
  check('the ONE derivation honors the override (tint axes only, identity live)', overrideMerges === 1, `merges found: ${overrideMerges}`)
  check('the unified hook snapshots on the override-aware key', (srcText.match(/getSessionAccentSnapshotKey,\n\s*getSessionAccentSnapshotKey,/g) ?? []).length >= 1)
  check('the ONE derivation folds the scribe glow (no second read path)', /export function getSessionAccent\(\): Critter \{[\s\S]*?return applyScribeGlow\(base\)/.test(srcText))
  check('the unified hook DELEGATES to the one derivation', /export function useSessionAccent\(\): Critter \{[\s\S]*?return getSessionAccent\(\)/.test(srcText))
}

const ROOT = join(import.meta.dir, '..', '..')
const cmd = readFileSync(join(ROOT, 'src', 'commands', 'accent', 'accent.ts'), 'utf-8')
check('command: named swatches import tokens (no raw hex literals)', !/'#[0-9a-fA-F]{3,6}'/.test(cmd))
check('command: reset path present', /reset/.test(cmd) && /setSessionAccentOverride\(null\)/.test(cmd))
const reg = readFileSync(join(ROOT, 'src', 'commands.ts'), 'utf-8')
check('registered in the Mercury surface array (unconditional)', /\n  accent,\n  authority,\n/.test(reg))

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL ACCENT-OVERRIDE PROOFS PASS')
else console.log(`❌ ${failures} ACCENT PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
