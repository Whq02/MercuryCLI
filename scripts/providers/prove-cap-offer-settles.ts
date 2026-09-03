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

// ── §F the LIST — every other signed-in family, ledger order, at-cap last ───
section('§F the offer lists every other signed-in family; at-cap lanes last and marked; the switch lands on the CHOSEN row')
{
  cap._resetOfferMemoriesForTesting()
  const now = Date.now()
  type Lane = { usable: boolean; blockers: string[]; credential?: 'oauth' | 'api-key' | 'keyless' | 'none' }
  // Four signed-in families beside the OpenAI home — two at their caps.
  const map: Record<string, Lane> = {
    openai: { usable: true, blockers: [], credential: 'oauth' },
    anthropic: { usable: true, blockers: [], credential: 'oauth' },
    zai: { usable: true, blockers: [], credential: 'api-key' },
    deepseek: { usable: true, blockers: [], credential: 'api-key' },
    gemini: { usable: false, blockers: ['the Gemini usage window is reached — resets later'], credential: 'oauth' },
    huggingface: { usable: false, blockers: ['the Hugging Face usage window is reached'], credential: 'api-key' },
    // A signed-OUT lane at a stale cap has no seat to list.
    openrouter: { usable: false, blockers: ['no OpenRouter credential — /logins'], credential: 'none' },
  }
  const targets: Record<string, string> = {
    anthropic: FABLE_51,
    zai: 'glm-4.7',
    deepseek: 'deepseek-chat-v3.4',
    gemini: 'gemini-3-pro',
    huggingface: 'huggingface/qwen-3',
    openrouter: 'openrouter/x',
  }
  // The sign-in ledger: zai newest, then gemini, anthropic, huggingface; deepseek untimed.
  const at: Record<string, number> = { zai: 5000, gemini: 4000, anthropic: 3000, huggingface: 2000 }
  const windows: Record<string, ReturnType<typeof cap.observedFamilyWindow>> = {
    anthropic: { family: 'anthropic', state: 'allowed', basis: 'observed', usedPct: 10, windowName: 'session limit' },
    zai: { family: 'zai', state: 'unknown', basis: 'none' },
    deepseek: { family: 'deepseek', state: 'warning', basis: 'observed', usedPct: 72, windowName: 'usage window', resetsAtMs: now + 3600_000 },
    gemini: { family: 'gemini', state: 'rejected', basis: 'observed', resetsAtMs: now + 7200_000, windowName: 'usage window' },
    huggingface: { family: 'huggingface', state: 'rejected', basis: 'observed', windowName: 'usage window' },
    openrouter: { family: 'openrouter', state: 'rejected', basis: 'observed', windowName: 'usage window' },
  }
  const set = cap.deriveCapFailoverCandidates('openai', map, r => targets[r], f => at[f], r => windows[r] as ReturnType<typeof cap.observedFamilyWindow>)
  check(
    'the OFFERABLE candidates are the usable lanes in sign-in order (zai, anthropic, then the untimed deepseek)',
    JSON.stringify(set.candidates.map(c => c.route)) === JSON.stringify(['zai', 'anthropic', 'deepseek']),
    JSON.stringify(set.candidates),
  )
  check('the LIST is the candidates first, then the lanes at their own cap — in the ledger order within each part', JSON.stringify(set.listed.map(r => r.route)) === JSON.stringify(['zai', 'anthropic', 'deepseek', 'gemini', 'huggingface']), JSON.stringify(set.listed.map(r => r.route)))
  check('the at-cap lanes are MARKED and never usable', set.listed.filter(r => r.atCap).map(r => r.route).join(',') === 'gemini,huggingface' && set.listed.filter(r => r.atCap).every(r => !r.usable))
  check('the first candidate (the default highlight, the auto target) is never an at-cap lane', set.candidates[0]?.route === 'zai' && !set.listed[0]?.atCap)
  check('a signed-OUT lane at a stale cap is not listed (no seat to switch to)', !set.listed.some(r => r.route === 'openrouter'))
  check('every row lands on the exact id its family persists', set.listed.every(r => r.model === targets[r.route]) && set.listed.find(r => r.route === 'anthropic')?.model === FABLE_51)
  check('the partition law stands: every non-candidate family is a typed exclusion', set.candidates.length + set.excluded.length === Object.keys(map).length - 1)
  // The usage words each row prints — the stated utilisation and its window,
  // the cap with its reset, or the honest absence.
  const words = Object.fromEntries(set.listed.map(r => [r.route, cap.capUsageWords(r.window, r.route === 'gemini' ? '5:47pm' : null)]))
  check("a family with a live window prints '<pct>% of the <window>'", words.anthropic === '10% of the session limit' && words.deepseek === '72% of the usage window', JSON.stringify(words))
  check("a family that reports no usage prints 'no usage read'", words.zai === 'no usage read')
  check('an at-cap family prints the cap and its reset', words.gemini === 'at its cap — usage window resets 5:47pm' && words.huggingface === 'at its cap — usage window', JSON.stringify(words))
  // The switch lands on the CHOSEN row — the third row, not the first.
  const chosen = set.listed[2] as (typeof set.listed)[number]
  const landed = settleModelSelection({ mainLoopModel: 'gpt-5.6-sol', mainLoopModelForSession: null, pendingModelSwitch: null }, chosen.model, { turnActive: false })
  check('confirming the highlighted row settles on THAT family, not the first', chosen.route === 'deepseek' && landed.kind === 'applied' && landed.receipt.applied === 'deepseek-chat-v3.4')
  // …and the offer disarms for the home family whichever row was chosen.
  cap.noteCapOfferAnswered('handoff', 'openai')
  cap.noteCapWindowObserved('openai', 'warning')
  check('the offer disarms for the home family after the choice (a jitter never re-opens it)', cap.capOfferAnswered('handoff', 'openai') === true)
  // With exactly one other family the set reads as the single-target offer.
  const single = cap.deriveCapFailoverCandidates('openai', { openai: map.openai as Lane, anthropic: map.anthropic as Lane }, r => targets[r], f => at[f], r => windows[r] as ReturnType<typeof cap.observedFamilyWindow>)
  check('exactly one other family ⇒ one candidate and one listed row (the card reads as the single-target card)', single.candidates.length === 1 && single.listed.length === 1 && single.listed[0]?.route === 'anthropic')
  // No window read (the auto/wall-row callers) ⇒ the list mirrors the candidates, nothing reads as at-cap.
  const blind = cap.deriveCapFailoverCandidates('openai', map, r => targets[r], f => at[f])
  check('without a window read no lane is at-cap and the list mirrors the candidates', blind.listed.every(r => !r.atCap) && JSON.stringify(blind.listed.map(r => r.route)) === JSON.stringify(blind.candidates.map(c => c.route)))
}

