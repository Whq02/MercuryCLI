#!/usr/bin/env bun
// ============================================================================
//  scripts/providers/prove-cap-offer-settles.ts — the usage-cap offer settles
//  or says why, and the offer disarms once answered.
//
//  THE SIGHTING (a Windows session): the OpenAI 5h window approached its cap,
//  the neutral failover offer opened ("⇄ claude-fable-5 · enter opens the
//  transition preview · esc stays put"), enter opened the switch preview
//  ("plan … · confirm applies through the settlement owner"), and confirm
//  painted the OFFER again — offer → preview → confirm → offer, forever; the
//  switch never applied and the operator had to quit and relaunch.
//
//  THE MECHANISM (pinned in §A): the offer's armed state was keyed on the
//  observed window's STATE and its stated RESET moment — both VOLATILE. A
//  window fills from 'warning' to 'rejected', and its stated reset shifts by
//  seconds as every fresh usage header is re-observed (the facts read a
//  confirm triggers re-adopts the OpenAI bands). Each jitter minted a new key
//  the answer had never latched, so the answered offer re-fired on the very
//  next commit. The armed state now latches on the STABLE facts alone
//  (direction + family) and re-arms only on a MATERIAL change.
//
//    §A the armed-state owner — the loop is closed: an answered offer stays
//       disarmed across the exact state/reset jitter that used to re-fire it,
//       and re-arms only when the window materially changes
//    §B the EXACT-ID target — the first-party handoff target is the newest
//       frontier MEMBER the picker/seat persist (claude-fable-5-1), never the
//       generation's collapsed base id (claude-fable-5) nor a display name
//    §C the settlement road — the pick settles through the ONE owner; the
//       frozen plan carries the exact target id; a no-op/refusal is a receipt,
//       never a silent return to the offer
//    §D the neutral law + the decision core stand unchanged (regression)
//    §E the composer wires the stable owner + the exact-id resolver (source)
//
//  Hermetic; pure over injected reads where the owner allows it. Run under bun:
//    ~/.bun/bin/bun run scripts/providers/prove-cap-offer-settles.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'cap-offer-settles-'))
process.env.NODE_ENV = 'test'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const ROOT = join(import.meta.dir, '..', '..')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const cap = await import('../../src/services/capFailover.ts')
const { ALL_MODEL_CONFIGS } = await import('../../src/utils/model/configs.ts')
const { previewForSelection } = await import('../../src/services/providers/transitionPreview.ts')
const { settleModelSelection } = await import('../../src/utils/model/modelTransition.ts')

// The exact-id owner's answer for the newest first-party frontier member.
const FABLE_51 = ALL_MODEL_CONFIGS.fable51.firstParty // 'claude-fable-5-1'
const FABLE_5 = ALL_MODEL_CONFIGS.fable5.firstParty // 'claude-fable-5'

console.log('============================================================')
console.log(' cap offer — settles or says why; disarms once answered')
console.log('============================================================')

