#!/usr/bin/env bun
// ============================================================================
//  scripts/model-transition/prove-transition-switch-precedence.ts — the
//  SWITCH-OVERLAP CENSUS (SWITCHADV drive family 8): pendingSwitch × session
//  pin × cap-failover × the setting layers, pinned at their owners.
//
//    §1 the effective-model law: settlement reads sessionPin ?? setting;
//       picking the PIN is a no-op; an idle pick RESOLVES the pin (receipt
//       previous = the pin, patch clears mainLoopModelForSession);
//    §2 pin × pending: a mid-turn pick while pinned parks; the boundary
//       receipt's previous is the PIN; the apply clears pin AND pending
//       exactly-once; re-picking the pin cancels a parked switch with a
//       'cancelled-pending' receipt;
//    §3 the patch-key census: no settlement patch ever touches anything
//       beyond {mainLoopModel, mainLoopModelForSession, pendingModelSwitch,
//       lastModelTransition} — sub-model slots and the rest of AppState are
//       unreachable by construction;
//    §4 the setting layers: override > ANTHROPIC_MODEL env > saved setting,
//       proven at getUserSpecifiedModelSetting;
//    §5 the cap-failover fence (pure core): posture 'off' is a TOTAL no-op;
//       warnings offer, rejected offers or auto-hands-off by posture; the
//       candidate law (anthropic never a candidate · unusable lanes excluded
//       with a typed why · no invented target ids · OpenAI first); the
//       return guard never fires off the failover lane even with a stale
//       handoff note; an accepted handoff settles through the ONE selection
//       owner and the receipt says cross-provider.
//
//  Run: ~/.bun/bin/bun run scripts/model-transition/prove-transition-switch-precedence.ts
// ============================================================================
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

delete process.env.NODE_ENV
delete process.env.CI
delete process.env.CLAUDE_EFFORT
delete process.env.ANTHROPIC_MODEL
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'switch-precedence-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

console.log('============================================================')
console.log(' switch precedence census — pin × pending × failover × layers')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { settleModelSelection, settlePendingAtBoundary } = await import(
  '../../src/utils/model/modelTransition.ts'
)
const { getUserSpecifiedModelSetting } = await import('../../src/utils/model/model.ts')
const { setMainLoopModelOverride } = await import('../../src/bootstrap/state.ts')
const {
  decideCapAction,
  decideCapReturn,
  deriveCapFailoverCandidates,
  noteCapHandoff,
  noteCapReturn,
  capHandoffState,
} = await import('../../src/services/capFailover.ts')

type Slice = {
  mainLoopModel: string | null
  mainLoopModelForSession: string | null
  pendingModelSwitch: { setting: string | null } | null
}

// ── §1 the effective-model law ─────────────────────────────────────────────
section('§1 effective = sessionPin ?? setting')
{
  const pinned: Slice = { mainLoopModel: 'claude-sonnet-5', mainLoopModelForSession: 'glm-5.2', pendingModelSwitch: null }
  const noop = settleModelSelection(pinned, 'glm-5.2', { turnActive: false })
  check('picking the PIN is a no-op (the pin IS the effective model)', noop.kind === 'no-op')
  const away = settleModelSelection(pinned, 'gpt-5.6-sol', { turnActive: false })
  check("an idle pick away from the pin APPLIES with previous = the PIN (not the setting)", away.kind === 'applied' && away.receipt?.previous === 'glm-5.2' && away.receipt.applied === 'gpt-5.6-sol')
  check('the apply RESOLVES the pin (mainLoopModelForSession cleared in the same patch)', away.kind === 'applied' && away.patch.mainLoopModelForSession === null && away.patch.mainLoopModel === 'gpt-5.6-sol')
  check('the pin-vs-setting cross-provider flag derives from the PIN side', away.kind === 'applied' && away.receipt?.crossProvider === true)
  const home = settleModelSelection(pinned, 'claude-sonnet-5', { turnActive: false })
  check('picking the SETTING while pinned elsewhere is a real transition (pin glm → setting claude)', home.kind === 'applied' && home.receipt?.previous === 'glm-5.2' && home.receipt.applied === 'claude-sonnet-5')
}