// ── §G the BINDING window — the per-model weekly pool ──────────────────────
section('§G the offer fires on the BINDING window: the seat model\'s weekly pool, named — a family without pools reads as before')
{
  const now = Date.now()
  const poolReset = now + (22 * 3600 + 51 * 60) * 1000
  // The operator's usage page: 5h 36% · weekly (all models) 44% · weekly FABLE 87%
  // — the rows exactly as the usage reader states them (its own view shape).
  const live = (key: string, label: string, usedPct: number, resetsAtMs: number) => ({ key, label, state: 'live' as const, usedPct, resetsAtMs })
  const reads = {
    now: () => now,
    anthropic: () => ({ status: 'allowed' as const, observed: true }),
    anthropicWindows: () => [live('5h', '5h', 36, now + 3600_000), live('7d', '7d', 44, now + 5 * 86400_000)],
    anthropicPools: () => [
      live('seven_day_fable', 'Fable', 87, poolReset),
      live('seven_day_opus', 'Opus', 20, poolReset),
      live('seven_day_sonnet', 'Sonnet', 5, poolReset),
    ],
  }
  // ONE owner of "which window binds this seat" and of its name: the usage
  // owner's bindingWindowOf. The resolver carries no copy of the rule.
  const { bindingWindowOf } = await import('../../src/services/providers/providerUsage.ts')
  const ownerPick = bindingWindowOf({ provider: 'anthropic', shape: 'subscription-windows', windows: reads.anthropicWindows(), pools: reads.anthropicPools() }, FABLE_51)
  check("the usage owner picks the Fable pool for a Fable seat and names it in the strip's words ('Fable limit')", ownerPick?.window.key === 'seven_day_fable' && ownerPick?.windowName === 'Fable limit', JSON.stringify(ownerPick))
  const owner = readFileSync(join(ROOT, 'src/services/capFailover.ts'), 'utf8')
  const ownerCode = owner.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
  check('the resolver routes the pool read through the usage owner (bindingWindowOf) and keeps no private applicability rule', owner.includes('bindingWindowOf(') && !owner.includes('bindingPoolKeyFor') && !ownerCode.some(l => /seven_day_(fable|opus|sonnet)/.test(l) || /includes\('(fable|mythos|opus|sonnet)'\)/.test(l) || l.includes('weekly ${')))
  const fableSeat = cap.observedFamilyWindow('anthropic', reads, { model: FABLE_51 })
  check('running Fable with the Fable pool at 87% ⇒ WARNING, even while 5h/7d read 36%/44%', fableSeat.state === 'warning' && fableSeat.basis === 'observed', JSON.stringify(fableSeat))
  check("…and the window carries the owner's name — 'Fable limit', never 'weekly Fable limit' — with its reset and its utilisation", fableSeat.windowName === 'Fable limit' && fableSeat.resetsAtMs === poolReset && fableSeat.usedPct === 87, JSON.stringify(fableSeat))
  check('the offer fires on it (offer × warning ⇒ offer)', cap.decideCapAction('offer', fableSeat.state).kind === 'offer')
  const opusSeat = cap.observedFamilyWindow('anthropic', reads, { model: 'claude-opus-5' })
  check("the same account on an Opus seat reads ALLOWED — the owner binds the highest-used applicable window (the 44% week, not the 20% Opus pool)", opusSeat.state === 'allowed' && opusSeat.usedPct === 44 && opusSeat.windowName === undefined, JSON.stringify(opusSeat))
  const haikuSeat = cap.observedFamilyWindow('anthropic', reads, { model: 'claude-haiku-4-5' })
  check('a seat no pool meters reads the shared windows (allowed, the worst shared utilisation on the usage line)', haikuSeat.state === 'allowed' && haikuSeat.usedPct === 44)
  const noModel = cap.observedFamilyWindow('anthropic', reads)
  check('with no seat model the latch alone decides (the wall-row and auto callers)', noModel.state === 'allowed' && noModel.windowName === undefined && noModel.usedPct === undefined)
  // The worse verdict binds: a REJECTED latch (a 429) outranks a pool warning.
  const walled = cap.observedFamilyWindow('anthropic', { ...reads, anthropic: () => ({ status: 'rejected' as const, observed: true, resetsAtMs: now + 60_000, windowName: 'weekly limit' }) }, { model: FABLE_51 })
  check("a reached window on the wire outranks the pool warning (the latch's own name)", walled.state === 'rejected' && walled.windowName === 'weekly limit')
  const poolFull = cap.observedFamilyWindow('anthropic', { ...reads, anthropicPools: () => [live('seven_day_fable', 'Fable', 100, poolReset)] }, { model: FABLE_51 })
  check('a pool at 100% is a reached window (rejected), named by the owner', poolFull.state === 'rejected' && poolFull.windowName === 'Fable limit')
  const poolStale = cap.observedFamilyWindow('anthropic', { ...reads, anthropicPools: () => [live('seven_day_fable', 'Fable', 99, now - 1)] }, { model: FABLE_51 })
  check('a pool whose stated reset passed is stale — it never binds', poolStale.state === 'allowed' && poolStale.windowName !== 'Fable limit')
  const openaiSeat = cap.observedFamilyWindow('openai', { now: () => now, openaiActiveSource: () => 'chatgpt-subscription' as const, openaiWall: () => null, openaiBands: () => [{ usedPct: 92, resetsAtMs: now + 5 * 3600_000, windowName: '5h window' }] }, { model: 'gpt-5.6-sol' })
  check('a family without per-model pools reads as before (the neutral grammar)', openaiSeat.state === 'warning' && openaiSeat.windowName === '5h window' && openaiSeat.usedPct === 92)
  const throwingPools = cap.observedFamilyWindow('anthropic', { ...reads, anthropicPools: () => { throw new Error('reader down') } }, { model: FABLE_51 })
  check('a pool reader that throws never unsettles the latch fact', throwingPools.state === 'allowed')

  // THE LIVE ACCESSOR ROAD: a fixture usage response carrying seven_day_fable
  // near its cap, folded into the usage record the reader serves — the
  // resolver reads the pool through providerUsage's own accessors and the
  // owner's own pick.
  const limits = await import('../../src/services/claudeAiLimits.ts')
  limits.__setRawUtilizationForTest({
    five_hour: { utilization: 0.36, resets_at: Math.floor((now + 3600_000) / 1000) },
    seven_day: { utilization: 0.44, resets_at: Math.floor((now + 5 * 86400_000) / 1000) },
    seven_day_fable: { utilization: 0.87, resets_at: Math.floor(poolReset / 1000) },
  })
  const liveRoad = cap.observedFamilyWindow('anthropic', { now: () => now, anthropic: () => ({ status: 'allowed' as const, observed: true }) }, { model: FABLE_51 })
  check("the LIVE accessor road: the usage record's seven_day_fable at 87% arms the offer, named 'Fable limit'", liveRoad.state === 'warning' && liveRoad.windowName === 'Fable limit' && Math.round(liveRoad.usedPct ?? 0) === 87, JSON.stringify(liveRoad))
  limits.__setRawUtilizationForTest({})
}