// ── §A the armed-state owner — the loop is closed ───────────────────────────
section('§A the armed-state owner — an answered offer survives the state/reset jitter')
{
  cap._resetOfferMemoriesForTesting()

  // The exact OpenAI-warning observation the operator hit, and the two ways
  // it jitters WITHOUT the wall changing: the stated reset shifts as fresh
  // headers arrive, and the window fills warning → rejected. The OLD key
  // (direction|family|state|reset) changed on both; the answer never covered
  // the new key, and the card re-fired.
  const now = Date.now()
  const bandWarn = (resetMs: number, pct: number) => ({
    now: () => now,
    openaiActiveSource: () => 'chatgpt-subscription' as const,
    openaiWall: () => null,
    openaiBands: () => [{ usedPct: pct, resetsAtMs: resetMs, windowName: 'usage window' }],
  })
  const wallReject = (resetMs: number) => ({
    now: () => now,
    openaiActiveSource: () => 'chatgpt-subscription' as const,
    openaiWall: () => ({ resetsAtMs: resetMs }),
  })

  const w1 = cap.observedFamilyWindow('openai', bandWarn(now + 5 * 3600_000, 92))
  check('the observation arms a warning offer for the openai home', w1.state === 'warning')

  // The operator answers the handoff offer (accept or Esc — both latch).
  check('before the answer the handoff offer is armed', cap.capOfferAnswered('handoff', 'openai') === false)
  cap.noteCapOfferAnswered('handoff', 'openai')
  check('the answer disarms the handoff offer', cap.capOfferAnswered('handoff', 'openai') === true)

  // Jitter 1 — the stated reset shifts as a fresh header lands (+4.2s), the
  // pct ticks up: the window is observed again, still capped (not 'allowed').
  const w2 = cap.observedFamilyWindow('openai', bandWarn(now + 5 * 3600_000 + 4200, 93))
  cap.noteCapWindowObserved('openai', w2.state)
  check(
    'a shifted reset moment does NOT re-arm the answered offer (the loop is closed)',
    cap.capOfferAnswered('handoff', 'openai') === true,
    `w2.state=${w2.state}`,
  )

  // Jitter 2 — the window fills warning → rejected (a hard wall now): still
  // the same wall, still disarmed.
  const w3 = cap.observedFamilyWindow('openai', wallReject(now + 5 * 3600_000))
  cap.noteCapWindowObserved('openai', w3.state)
  check(
    'the warning → rejected fill does NOT re-arm the answered offer',
    w3.state === 'rejected' && cap.capOfferAnswered('handoff', 'openai') === true,
  )

  // The MATERIAL change — the window is OBSERVED reset ('allowed'): NOW the
  // handoff re-arms, a genuinely new wall may re-offer.
  cap.noteCapWindowObserved('openai', 'allowed')
  check(
    "an OBSERVED reset ('allowed') re-arms the handoff — a new wall re-offers",
    cap.capOfferAnswered('handoff', 'openai') === false,
  )

  // 'unknown' (nothing observed — a credential just changed) is not a
  // transition and re-arms nothing: an answered return stays answered.
  cap.noteCapOfferAnswered('return', 'openai')
  cap.noteCapWindowObserved('openai', 'unknown')
  check("'unknown' re-arms neither direction (no re-nag on a credential change)", cap.capOfferAnswered('return', 'openai') === true)
  // A capped observation re-arms the RETURN (a later reset may offer the way home).
  cap.noteCapWindowObserved('openai', 'rejected')
  check('the window capping again re-arms the RETURN offer', cap.capOfferAnswered('return', 'openai') === false)

  // The two directions and the two families never collide.
  cap._resetOfferMemoriesForTesting()
  cap.noteCapOfferAnswered('handoff', 'openai')
  check('answering the openai handoff leaves the anthropic handoff armed', cap.capOfferAnswered('handoff', 'anthropic') === false)
  check('answering the handoff leaves the same family RETURN armed', cap.capOfferAnswered('return', 'openai') === false)
}

// ── §B the EXACT-ID target ──────────────────────────────────────────────────
section('§B the target is the exact newest frontier MEMBER, never the collapsed base id')
{
  cap._resetOfferMemoriesForTesting()
  // The exact-id owner (the model-config table) — the two distinct fable ids.
  check('the config table names the two fable members distinctly', FABLE_51 === 'claude-fable-5-1' && FABLE_5 === 'claude-fable-5' && FABLE_51 !== FABLE_5)

  // The neutral candidate law derives the first-party handoff target: an
  // OpenAI home walls, the anthropic lane is a usable candidate, and its
  // target model is the NEWEST frontier member (fable-5-1), never the base
  // member (fable-5) the family default and the canonicaliser collapse to.
  const usability = {
    anthropic: { usable: true, blockers: [] as string[] },
    openai: { usable: true, blockers: [] as string[] },
  }
  // The first-party frontier FACT answers the family DEFAULT (fable-5) — the
  // resolver under test must upgrade it to the newest member.
  const derived = cap.deriveCapFailoverCandidates(
    'openai',
    usability,
    route => (route === 'anthropic' ? cap._firstPartyFrontierMemberForTest(FABLE_5) : undefined),
  )
  const anthropicCandidate = derived.candidates.find(c => c.route === 'anthropic')
  check('the anthropic lane is a candidate when openai is home (the neutral law)', anthropicCandidate !== undefined)
  check(
    'the handoff target is the exact newest frontier member (claude-fable-5-1)',
    anthropicCandidate?.model === FABLE_51,
    `got ${anthropicCandidate?.model}`,
  )
  check('the handoff target is NOT the collapsed base id (claude-fable-5)', anthropicCandidate?.model !== FABLE_5)
  check('the handoff target is a real id, never a display name or a bare alias', anthropicCandidate?.model !== 'Fable 5.1' && anthropicCandidate?.model !== 'fable' && anthropicCandidate?.model !== 'fable51')

  // The frozen preview plan the confirm card carries names the SAME exact id.
  const plan = previewForSelection([], 'gpt-5.6-sol', FABLE_51)
  check('the transition plan carries the exact target id', plan.to === FABLE_51)
  check('the plan is a real cross-provider move to the anthropic wire', plan.crossProvider === true && plan.targetRoute === 'anthropic')
}