// ── §2 pin × pending ───────────────────────────────────────────────────────
section('§2 pin × pending switch')
{
  let slice: Slice = { mainLoopModel: 'claude-sonnet-5', mainLoopModelForSession: 'glm-5.2', pendingModelSwitch: null }
  const queued = settleModelSelection(slice, 'gpt-5.6-sol', { turnActive: true })
  check('a mid-turn pick while pinned PARKS', queued.kind === 'queued')
  if (queued.kind === 'queued') slice = { ...slice, ...queued.patch }
  check('the park leaves the pin in place (the running turn keeps riding it)', slice.mainLoopModelForSession === 'glm-5.2' && slice.pendingModelSwitch?.setting === 'gpt-5.6-sol')
  const boundary = settlePendingAtBoundary(slice)
  check("the boundary receipt's previous is the PIN", boundary !== null && boundary.receipt.previous === 'glm-5.2' && boundary.receipt.applied === 'gpt-5.6-sol' && boundary.receipt.boundary === 'turn-boundary')
  if (boundary) slice = { ...slice, ...boundary.patch } as Slice
  check('the apply clears the pin AND the pending slot exactly-once', slice.mainLoopModelForSession === null && slice.pendingModelSwitch === null && slice.mainLoopModel === 'gpt-5.6-sol')
  check('a second boundary settle is a no-op (nothing left to apply)', settlePendingAtBoundary(slice) === null)

  // Re-picking the effective model cancels a parked switch, with a receipt.
  let cancel: Slice = { mainLoopModel: 'claude-sonnet-5', mainLoopModelForSession: null, pendingModelSwitch: { setting: 'gpt-5.6-sol' } }
  const cancelled = settleModelSelection(cancel, 'claude-sonnet-5', { turnActive: true })
  check("re-picking the current model CANCELS the parked switch ('cancelled-pending', requested names the dropped pick)", cancelled.kind === 'cancelled-pending' && cancelled.receipt?.resolution === 'cancelled-pending' && cancelled.receipt.requested === 'gpt-5.6-sol' && cancelled.receipt.applied === 'claude-sonnet-5')
  if (cancelled.kind === 'cancelled-pending') cancel = { ...cancel, ...cancelled.patch }
  check('the cancel clears the pending slot', cancel.pendingModelSwitch === null)
  // A newer pick REPLACES a parked one — the slot holds ONE switch.
  let replace: Slice = { mainLoopModel: 'claude-sonnet-5', mainLoopModelForSession: null, pendingModelSwitch: { setting: 'gpt-5.6-sol' } }
  const replaced = settleModelSelection(replace, 'glm-5.2', { turnActive: true })
  if (replaced.kind === 'queued') replace = { ...replace, ...replaced.patch }
  check('a newer mid-turn pick REPLACES the parked one (the slot holds ONE switch)', replaced.kind === 'queued' && replace.pendingModelSwitch?.setting === 'glm-5.2')
}

// ── §3 the patch-key census ────────────────────────────────────────────────
section('§3 patch-key census — nothing beyond the transition slice moves')
{
  const ALLOWED = new Set(['mainLoopModel', 'mainLoopModelForSession', 'pendingModelSwitch', 'lastModelTransition'])
  const slices: Slice[] = [
    { mainLoopModel: 'claude-sonnet-5', mainLoopModelForSession: null, pendingModelSwitch: null },
    { mainLoopModel: 'claude-sonnet-5', mainLoopModelForSession: 'glm-5.2', pendingModelSwitch: null },
    { mainLoopModel: 'claude-sonnet-5', mainLoopModelForSession: null, pendingModelSwitch: { setting: 'gpt-5.6-sol' } },
  ]
  const picks: Array<string | null> = ['gpt-5.6-sol', 'glm-5.2', 'claude-sonnet-5', null]
  let widest: string[] = []
  for (const s of slices) {
    for (const p of picks) {
      for (const turnActive of [false, true]) {
        const settled = settleModelSelection(s, p, { turnActive })
        const keys = settled.patch ? Object.keys(settled.patch) : []
        if (keys.some(k => !ALLOWED.has(k))) widest = keys
        const b = settlePendingAtBoundary(s)
        if (b && Object.keys(b.patch).some(k => !ALLOWED.has(k))) widest = Object.keys(b.patch)
      }
    }
  }
  check('every settlement/boundary patch over the 24-case grid touches ONLY the transition slice (sub-model slots unreachable)', widest.length === 0, widest.join(','))
}

// ── §4 the setting layers ──────────────────────────────────────────────────
section('§4 setting layers: override > ANTHROPIC_MODEL > saved')
{
  delete process.env.ANTHROPIC_MODEL
  setMainLoopModelOverride(undefined as never)
  const base = getUserSpecifiedModelSetting()
  check('a fresh scratch home has no user-specified setting (the default rung)', base === null, String(base))
  process.env.ANTHROPIC_MODEL = 'glm-5.2'
  check('ANTHROPIC_MODEL env speaks when no override exists', getUserSpecifiedModelSetting() === 'glm-5.2')
  setMainLoopModelOverride('gpt-5.6-sol')
  check('the in-session override OUTRANKS the env', getUserSpecifiedModelSetting() === 'gpt-5.6-sol')
  setMainLoopModelOverride(undefined as never)
  delete process.env.ANTHROPIC_MODEL
  check('clearing both returns the default rung', getUserSpecifiedModelSetting() === null)
}