// ── §H the card lists and names the window (source) ────────────────────────
section('§H the card: ↑↓ over the rows, ↵ for the highlighted row, esc stays put; the window named in the neutral grammar')
{
  const card = readFileSync(join(ROOT, 'src/components/CapOfferCard.tsx'), 'utf8')
  check('the card lists only with MORE than one other family (one family reads as today)', card.includes('rows !== undefined && rows.length > 1 ? rows : null'))
  check('↑↓ ride the Confirmation context\'s own previous/next actions', card.includes("'confirm:previous'") && card.includes("'confirm:next'") && card.includes("context: 'Confirmation', isActive: list !== null"))
  check('↵ hands the HIGHLIGHTED row to the pick site; an at-cap row keeps enter inert', card.includes('if (usable) onAccept(chosen)') && card.includes('highlighted.usable && !highlighted.atCap'))
  check('the guide says ↑↓ choose only when listing, beside the one true enter line', card.includes('↑↓ choose ${GLYPH.dot} ') && card.includes('`enter opens the transition preview ${GLYPH.dot} ${escKey} stays put`'))
  check('each row prints the family, the landing row and its usage words; at-cap rows carry the mark', card.includes('capUsageWords(row.window, rowReset)') && card.includes("row.atCap ? `${GLYPH.warn} ` : ''"))
  check("the binding window is named as the wire named it — never a second 'window' after it", card.includes('`approaching the ${homeName} ${windowNoun}`') && !card.includes("${windowName ?? 'usage'} window"))
  check('the card owns the keyboard while it stands (esc never doubles as the turn interrupt)', card.includes("useRegisterOverlay('cap-offer')"))
  const composer = readFileSync(join(ROOT, 'src/components/PromptInput/PromptInput.tsx'), 'utf8')
  check('the composer reads the home window FOR the seat model (the pool that binds)', composer.includes('model: onFailoverLane ? (noted?.homeModel ?? null) : effective'))
  check('the composer hands the card the whole list from the one owner and settles the CHOSEN row', composer.includes('rows = set.listed') && composer.includes('handleModelSelect(chosen.model)'))
}

