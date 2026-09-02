#!/usr/bin/env bun
// ============================================================================
//  scripts/harness-profiles/prove-ch3-surface.ts — the CH-3 operator-surface proofs:
//  §A pin precedence through the ONE contract (in-app session slot ≻ env pin
//     ≻ persisted config pin ≻ selector) with reset returning to the
//     selector (CH-18);
//  §B the frame chip derivation (armed-only; UI copy law — "harness", never
//     a bare "profile" label) and the off-state byte-absence;
//  §C the run-kernel model-transition event carries the harness identity
//     when armed and drops it exactly when the event omits it (the ACP
//     `_mercury/run` projection surface — CH-19);
//  §D the external-seat honesty pin: 'harness-profile' is a typed
//     capability kind, recorded 'unsupported' on EVERY external attach
//     (CH-22 — never 'unknown', never false state);
//  §E the /harness command and both capture scenarios are registered;
//  §F keyboard completeness rides useInteractiveList (structural: the view
//     mounts rows through the kit's grammar — the rendered journeys are the
//     80/120 captures recorded in the).
//
//  Env hygiene: fixture config home outside the repo; flags pinned per leg.
// ============================================================================
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'harness-ch3-config-'))
process.env.ANTHROPIC_API_KEY = 'fixture-key'
// The config boot gate: provers run in test mode (the orbit precedent) — the
// in-memory test config, no operator file reads, no fs writes.
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HARNESS_PROFILE
delete process.env.MERCURY_HARNESS_PROFILE_PIN

const ROOT = join(import.meta.dir, '..', '..')

const {
  harnessSessionPin,
  resolveActiveHarnessProfile,
  setHarnessSessionPin,
} = await import('../../src/services/mission/harnessApplication.ts')
const { getGlobalConfig, saveGlobalConfig } = await import('../../src/utils/config.ts')
const { emptyRunSnapshot, reduceRunEvent } = await import('../../src/services/run/runKernel.ts')
const { CAPABILITY_KINDS, recordCapabilities } = await import('../../src/services/crew/capabilities.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

console.log('§A pin precedence through the ONE contract (CH-18)')
process.env.MERCURY_HARNESS_PROFILE = 'on'
setHarnessSessionPin(null)
// persisted pin via the config owner (updater form)
saveGlobalConfig(cfg => ({ ...cfg, harnessProfilePin: 'anthropic-default' }))
const persistedOnly = resolveActiveHarnessProfile({ model: 'claude-fable-5' })
check('§A persisted config pin resolves as persisted-pin', persistedOnly?.origin === 'persisted-pin')
process.env.MERCURY_HARNESS_PROFILE_PIN = 'anthropic-default'
const envOverPersisted = resolveActiveHarnessProfile({ model: 'claude-fable-5' })
check('§A env session pin outranks the persisted pin', envOverPersisted?.origin === 'session-pin')
setHarnessSessionPin('anthropic-default')
check('§A the in-app session slot is the session-pin source while set', harnessSessionPin() === 'anthropic-default')
delete process.env.MERCURY_HARNESS_PROFILE_PIN
const slotOnly = resolveActiveHarnessProfile({ model: 'claude-fable-5' })
check('§A the in-app slot alone still resolves session-pin', slotOnly?.origin === 'session-pin')
// reset: clear BOTH pins → the selector path (accepted default at opening state)
setHarnessSessionPin(null)
saveGlobalConfig(cfg => ({ ...cfg, harnessProfilePin: undefined }))
const reset = resolveActiveHarnessProfile({ model: 'claude-fable-5' })
check('§A reset returns to the SELECTOR (accepted default, named)', reset?.origin === 'accepted-default' && reset.reasonCodes[0] === 'no-qualified-candidate')

console.log('§B the frame chip derivation (armed-only)')
const { harnessChipLabel } = await import('../../src/components/mercury-ui/HarnessChip.tsx')
check('§B armed: the chip names the harness profile', harnessChipLabel(reset) === ' · harness anthropic-default')
check('§B off: NO chip bytes at all', harnessChipLabel(null) === null)

console.log('§C the run-kernel event carries the identity (CH-19)')
const base = emptyRunSnapshot({ runId: 'r', owner: 'main' as never, objective: '', rootMessageId: null, at: 1 })
const withHarness = reduceRunEvent(base, {
  type: 'model-transition',
  at: 1,
  current: 'claude-fable-5',
  pendingNext: null,
  harnessProfile: { profileId: 'anthropic-default', profileDigest: 'hpr1-x', origin: 'accepted-default', reasonCode: 'no-qualified-candidate' },
} as never) as { modelState?: { harnessProfile?: { profileId: string } } }
check('§C an armed event folds the harness identity into modelState', withHarness.modelState?.harnessProfile?.profileId === 'anthropic-default')
const withoutHarness = reduceRunEvent(withHarness as never, {
  type: 'model-transition',
  at: 2,
  current: 'claude-fable-5',
  pendingNext: null,
} as never) as { modelState?: { harnessProfile?: unknown } }
check('§C an off event DROPS the field (state mirrors the event exactly)', withoutHarness.modelState?.harnessProfile === undefined)

console.log('§D external-seat honesty (CH-22)')
check("§D 'harness-profile' is a typed capability kind", (CAPABILITY_KINDS as readonly string[]).includes('harness-profile'))
const set = recordCapabilities({ seatId: 's1', adapterKind: 'claude-code', revision: 'r1', declared: {} })
const fact = set.facts.get('harness-profile' as never)
check(
  "§D every external attach records 'unsupported' with the exact source (never unknown, never false state)",
  fact?.state === 'unsupported' && fact.source === 'external-seat-no-harness-application',
  `${fact?.state}/${fact?.source}`,
)

console.log('§E command + capture scenarios registered')
const commandsSrc = readFileSync(join(ROOT, 'src/commands.ts'), 'utf8')
check('§E /harness is registered in the command registry', commandsSrc.includes("commands/harness/index.js"))
const scenarios = readFileSync(join(ROOT, 'scripts/ui/renderScenarios.ts'), 'utf8')
check('§E the harness-chip + harness-view capture scenarios exist', scenarios.includes("'harness-chip'") && scenarios.includes("'harness-view'"))

console.log('§F the drill-in rides the interaction kit (keyboard-complete by construction)')
const view = readFileSync(join(ROOT, 'src/components/mercury-ui/parity/HarnessView.tsx'), 'utf8')
check('§F HarnessView uses useInteractiveList + InteractiveRow + CommandCenter', view.includes('useInteractiveList') && view.includes('InteractiveRow') && view.includes('CommandCenter'))
check('§F the UI copy law: the view says "harness profile"', view.includes('harness profile'))
check('§F the invariant-floor line is stated on the surface', view.includes('invariant floor is outside harness-profile control'))

delete process.env.MERCURY_HARNESS_PROFILE
console.log(failures === 0 ? '\nprove-ch3-surface: green' : `\nprove-ch3-surface: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
