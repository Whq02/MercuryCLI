#!/usr/bin/env bun
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
delete process.env.MERCURY_MODEL
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'switch-precedence-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

console.log('============================================================')
console.log(' switch precedence census — pin × pending × failover × layers')
console.log('============================================================')

const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const { settleModelSelection, settlePendingAtBoundary } = await import(
  '../../src/models/catalogue/modelTransition.ts'
)
const { getUserSpecifiedModelSetting } = await import('../../src/models/catalogue/engineModel.ts')
const { setEngineModelOverride } = await import('../../src/boot/process-state/processState.ts')
const {
  decideCapAction,
  decideCapReturn,
  deriveCapFailoverCandidates,
  noteCapHandoff,
  noteCapReturn,
  capHandoffState,
  capFailoverLaneOf,
  capLaneLineKey,
  capLaneLineUntil,
} = await import('../../src/models/roads/capFailover.ts')
const { failoverMarkFor } = await import('../../src/screen/widgets/FailoverMark.tsx')

type Slice = {
  engineModel: string | null
  engineModelForSession: string | null
  pendingModelSwitch: { setting: string | null } | null
}

section('§1 effective = sessionPin ?? setting')
{
  const pinned: Slice = { engineModel: 'claude-sonnet-5', engineModelForSession: 'glm-5.2', pendingModelSwitch: null }
  const noop = settleModelSelection(pinned, 'glm-5.2', { turnActive: false })
  check('picking the PIN is a no-op (the pin IS the effective model)', noop.kind === 'no-op', `got kind ${noop.kind}; settleModelSelection in src/models/catalogue/modelTransition.ts must compare the pick with engineModelForSession ?? engineModel`)
  const away = settleModelSelection(pinned, 'gpt-5.6-sol', { turnActive: false })
  check("an idle pick away from the pin APPLIES with previous = the PIN (not the setting)", away.kind === 'applied' && away.receipt?.previous === 'glm-5.2' && away.receipt.applied === 'gpt-5.6-sol', `got kind ${away.kind}, previous ${away.receipt?.previous}; settleModelSelection in src/models/catalogue/modelTransition.ts must take previous from the session pin when one is set`)
  check('the apply RESOLVES the pin (engineModelForSession cleared in the same patch)', away.kind === 'applied' && away.patch.engineModelForSession === null && away.patch.engineModel === 'gpt-5.6-sol', 'the applied patch from settleModelSelection in src/models/catalogue/modelTransition.ts must set engineModelForSession to null and engineModel to the pick')
  check('the pin-vs-setting cross-provider flag derives from the PIN side', away.kind === 'applied' && away.receipt?.crossProvider === true, 'settleModelSelection in src/models/catalogue/modelTransition.ts must derive crossProvider from the pinned model, not from the saved setting')
  const home = settleModelSelection(pinned, 'claude-sonnet-5', { turnActive: false })
  check('picking the SETTING while pinned elsewhere is a real transition (pin glm → setting claude)', home.kind === 'applied' && home.receipt?.previous === 'glm-5.2' && home.receipt.applied === 'claude-sonnet-5', `got kind ${home.kind}; settleModelSelection in src/models/catalogue/modelTransition.ts must apply a pick equal to the setting when a different pin is active`)
}

