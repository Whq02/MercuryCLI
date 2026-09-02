#!/usr/bin/env bun
// ============================================================================
//  scripts/ide/prove-blender-debug.ts
//  PROOF: the debugpy-attach-INTO-Blender recipe (zero new machinery —
//  the landed attach road carries it).
//
//   §1  the listen expression: bundled road (sys.path.insert of the vendor
//       tree, JSON-quoted) vs the pip road (no path arm); the port spells.
//   §2  the recipe steps contract: the operator line, the Debug attach op
//       naming adapter python + the connect contract, the wait_for_client
// teaching, and THE WEDGE CITATION verbatim enough to
//       find the receipt.
//   §3  the profile row: armed ⇒ ONE debug-kind recipe row riding the
//       operator-run payload (--python-expr with the exact expr); off ⇒
//       nothing (rides the §1 polarity of the blender source).
//   §4  the attach side EXISTS: the python adapter row resolves with the
//       connect attach shape (the landed contract this recipe rides).
//
//  cpu-pure. Run: ~/.bun/bin/bun run scripts/ide/prove-blender-debug.ts
// ============================================================================
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' blender debugpy-attach recipe — proof')
console.log('============================================================')

const {
  blenderDebugListenExpr,
  blenderDebugRecipe,
  BLENDER_DEBUG_DEFAULT_PORT,
} = await import('../../src/services/ide/blenderDebug.js')
const { discoverLaunchProfiles } = await import('../../src/services/ide/launchProfiles.js')
const { resolveAdapter } = await import('../../src/services/dap/dapClient.js')

const savedEnv = { ...process.env }
function restore(): void {
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k]
  }
  Object.assign(process.env, savedEnv)
}

section('§1 · the listen expression (both debugpy roads)')
{
  const bundled = blenderDebugListenExpr(5678, '/dist/vendor/debugpy')
  check(
    'bundled road: sys.path.insert of the vendor tree, JSON-quoted',
    bundled.startsWith(`import sys; sys.path.insert(0, "/dist/vendor/debugpy"); `) &&
      bundled.includes("debugpy.listen(('127.0.0.1', 5678))"),
  )
  const pip = blenderDebugListenExpr(5678, null)
  check(
    'pip road: no path arm — Blender-importable debugpy assumed',
    pip.startsWith('import debugpy; ') && !pip.includes('sys.path'),
  )
  const other = blenderDebugListenExpr(6001, null)
  check('the port spells through (listen + the print line)', other.includes("6001))") && other.includes(':6001'))
  check('the community default port is 5678', BLENDER_DEBUG_DEFAULT_PORT === 5678)
}

section('§2 · the steps contract')
{
  const r = blenderDebugRecipe('/Applications/Blender.app/Contents/MacOS/Blender', 5678, null)
  const all = r.steps.join('\n')
  check('step 1: the operator launch line with --python-expr', all.includes('--python-expr') && all.includes('/Applications/Blender.app'))
  check('pip road named when no bundle', r.debugpySource === 'pip' && all.includes('pip install debugpy'))
  check(
    'step 2: the Debug attach op naming adapter python + the connect contract',
    all.includes('op:"attach"') && all.includes('adapter:"python"') && all.includes('{connect:{host,port}}'),
  )
  check('step 3: wait_for_client teaching', all.includes('wait_for_client'))
  check(
    'THE WEDGE CITED: the observed wedge + debugpyWaitingForServer + re-test guidance',
    all.includes('wedge may apply (observed:') && all.includes('debugpyWaitingForServer') && all.includes('next debugpy release'),
  )
  const bundled = blenderDebugRecipe('<blender>', 5678, '/v/debugpy')
  check(
    'bundled road named when the vendor tree exists',
    bundled.debugpySource === 'bundled' && bundled.steps.join('\n').includes('/v/debugpy'),
  )
}

section('§3 · the profile row (armed only)')
{
  restore()
  const scratch = mkdtempSync(path.join(tmpdir(), 'blender-debug-'))
  mkdirSync(scratch, { recursive: true })
  writeFileSync(path.join(scratch, 'a.blend'), '')
  process.env.MERCURY_BLENDER = '1'
  const d = await discoverLaunchProfiles(scratch)
  const recipeRows = d.profiles.filter(p => p.source === 'blender' && p.kind === 'debug')
  check('exactly ONE debug recipe row', recipeRows.length === 1)
  const row = recipeRows[0]
  check(
    'the row rides the operator-run payload with --python-expr + the steps note',
    (row?.blenderHeadless?.args[0] ?? '') === '--python-expr' &&
      (row?.blenderHeadless?.note ?? '').includes('op:"attach"') &&
      (row?.blenderHeadless?.note ?? '').includes('wedge may apply (observed:'),
  )
  delete process.env.MERCURY_BLENDER
  const off = await discoverLaunchProfiles(scratch)
  check('off ⇒ no recipe row', off.profiles.every(p => !(p.source === 'blender' && p.kind === 'debug')))
  rmSync(scratch, { recursive: true, force: true })
}

section('§4 · the attach side exists (the landed contract)')
{
  restore()
  const python = resolveAdapter('python')
  check(
    "the python adapter resolves with the connect attach shape (the recipe's other half)",
    python !== null && python.attachShape === 'connect',
  )
}

restore()
console.log('\n============================================================')
if (failures > 0) {
  console.log(` RESULT: ${failures} check(s) FAILED`)
  process.exit(1)
}
console.log(' RESULT: all checks passed')