// ── §I the SLOT rung hardened the same way ─────────────────────────────────
section('§I the within-family slot rung: a stable wall key, re-armed only by an observed clear')
{
  cap._resetOfferMemoriesForTesting()
  check('the slot wall key is the family and the walled seat — no reset moment', cap.slotWallKey('openai', 'subscription') === 'slot|openai|subscription')
  const key = cap.slotWallKey('openai', 'subscription')
  cap.noteOfferDismissal(key)
  cap.noteOfferAutoDone(key)
  cap.noteSlotWallObserved('openai', 'subscription', true)
  check('a standing wall re-observed (its reset re-stated) keeps the answered offer and the auto latch', cap.offerDismissed(key) && cap.offerAutoDone(key))
  cap.noteSlotWallObserved('openai', 'subscription', false)
  check('an observed CLEAR ends the wall — the offer and the auto latch re-arm for the next wall', !cap.offerDismissed(key) && !cap.offerAutoDone(key))
  cap.noteOfferDismissal(key)
  cap.noteSlotWallObserved('openai', 'api-key', false)
  check('a clear on the OTHER seat leaves this seat\'s answered wall alone', cap.offerDismissed(key))
  const composer = readFileSync(join(ROOT, 'src/components/PromptInput/PromptInput.tsx'), 'utf8')
  check('the composer keys the slot rung on the stable owner and re-arms from the observed wall', composer.includes("slotWallKey(family, view.active ?? '')") && composer.includes("noteSlotWallObserved(family, view.active ?? '', activeWall.walled)"))
  check('the slot key no longer carries the reset moment', !composer.includes("${activeWall.resetsAtMs ?? ''}`"))
}

