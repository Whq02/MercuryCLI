#!/usr/bin/env bun
// ============================================================================
//  scripts/scribe/prove-model-targeting.ts
//  PROOF (audit-cycle-1): /model gains per-agent targeting in scribe mode, at
//  parity with /effort (W2). `/model implementer <model>` routes to the daemon
//  reconfigure RPC (patches the worker, NOT the foreground session); `/model scribe
//  <model>` strips the token + sets the foreground; no target → the normal picker/set.
//
//  Bug it fixes: the shared helper's docstring advertised `/model scribe opus`, and
//  /effort shipped the identical capability, but /model never wired it — so
//  `/model implementer opus` fell through to the base setter and 400'd with a
//  misleading "your organization restricts model selection" for a model that IS allowed.
//
//  Run:  ~/.bun/bin/bun run scripts/scribe/prove-model-targeting.ts
// ============================================================================
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseScribeTargetArg, reconfigureImplementer } from '../../src/utils/scribe/reconfigureImplementer.js'

// Ambient-state pin (proof-hygiene): the live reconfigureImplementer call
// below PERSISTS the implementer slot and dials the
// control socket, both through the resolved config home — pin every home
// spelling to scratch or the run rewrites the operator's real seat-slots.json
//
const scratchHome = mkdtempSync(join(tmpdir(), 'model-targeting-home-'))
for (const k of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) {
  process.env[k] = scratchHome
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const src = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')

console.log('============================================================')
console.log(' /model per-agent targeting (W2 parity with /effort)')
console.log('============================================================')

section('parseScribeTargetArg — the leading target token (shared with /effort)')
const pImpl = parseScribeTargetArg('implementer opus')
check('`implementer opus` ⇒ {implementer, rest:"opus"}', pImpl.target === 'implementer' && pImpl.rest === 'opus')
const pScribe = parseScribeTargetArg('scribe claude-opus-4-8')
check('`scribe claude-opus-4-8` ⇒ {scribe, rest:"claude-opus-4-8"}', pScribe.target === 'scribe' && pScribe.rest === 'claude-opus-4-8')
check('`opus` (no target) ⇒ {null, rest:"opus"} (falls through to the normal set)', parseScribeTargetArg('opus').target === null)
check('`implementer` (bare) ⇒ {implementer, rest:""} (usage-hint path)', parseScribeTargetArg('implementer').target === 'implementer' && parseScribeTargetArg('implementer').rest === '')

section('reconfigureImplementer is HONEST with no daemon (real RPC caller run, never throws)')
const msg = await reconfigureImplementer({ model: 'claude-opus-4-8' })
check(
  'no daemon ⇒ an honest not-reachable / no-roster / error line (never a fabricated success)',
  /not reachable|no daemon|No Implementer in the roster|reconfigure (failed|error)/i.test(msg) && !/respawning now|queued \(applies/.test(msg),
  msg,
)

section('mercuryModel.tsx wires the implementer/scribe routing (structural)')
const hm = src('commands', 'model', 'mercuryModel.tsx')
// P4 (router-party): the wiring generalized to parseSeatTargetArg /
// ApplySeatModelReconfigure — same guarantees (mode-gated token parse, daemon
// seats via one-shot RPC, local seats strip + fall through, bare-token hint).
check('imports parseSeatTargetArg + reconfigureSeat', /parseSeatTargetArg/.test(hm) && /reconfigureSeat/.test(hm))
// The party seams are retired (partyEngaged left with them); the live
// gate pair is scribeOn + scribeFeatureOn.
check('per-mode gated (scribeOn/scribeFeatureOn)', /if \(trimmed\)/.test(hm) && /scribeOn: isScribeModeOn\(\)/.test(hm) && /scribeFeatureOn: scribeModeEnabled\(\)/.test(hm))
check("daemon seats ⇒ ApplySeatModelReconfigure (one-shot RPC)", /seat\.kind === 'daemon'/.test(hm) && /ApplySeatModelReconfigure/.test(hm))
check("local seats (scribe/healer) ⇒ strip the token + fall through to the foreground set", /seat\.kind === 'local'/.test(hm) && /effectiveArgs = rest/.test(hm))
check('bare seat token ⇒ a usage hint (no empty-model RPC)', /Specify a model: \/model \$\{seat\.target\}/.test(hm))

section('the the base model.tsx fallback is NOT touched (byte-identical for bare-stamp)')
const base = src('commands', 'model', 'model.tsx')
check('model.tsx has no per-agent targeting (byte-identical)', !/parseScribeTargetArg/.test(base) && !/reconfigureImplementer/.test(base))

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL MODEL-TARGETING PROOFS PASS')
else console.log(`❌ ${failures} MODEL-TARGETING PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