section('§2 pin × pending switch')
{
  let slice: Slice = { engineModel: 'claude-sonnet-5', engineModelForSession: 'glm-5.2', pendingModelSwitch: null }
  const queued = settleModelSelection(slice, 'gpt-5.6-sol', { turnActive: true })
  check('a mid-turn pick while pinned PARKS', queued.kind === 'queued', `got kind ${queued.kind}; settleModelSelection in src/models/catalogue/modelTransition.ts must queue a pick made while turnActive is true, pinned or not`)
  if (queued.kind === 'queued') slice = { ...slice, ...queued.patch }
  check('the park leaves the pin in place (the running turn keeps riding it)', slice.engineModelForSession === 'glm-5.2' && slice.pendingModelSwitch?.setting === 'gpt-5.6-sol', 'the queued patch from settleModelSelection in src/models/catalogue/modelTransition.ts must leave engineModelForSession alone and set pendingModelSwitch')
  const boundary = settlePendingAtBoundary(slice)
  check("the boundary receipt's previous is the PIN", boundary !== null && boundary.receipt.previous === 'glm-5.2' && boundary.receipt.applied === 'gpt-5.6-sol' && boundary.receipt.boundary === 'turn-boundary', `boundary receipt is ${JSON.stringify(boundary?.receipt ?? null)}; settlePendingAtBoundary in src/models/catalogue/modelTransition.ts must take previous from the session pin and mark the receipt turn-boundary`)
  if (boundary) slice = { ...slice, ...boundary.patch } as Slice
  check('the apply clears the pin AND the pending slot exactly-once', slice.engineModelForSession === null && slice.pendingModelSwitch === null && slice.engineModel === 'gpt-5.6-sol', 'the patch from settlePendingAtBoundary in src/models/catalogue/modelTransition.ts must clear engineModelForSession and pendingModelSwitch and set engineModel')
  check('a second boundary settle is a no-op (nothing left to apply)', settlePendingAtBoundary(slice) === null, 'settlePendingAtBoundary in src/models/catalogue/modelTransition.ts must return null once pendingModelSwitch is cleared')

  let cancel: Slice = { engineModel: 'claude-sonnet-5', engineModelForSession: null, pendingModelSwitch: { setting: 'gpt-5.6-sol' } }
  const cancelled = settleModelSelection(cancel, 'claude-sonnet-5', { turnActive: true })
  check("re-picking the current model CANCELS the parked switch ('cancelled-pending', requested names the dropped pick)", cancelled.kind === 'cancelled-pending' && cancelled.receipt?.resolution === 'cancelled-pending' && cancelled.receipt.requested === 'gpt-5.6-sol' && cancelled.receipt.applied === 'claude-sonnet-5', `got kind ${cancelled.kind}; settleModelSelection in src/models/catalogue/modelTransition.ts must cancel the parked switch when the current model is re-picked, with requested set to the dropped pick`)
  if (cancelled.kind === 'cancelled-pending') cancel = { ...cancel, ...cancelled.patch }
  check('the cancel clears the pending slot', cancel.pendingModelSwitch === null, 'the cancelled-pending patch from settleModelSelection in src/models/catalogue/modelTransition.ts must set pendingModelSwitch to null')
  let replace: Slice = { engineModel: 'claude-sonnet-5', engineModelForSession: null, pendingModelSwitch: { setting: 'gpt-5.6-sol' } }
  const replaced = settleModelSelection(replace, 'glm-5.2', { turnActive: true })
  if (replaced.kind === 'queued') replace = { ...replace, ...replaced.patch }
  check('a newer mid-turn pick REPLACES the parked one (the slot holds ONE switch)', replaced.kind === 'queued' && replace.pendingModelSwitch?.setting === 'glm-5.2', `got kind ${replaced.kind}; settleModelSelection in src/models/catalogue/modelTransition.ts must overwrite the parked pendingModelSwitch with the newer mid-turn pick`)
}