// ── §J the offer follows the usage records' own change signals ─────────────
section("§J a band that lands re-runs the offer at once: the OpenAI record's change signal, and the composer following both families' signals")
{
  const openai = await import('../../src/services/providers/openai/openaiLimitState.ts')
  openai.__resetOpenaiLimitStateForTest()
  let fired = 0
  const off = openai.subscribeOpenaiObserved(() => {
    fired++
  })
  const v0 = openai.getOpenaiObservedVersion()
  const now = Date.now()
  openai.adoptOpenaiObservedUsage({ primary: { usedPct: 92, windowMinutes: 300, resetsAtMs: now + 3600_000, observedAtMs: now - 5_000 } })
  check('a band adopted from the facts feed bumps the version and wakes the subscriber', openai.getOpenaiObservedVersion() === v0 + 1 && fired === 1)
  openai.adoptOpenaiObservedUsage({ primary: { usedPct: 11, observedAtMs: now - 60_000 } })
  check('a STALE adoption (older than the held band) changes nothing and signals nothing', openai.getOpenaiObservedVersion() === v0 + 1 && fired === 1)
  openai.recordOpenaiRateHeaders(new Headers({ 'x-codex-primary-used-percent': '93', 'x-codex-primary-window-minutes': '300', 'x-codex-primary-reset-after-seconds': '3595' }), () => now)
  check("a response's usage headers bump the version", openai.getOpenaiObservedVersion() === v0 + 2 && fired === 2)
  openai.recordOpenaiRateHeaders(new Headers({ 'content-type': 'text/event-stream' }), () => now)
  check('headers that state no band change nothing and signal nothing', openai.getOpenaiObservedVersion() === v0 + 2)
  openai.recordOpenaiUsageLimit(now + 60_000, 'chatgpt-subscription', () => now)
  check('an observed wall (a 429 with its reset) bumps the version', openai.getOpenaiObservedVersion() === v0 + 3)
  openai.forgetOpenaiLimitSource('chatgpt-subscription')
  check('forgetting a source (a sign-out) bumps the version', openai.getOpenaiObservedVersion() === v0 + 4)
  off()
  openai.recordOpenaiUsageLimit(now + 60_000, 'api-key', () => now)
  check('an unsubscribed listener hears nothing more', fired === 4)
  openai.__resetOpenaiLimitStateForTest()
  const composer = readFileSync(join(ROOT, 'src/components/PromptInput/PromptInput.tsx'), 'utf8')
  check("the composer follows the anthropic record's version and the OpenAI record's version (the cap effect re-runs on either)", composer.includes('useSyncExternalStore(subscribeUsageRecord, getUsageRecordVersion, getUsageRecordVersion)') && composer.includes('useSyncExternalStore(subscribeOpenaiObserved, getOpenaiObservedVersion, getOpenaiObservedVersion)'))
  // The strip's warning is the same reader over the same records: it must
  // re-derive on the records' signals too, or an endpoint fold that lands
  // the session model's pool waits for a slow tick (the capture on a slow
  // runner found the strip empty beside a rail showing the Opus week at 87%).
  const strip = readFileSync(join(ROOT, 'src/hooks/notifs/useRateLimitWarningNotification.tsx'), 'utf8')
  check("the strip warning follows both records' versions and re-derives on them", strip.includes('useSyncExternalStore(subscribeUsageRecord, getUsageRecordVersion, getUsageRecordVersion)') && strip.includes('useSyncExternalStore(subscribeOpenaiObserved, getOpenaiObservedVersion, getOpenaiObservedVersion)') && /\[limits, model, tick, connector, addNotification, usageRecordVersion, openaiObservedVersion\]/.test(strip))
}

console.log(`\n${failures === 0 ? 'CAP OFFER SETTLES: ALL PASS' : `FAILURES: ${failures}`}`)
process.exit(failures === 0 ? 0 : 1)