// ── §5 the cap-failover fence ──────────────────────────────────────────────
section('§5 cap-failover: posture × quota × candidates × return guard')
{
  const quotas = ['allowed', 'allowed_warning', 'rejected'] as const
  check("posture 'off' is a TOTAL no-op over every quota state", quotas.every(q => decideCapAction('off', q).kind === 'none'))
  check("'offer' posture: warnings and rejections OFFER, never auto-move", decideCapAction('offer', 'allowed_warning').kind === 'offer' && decideCapAction('offer', 'rejected').kind === 'offer' && decideCapAction('offer', 'allowed').kind === 'none')
  const auto = decideCapAction('auto', 'rejected')
  check("'auto' posture hands off unattended ONLY on rejected", auto.kind === 'auto-handoff' && decideCapAction('auto', 'allowed_warning').kind === 'offer')

  const usability: Record<string, { usable: boolean; blockers: string[] }> = {
    anthropic: { usable: true, blockers: [] },
    openai: { usable: true, blockers: [] },
    zai: { usable: false, blockers: ['no credential'] },
    openrouter: { usable: true, blockers: [] },
  }
  const set = deriveCapFailoverCandidates('anthropic', usability, route =>
    route === 'openai' ? 'gpt-5.6-sol' : route === 'anthropic' ? 'claude-sonnet-5' : undefined,
  )
  check('the HOME family is never its own candidate (neutral law: no family is excluded by name)', set.home === 'anthropic' && set.candidates.every(c => c.route !== 'anthropic'))
  check('the usable lane with a real target id is the ONE candidate', set.candidates.length === 1 && set.candidates[0]?.route === 'openai' && set.candidates[0].model === 'gpt-5.6-sol')
  check('an unusable lane is excluded with its own typed why', set.excluded.some(e => e.route === 'zai' && e.why.includes('no credential')))
  check('a usable lane with NO recorded target fact is excluded, never a guessed id', set.excluded.some(e => e.route === 'openrouter' && e.why.includes('never a guessed id')))
  const fromOpenai = deriveCapFailoverCandidates('openai', usability, route =>
    route === 'openai' ? 'gpt-5.6-sol' : route === 'anthropic' ? 'claude-sonnet-5' : undefined,
  )
  check('a GPT home ⇒ anthropic is an ordinary candidate', fromOpenai.candidates.length === 1 && fromOpenai.candidates[0]?.route === 'anthropic')

  // The accepted handoff settles through the ONE owner; the note lifecycle.
  let slice: Slice = { mainLoopModel: 'claude-sonnet-5', mainLoopModelForSession: null, pendingModelSwitch: null }
  const handoff = settleModelSelection(slice, 'gpt-5.6-sol', { turnActive: false })
  check('the accepted handoff is an ordinary applied settlement (cross-provider receipt)', handoff.kind === 'applied' && handoff.receipt?.crossProvider === true)
  if (handoff.kind === 'applied') slice = { ...slice, ...handoff.patch }
  noteCapHandoff('claude-sonnet-5', 'anthropic')
  check('the handoff note records the way home — model and family', capHandoffState()?.homeModel === 'claude-sonnet-5' && capHandoffState()?.homeFamily === 'anthropic')
  const reset = { window: 'allowed', credentialUsable: true } as const
  check('the return guard NEVER fires off the failover lane, even with the note standing', decideCapReturn('auto', reset, false).kind === 'none' && decideCapReturn('offer', reset, false).kind === 'none')
  check('on the failover lane with the home window OBSERVED reset, the posture speaks (offer/auto)', decideCapReturn('offer', reset, true).kind === 'offer' && decideCapReturn('auto', reset, true).kind === 'auto-handoff')
  check('an unreset home window keeps everyone parked', decideCapReturn('auto', { window: 'rejected', credentialUsable: true }, true).kind === 'none' && decideCapReturn('auto', { window: 'allowed_warning', credentialUsable: true }, true).kind === 'none')
  check("'unknown' is not a reset, and a signed-out home is no home", decideCapReturn('auto', { window: 'unknown', credentialUsable: true }, true).kind === 'none' && decideCapReturn('auto', { window: 'allowed', credentialUsable: false }, true).kind === 'none')
  noteCapReturn()
  check('the way home clears the note', capHandoffState() === null)
}

console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