// ── §C the settlement road — settles, or a receipt says why ─────────────────
section('§C confirm settles through the ONE owner; a no-op is a receipt, never a loop')
{
  // The pick settles through settleModelSelection — the exact target lands,
  // the receipt names it, and the next turn rides the new seat.
  const applied = settleModelSelection(
    { mainLoopModel: 'gpt-5.6-sol', mainLoopModelForSession: null, pendingModelSwitch: null },
    FABLE_51,
    { turnActive: false },
  )
  check('confirm applies the switch through the ONE settlement owner', applied.kind === 'applied')
  check('the applied receipt carries the exact target id', applied.kind === 'applied' && applied.receipt.applied === FABLE_51)
  check('the applied receipt names the previous seat (the way back)', applied.kind === 'applied' && applied.receipt.previous === 'gpt-5.6-sol')
  check('the settlement is a real cross-provider move', applied.kind === 'applied' && applied.receipt.crossProvider === true)

  // A settle that no-ops (the session is ALREADY on the target) says so with a
  // receipt-shaped verdict — never a silent nothing that leaves the card to
  // re-open. This is the shape the composer paints as "already on … —
  // nothing to change", not the offer again.
  const noop = settleModelSelection(
    { mainLoopModel: FABLE_51, mainLoopModelForSession: null, pendingModelSwitch: null },
    FABLE_51,
    { turnActive: false },
  )
  check('a same-seat confirm is a typed no-op verdict (a receipt, not a loop)', noop.kind === 'no-op')

  // A confirm while a turn is in flight QUEUES (a typed verdict), never silent.
  const queued = settleModelSelection(
    { mainLoopModel: 'gpt-5.6-sol', mainLoopModelForSession: null, pendingModelSwitch: null },
    FABLE_51,
    { turnActive: true },
  )
  check('a mid-turn confirm queues at the boundary (a typed verdict)', queued.kind === 'queued')
}

// ── §D the neutral law + the decision core stand ────────────────────────────
section('§D the neutral candidate law and the decision core are unchanged')
{
  cap._resetOfferMemoriesForTesting()
  // Every OTHER signed-in usable family is a candidate; the home never is;
  // sign-in recency orders them (no favoured family).
  const map = {
    anthropic: { usable: true, blockers: [] as string[] },
    openai: { usable: true, blockers: [] as string[] },
    zai: { usable: true, blockers: [] as string[] },
  }
  const at: Record<string, number> = { anthropic: 3000, openai: 2000, zai: 1000 }
  const targets: Record<string, string> = { anthropic: FABLE_51, openai: 'gpt-5.6-sol', zai: 'glm-4.6' }
  const fromOpenai = cap.deriveCapFailoverCandidates('openai', map, r => targets[r], f => at[f])
  check('the home family (openai) is never a candidate for its own handoff', fromOpenai.candidates.every(c => c.route !== 'openai'))
  check('anthropic IS a candidate when it is not home', fromOpenai.candidates.some(c => c.route === 'anthropic'))
  check('sign-in recency orders the set (anthropic 3000 before zai 1000)', fromOpenai.candidates[0]?.route === 'anthropic')

  // The pure decision matrix (untouched): off is a total no-op; the default
  // OFFERS; unknown is never a wall; return needs an OBSERVED reset.
  check('off × rejected ⇒ none', cap.decideCapAction('off', 'rejected').kind === 'none')
  check('offer × warning ⇒ offer', cap.decideCapAction('offer', 'allowed_warning').kind === 'offer')
  check("unknown ⇒ none (no observation is not a wall)", cap.decideCapAction('offer', 'unknown').kind === 'none')
  check('return needs an observed reset', cap.decideCapReturn('offer', { window: 'allowed', credentialUsable: true }, true).kind === 'offer')
  check("return stays put while the home window is unknown", cap.decideCapReturn('offer', { window: 'unknown', credentialUsable: true }, true).kind === 'none')
}

// ── §E the composer wires the stable owner + the exact-id resolver ──────────
section('§E the composer answers on the STABLE owner; the exact-id resolver is wired')
{
  const composer = readFileSync(join(ROOT, 'src/components/PromptInput/PromptInput.tsx'), 'utf8')
  // The cross-family rung no longer arms on the volatile decisionKey.
  check('the composer no longer keys the cross-family arm on the volatile state|reset string', !/`\$\{direction\}\|\$\{homeFamily\}\|\$\{window\.state\}/.test(composer))
  check('the composer answers the cross-family offer on the stable owner', /capOfferAnswered\(direction, homeFamily\)/.test(composer))
  check('the composer re-arms on the observed window every commit', /noteCapWindowObserved\(homeFamily, window\.state\)/.test(composer))
  check('the offer accept latches the stable owner', /noteCapOfferAnswered\(offer\.direction, offer\.homeRoute\)/.test(composer))

  const owner = readFileSync(join(ROOT, 'src/services/capFailover.ts'), 'utf8')
  check('the exact-id resolver upgrades the anthropic target to the newest member', /route === 'anthropic' && fact !== undefined\s*\?\s*newestFirstPartyFrontierMember\(fact\)/.test(owner))
}

console.log(`\n${failures === 0 ? 'CAP OFFER SETTLES: ALL PASS' : `FAILURES: ${failures}`}`)
process.exit(failures === 0 ? 0 : 1)
