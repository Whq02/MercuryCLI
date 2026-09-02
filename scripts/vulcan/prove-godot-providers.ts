#!/usr/bin/env bun
// ============================================================================
//  scripts/vulcan/prove-godot-providers.ts
//  PROOF: — the typed Godot provider
//  inventory: SEPARATE identities (vulcan / godot-lsp / godot-dap), each
//  with a stable id, endpoint, capabilities and its OWN state — one
//  provider dark says nothing about another, and addon-absent is a
//  DIFFERENT typed fact from installed-but-not-answering.
//  Hygiene: config home scratch-pinned; flags pinned per leg (ambient-state
//  law — a pooled run may carry experiment env).
// ============================================================================

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prov-home-'))
// Two gates cover the lane: MERCURY_GODOT_TOOLS (vulcan) + MERCURY_GODOT
// (lsp/dap lane) — pin BOTH off for the disabled legs.
for (const v of ['MERCURY_GODOT_TOOLS', 'MERCURY_GODOT_TOOLS', 'MERCURY_GODOT', 'MERCURY_GODOT']) {
  delete process.env[v]
}

const ROOT = join(import.meta.dir, '..', '..')
const { godotProviderInventory, renderProviderRows } = await import(
  join(ROOT, 'src/services/vulcan/godotProviders.ts')
)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

console.log('============================================================')
console.log(' Godot provider inventory (seamark SM-G / SM-11) — proof')
console.log('============================================================')

const scratch = mkdtempSync(join(tmpdir(), 'prov-proj-'))
try {
  // ── flags off: every provider independently 'disabled' with its reason ──
  const off = await godotProviderInventory(scratch)
  check('three separate provider identities, stable ids', off.length === 3 && JSON.stringify(off.map(r => r.id)) === JSON.stringify(['vulcan', 'godot-lsp', 'godot-dap']))
  check("flags off ⇒ each row independently 'disabled' with a named reason", off.every(r => r.state === 'disabled' && !!r.failureReason))
  check('every row carries endpoint + capabilities', off.every(r => r.endpoint.includes('127.0.0.1:') && r.capabilities.length > 0))

  // ── enabled, addon absent: 'not-installed' ≠ 'not-answering' ─────────────
  process.env.MERCURY_GODOT_TOOLS = '1'
  process.env.MERCURY_GODOT = '1'
  writeFileSync(join(scratch, 'project.godot'), '[application]\n\nconfig/name="P"\n')
  const enabled = await godotProviderInventory(scratch)
  const vulcan = enabled.find(r => r.id === 'vulcan')!
  check("addon absent is the TYPED 'not-installed' state (never 'not-answering')", vulcan.state === 'not-installed' && /vulcan_install/.test(vulcan.failureReason ?? ''), JSON.stringify(vulcan).slice(0, 120))
  const lsp = enabled.find(r => r.id === 'godot-lsp')!
  const dap = enabled.find(r => r.id === 'godot-dap')!
  check("editor dark ⇒ lsp/dap 'not-answering' (their OWN probes, not vulcan's)", lsp.state === 'not-answering' && dap.state === 'not-answering', `lsp=${lsp.state} dap=${dap.state}`)
  check('one provider dark says nothing about another (states independent)', vulcan.state !== lsp.state)

  // ── the render projection: one line per identity ─────────────────────────
  const lines = renderProviderRows(enabled)
  check('render: one line per provider naming id · state · endpoint', lines.length === 3 && lines.every(l => /·/.test(l)))
// The lsp/dap probe legs need the lane project detection: run inventory FROM
// a cwd-independent root (the probe finds the project via the passed root's
// files — see godotProviderInventory's lane probe which reads findGodotProjectRoot()).
} finally {
  delete process.env.MERCURY_GODOT_TOOLS
  delete process.env.MERCURY_GODOT
  rmSync(scratch, { recursive: true, force: true })
  rmSync(process.env.MERCURY_CONFIG_DIR!, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n ✅ ALL PROVIDER-INVENTORY PROOFS PASS' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