section('§3 patch-key census — nothing beyond the transition slice moves')
{
  const ALLOWED = new Set(['engineModel', 'engineModelForSession', 'pendingModelSwitch', 'lastModelTransition'])
  const slices: Slice[] = [
    { engineModel: 'claude-sonnet-5', engineModelForSession: null, pendingModelSwitch: null },
    { engineModel: 'claude-sonnet-5', engineModelForSession: 'glm-5.2', pendingModelSwitch: null },
    { engineModel: 'claude-sonnet-5', engineModelForSession: null, pendingModelSwitch: { setting: 'gpt-5.6-sol' } },
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
  check('every settlement/boundary patch over the 24-case grid touches ONLY the transition slice (sub-model slots unreachable)', widest.length === 0, `${widest.join(',')}; a patch from settleModelSelection or settlePendingAtBoundary in src/models/catalogue/modelTransition.ts carries a key outside engineModel, engineModelForSession, pendingModelSwitch and lastModelTransition; remove it`)
}

section('§4 setting layers: override > MERCURY_MODEL > saved')
{
  delete process.env.MERCURY_MODEL
  setEngineModelOverride(undefined as never)
  const base = getUserSpecifiedModelSetting()
  check('a fresh scratch home has no user-specified setting (the default rung)', base === null, `${String(base)}; getUserSpecifiedModelSetting in src/models/catalogue/engineModel.ts must return null with no override, MERCURY_MODEL or saved setting`)
  process.env.MERCURY_MODEL = 'glm-5.2'
  check('MERCURY_MODEL env speaks when no override exists', getUserSpecifiedModelSetting() === 'glm-5.2', 'getUserSpecifiedModelSetting in src/models/catalogue/engineModel.ts must read MERCURY_MODEL when no engine override is set')
  setEngineModelOverride('gpt-5.6-sol')
  check('the in-session override OUTRANKS the env', getUserSpecifiedModelSetting() === 'gpt-5.6-sol', 'getUserSpecifiedModelSetting in src/models/catalogue/engineModel.ts must prefer the engine override set by setEngineModelOverride in src/boot/process-state/processState.ts over MERCURY_MODEL')
  setEngineModelOverride(undefined as never)
  delete process.env.MERCURY_MODEL
  check('clearing both returns the default rung', getUserSpecifiedModelSetting() === null, 'getUserSpecifiedModelSetting in src/models/catalogue/engineModel.ts must return null once the override and MERCURY_MODEL are cleared')
}

section('§5 cap-failover: posture × quota × candidates × return guard')
{
  const quotas = ['allowed', 'allowed_warning', 'rejected'] as const
  check("posture 'off' is a TOTAL no-op over every quota state", quotas.every(q => decideCapAction('off', q).kind === 'none'), 'decideCapAction in src/models/roads/capFailover.ts must return kind none for posture off in every quota state')
  check("offer asks only at the reached window", decideCapAction('offer', 'allowed_warning').kind === 'none' && decideCapAction('offer', 'rejected').kind === 'offer' && decideCapAction('offer', 'allowed').kind === 'none', 'decideCapAction in src/models/roads/capFailover.ts must return offer only for the rejected window under posture offer')
  const auto = decideCapAction('auto', 'rejected')
  check("'auto' posture hands off unattended ONLY on rejected", auto.kind === 'auto-handoff' && decideCapAction('auto', 'allowed_warning').kind === 'none', 'decideCapAction in src/models/roads/capFailover.ts must return auto-handoff only for the rejected window under posture auto')

  const usability: Record<string, { usable: boolean; blockers: string[] }> = {
    anthropic: { usable: true, blockers: [] },
    openai: { usable: true, blockers: [] },
    zai: { usable: false, blockers: ['no credential'] },
    openrouter: { usable: true, blockers: [] },
  }
  const set = deriveCapFailoverCandidates('anthropic', usability, route =>
    route === 'openai' ? 'gpt-5.6-sol' : route === 'anthropic' ? 'claude-sonnet-5' : undefined,
  )
  check('the HOME family is never its own candidate (neutral law: no family is excluded by name)', set.home === 'anthropic' && set.candidates.every(c => c.route !== 'anthropic'), 'deriveCapFailoverCandidates in src/models/roads/capFailover.ts must return the home route as set.home and leave it out of candidates')
  check('the usable lane with a real target id is the ONE candidate', set.candidates.length === 1 && set.candidates[0]?.route === 'openai' && set.candidates[0].model === 'gpt-5.6-sol', `candidates: ${JSON.stringify(set.candidates)}; deriveCapFailoverCandidates in src/models/roads/capFailover.ts must keep a usable route that has a target model id`)
  check('an unusable lane is excluded with its own typed why', set.excluded.some(e => e.route === 'zai' && e.why.includes('no credential')), `excluded: ${JSON.stringify(set.excluded)}; deriveCapFailoverCandidates in src/models/roads/capFailover.ts must list an unusable route in excluded with its blockers in why`)
  check('a usable lane with NO recorded target fact is excluded, never a guessed id', set.excluded.some(e => e.route === 'openrouter' && e.why.includes('never a guessed id')), `excluded: ${JSON.stringify(set.excluded)}; deriveCapFailoverCandidates in src/models/roads/capFailover.ts must exclude a usable route with no target model id and say never a guessed id in why`)
  const fromOpenai = deriveCapFailoverCandidates('openai', usability, route =>
    route === 'openai' ? 'gpt-5.6-sol' : route === 'anthropic' ? 'claude-sonnet-5' : undefined,
  )
  check('a GPT home ⇒ anthropic is an ordinary candidate', fromOpenai.candidates.length === 1 && fromOpenai.candidates[0]?.route === 'anthropic', `candidates: ${JSON.stringify(fromOpenai.candidates)}; deriveCapFailoverCandidates in src/models/roads/capFailover.ts must not exclude a route by its name`)

  let slice: Slice = { engineModel: 'claude-sonnet-5', engineModelForSession: null, pendingModelSwitch: null }
  const handoff = settleModelSelection(slice, 'gpt-5.6-sol', { turnActive: false })
  check('the accepted handoff is an ordinary applied settlement (cross-provider receipt)', handoff.kind === 'applied' && handoff.receipt?.crossProvider === true, `got kind ${handoff.kind}; settleModelSelection in src/models/catalogue/modelTransition.ts must apply an idle pick across providers with a crossProvider receipt`)
  if (handoff.kind === 'applied') slice = { ...slice, ...handoff.patch }
  noteCapHandoff('claude-sonnet-5', 'anthropic')
  check('the handoff note records the way home — model and family', capHandoffState()?.homeModel === 'claude-sonnet-5' && capHandoffState()?.homeFamily === 'anthropic', 'noteCapHandoff in src/models/roads/capFailover.ts must store homeModel and homeFamily for capHandoffState to return')
  check('on the openai lane away from an anthropic home the strip carries the mark; at home it carries none', capFailoverLaneOf('openai') === 'openai' && failoverMarkFor('gpt-5.6-sol') === 'failover' && capFailoverLaneOf('anthropic') === null && failoverMarkFor('claude-sonnet-5') === null, 'capFailoverLaneOf in src/models/roads/capFailover.ts and failoverMarkFor in src/screen/widgets/FailoverMark.tsx must name the failover lane only while the handoff note stands and the live route is away from home')
  process.env.MERCURY_FAILOVER_LINE_MS = '2000'
  const laneFacts = { lane: 'openai', modelName: 'GPT-5.6 Sol', homeName: 'Anthropic', homeWindow: null, resetText: undefined }
  const laneKey = capLaneLineKey(laneFacts)
  check("the sentence stands its window from the switch and no longer past it — the same state never re-arms", capLaneLineUntil(laneKey, 10_000) === 12_000 && capLaneLineUntil(laneKey, 11_999) === 12_000 && capLaneLineUntil(laneKey, 12_000) === 12_000, 'capLaneLineUntil in src/models/roads/capFailover.ts must hold the first-seen deadline (now plus MERCURY_FAILOVER_LINE_MS) for the same key')
  const switched = capLaneLineKey({ ...laneFacts, modelName: 'GPT-5.4' })
  check('a switch on the lane (the served model changes) is a change of state: the sentence stands its window again', capLaneLineUntil(switched, 30_000) === 32_000, 'capLaneLineKey in src/models/roads/capFailover.ts must change when modelName changes, so capLaneLineUntil starts a new window')
  delete process.env.MERCURY_FAILOVER_LINE_MS
  const reset = { window: 'allowed', credentialUsable: true } as const
  check('the return guard NEVER fires off the failover lane, even with the note standing', decideCapReturn('auto', reset, false).kind === 'none' && decideCapReturn('offer', reset, false).kind === 'none', 'decideCapReturn in src/models/roads/capFailover.ts must return none when its third argument says the session is not on the failover lane')
  check('on the failover lane with the home window OBSERVED reset, the posture speaks (offer/auto)', decideCapReturn('offer', reset, true).kind === 'offer' && decideCapReturn('auto', reset, true).kind === 'auto-handoff', 'decideCapReturn in src/models/roads/capFailover.ts must return offer under posture offer and auto-handoff under posture auto once the home window reads allowed')
  check('an unreset home window keeps everyone parked', decideCapReturn('auto', { window: 'rejected', credentialUsable: true }, true).kind === 'none' && decideCapReturn('auto', { window: 'allowed_warning', credentialUsable: true }, true).kind === 'none', 'decideCapReturn in src/models/roads/capFailover.ts must return none unless the home window reads allowed')
  check("'unknown' is not a reset, and a signed-out home is no home", decideCapReturn('auto', { window: 'unknown', credentialUsable: true }, true).kind === 'none' && decideCapReturn('auto', { window: 'allowed', credentialUsable: false }, true).kind === 'none', 'decideCapReturn in src/models/roads/capFailover.ts must return none for an unknown window or an unusable home credential')
  noteCapReturn()
  check('the way home clears the note, the lane and the mark', capHandoffState() === null && capFailoverLaneOf('openai') === null && failoverMarkFor('gpt-5.6-sol') === null, 'noteCapReturn in src/models/roads/capFailover.ts must clear the handoff note so capHandoffState returns null and the lane and mark go away')
}

console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
