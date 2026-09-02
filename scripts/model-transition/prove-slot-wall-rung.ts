#!/usr/bin/env bun
// ============================================================================
//  scripts/model-transition/prove-slot-wall-rung.ts — the WITHIN-FAMILY slot
// rung of the cap-survival ladder: a walled
//  ACTIVE slot whose family holds a second signed-in slot with headroom is
//  never a dead end. The operator's law re-dials the posture for
//  THIS rung only — off/offer both ASK in one key, auto switches unattended
//  — while decideCapAction's R5 total off-no-op stands untouched for the
//  cross-family move.
//
//    §A the slot decision table — posture × wall facts, all arms
//    §B the R5 pin BESIDE it: the cross-family 'off' stays a total no-op
//    §C the wall-row appendix words: the offer named at off/offer, the
//       armed auto switch named at auto, the other slot's OWN wall named
//       instead of headroom, silence exactly when no pair exists
//    §D the surfaces (structural): the openai wall sentence appends the
//       appendix; the anthropic wall row renders the slot remedy FIRST;
//       the composer runs the rung before the cross-family block, offers
//       through SlotOfferCard, autos once per wall key, and both accept
//       roads ride the ONE switch owner
//
//  Run: ~/.bun/bin/bun run scripts/model-transition/prove-slot-wall-rung.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ROOT = join(import.meta.dir, '..', '..')
delete process.env.MERCURY_CAP_FAILOVER
const { decideSlotWallAction, decideCapAction } = await import('../../src/services/capFailover.ts')
const { slotWallAppendix } = await import('../../src/services/providers/slotSwitch.ts')
type Reads = import('../../src/services/providers/slotSwitch.ts').SlotSwitchReads

section('§A the slot decision table — the wall is never a dead end')
{
  const wallWithPair = { activeWalled: true, otherSignedIn: true, otherWalled: false }
  check("off × wall+pair ⇒ OFFER (the ask — the operator's re-dial of OFF for this rung)", decideSlotWallAction('off', wallWithPair).kind === 'offer')
  check('offer × wall+pair ⇒ OFFER', decideSlotWallAction('offer', wallWithPair).kind === 'offer')
  check('auto × wall+pair ⇒ AUTO-SWITCH (unattended, receipted)', decideSlotWallAction('auto', wallWithPair).kind === 'auto-switch')
  for (const posture of ['off', 'offer', 'auto'] as const) {
    check(`${posture} × no wall ⇒ none`, decideSlotWallAction(posture, { ...wallWithPair, activeWalled: false }).kind === 'none')
    check(`${posture} × no second slot ⇒ none (nothing to offer)`, decideSlotWallAction(posture, { ...wallWithPair, otherSignedIn: false }).kind === 'none')
    check(`${posture} × other slot's own wall ⇒ none (headroom is never invented)`, decideSlotWallAction(posture, { ...wallWithPair, otherWalled: true }).kind === 'none')
  }
}

section("§B the R5 pin beside it — cross-family 'off' stays a TOTAL no-op")
{
  for (const quota of ['allowed', 'allowed_warning', 'rejected'] as const) {
    check(`decideCapAction off × ${quota} ⇒ none (the ratified default untouched)`, decideCapAction('off', quota).kind === 'none')
  }
}

section('§C the wall-row appendix words')
{
  const pair: Reads = {
    openaiSubscription: () => ({ label: 'ChatGPT plus subscription' }),
    openaiKey: () => ({ source: 'stored' }),
    openaiActiveKind: () => 'chatgpt-subscription',
    openaiWallOf: () => ({ state: 'clear' }),
  }
  const ask = slotWallAppendix('openai', { reads: pair, posture: 'off' })
  check('off: the appendix OFFERS — names the other slot, the one key, the words door', ask.includes('OpenAI API key (stored)') && ask.includes('signed in with headroom') && ask.includes('one key') && ask.includes('/router source'))
  check('offer: same ask words', slotWallAppendix('openai', { reads: pair, posture: 'offer' }).includes('one key'))
  const auto = slotWallAppendix('openai', { reads: pair, posture: 'auto' })
  check("auto: the appendix RECEIPTS the armed switch ('switches … now · next turn rides it')", auto.includes("'auto' is armed") && auto.includes('switches to the OpenAI API key (stored) now') && auto.includes('next turn rides it'))
  const otherWalled = slotWallAppendix('openai', {
    posture: 'off',
    reads: { ...pair, openaiWallOf: () => ({ state: 'limited', resetsAtMs: Date.now() + 60_000, observedAtMs: Date.now() }) },
  })
  check("the other slot's OWN wall is named — never advertised as headroom", otherWalled.includes('OWN window reached') && otherWalled.includes('no headroom to offer') && !otherWalled.includes('signed in with headroom'))
  check('no pair ⇒ silence (today\'s words stand)', slotWallAppendix('openai', { posture: 'off', reads: { ...pair, openaiKey: () => undefined } }) === '')
  const anthropicPair: Reads = {
    anthropicSubscriptionStored: () => true,
    anthropicManagedKeyPresent: () => true,
    anthropicSubscriberSeat: () => true,
    anthropicEnvCredential: () => undefined,
    anthropicSubscriptionLabel: () => 'Claude subscription (max)',
    anthropicWall: () => ({ walled: false }),
  }
  const anthropicAsk = slotWallAppendix('anthropic', { reads: anthropicPair, posture: 'off' })
  check('anthropic: the appendix names the managed key and ITS words door', anthropicAsk.includes('Anthropic API key (/logins managed key)') && anthropicAsk.includes('/router source anthropic'))
  // FN-016 R18: the managed key's own window has no observation road from
  // the subscription seat — the claim must be observable or unspoken, so
  // the words say 'unobserved', never assert headroom.
  check('anthropic: an UNOBSERVABLE window is spoken as such — never "headroom"', anthropicAsk.includes('unobserved') && !anthropicAsk.includes('signed in with headroom'))
  const anthropicAuto = slotWallAppendix('anthropic', { reads: anthropicPair, posture: 'auto' })
  check('anthropic auto: the armed-switch receipt claims the switch, not headroom', anthropicAuto.includes("'auto' is armed") && !anthropicAuto.includes('headroom'))
}

section('§C2 the wall row remedies are composed ONCE, where the row is created (FN-016 R9)')
{
  // A transcript row is a record of what was true when it printed. The
  // remedy lines used to be recomputed in the RENDER body from live slot,
  // account and lane state, so a slot flip REWROTE a settled wall row —
  // advertising the exhausted slot as having headroom and dropping the
  // subscriber upsell line. The composition owner is pure over injected
  // reads; the creation site (the API-error mint) calls it with live
  // defaults, and the renderer paints the baked text only.
  const { composeAnthropicWallRemedies } = await import('../../src/services/rateLimitMessages.ts')
  const all = composeAnthropicWallRemedies({
    slotAppendix: () => 'The other slot is signed in — the wall card offers the switch in one key.',
    upsellEligible: () => true,
    laneTarget: () => ({ route: 'openai', name: 'OpenAI' }),
  })
  check('all three remedies ride the block, newline-led, one line each', all.startsWith('\n') && all.split('\n').filter(l => l !== '').length === 3)
  const slotAt = all.indexOf('wall card offers')
  const planAt = all.indexOf('/logins')
  const laneAt = all.indexOf('OpenAI lane is usable now')
  check('the ORDER law rides the composer: slot remedy first', slotAt >= 0 && planAt > slotAt, `${slotAt} vs ${planAt}`)
  check('…the plan remedy second, the other provider LAST', laneAt > planAt, `${planAt} vs ${laneAt}`)
  check('the lane remedy bills honestly (account attribution)', all.includes('bills under your OpenAI account'))
  const localLane = composeAnthropicWallRemedies({
    slotAppendix: () => '',
    upsellEligible: () => false,
    laneTarget: () => ({ route: 'local', name: 'Local' }),
  })
  check('the local lane speaks its no-API-billing variant', localLane.includes('your own server; no API billing'))
  check('nothing to say ⇒ the empty string (no bare newline rides the row)',
    composeAnthropicWallRemedies({ slotAppendix: () => '', upsellEligible: () => false, laneTarget: () => null }) === '')
}

section('§D the surfaces (structural)')
{
  const call = readFileSync(join(ROOT, 'src/services/providers/openai/openaiCallModel.ts'), 'utf8')
  check('the openai usage-limit row appends the slot appendix', call.includes("slotWallAppendix('openai')") && call.includes('${slotAppendix'))
  check('the openai wall sentence keeps the never-silent-reroute law', call.includes('never changes the account source without your word'))
  const errorsSrc = readFileSync(join(ROOT, 'src/services/api/errors.ts'), 'utf8')
  check('the anthropic wall row BAKES its remedies at creation (the OpenAI pattern)', errorsSrc.includes('composeAnthropicWallRemedies()'))
  const rateRow = readFileSync(join(ROOT, 'src/components/messages/RateLimitMessage.tsx'), 'utf8')
  check('the renderer no longer recomputes the slot remedy from live state (FN-016 R9)', !rateRow.includes('slotWallAppendix'))
  check('…nor the account or lane remedies (a settled row never rewrites)', !rateRow.includes('isClaudeAISubscriber') && !rateRow.includes('liveCapFailoverTarget'))
  const composer = readFileSync(join(ROOT, 'src/components/PromptInput/PromptInput.tsx'), 'utf8')
  check('the composer runs the slot rung through the ONE decision fn', composer.includes('decideSlotWallAction(posture, {'))
  check('the rung sits BEFORE the cross-family posture-off return', composer.includes('decideSlotWallAction') && composer.indexOf('decideSlotWallAction') < composer.indexOf("if (posture === 'off') return"))
  check('the offer mounts SlotOfferCard on its own overlay', composer.includes("overlay === 'slot-offer'") && composer.includes('<SlotOfferCard'))
  check('accept and auto BOTH ride the one switch owner', (composer.match(/switchActiveSlot\(offer\.family\)|switchActiveSlot\(family\)/g) ?? []).length >= 2)
  check('the auto arm fires once per wall key', composer.includes('offerAutoDone(slotKey)') && composer.includes('noteOfferAutoDone(slotKey)'))
  check('dismissal is remembered per wall key (never nags)', composer.includes('noteOfferDismissal(offer.key)'))
  const card = readFileSync(join(ROOT, 'src/components/SlotOfferCard.tsx'), 'utf8')
  check('the card states the no-sign-out law and the way back', card.includes('nothing signs out') && card.includes('switch back'))
}

section('§E the card never fights the keyboard, and the memories outlive the composer (FN-016 R7 + R8)')
{
  // R8 — the memories live in a SESSION-SCOPED store, not component refs:
  // the composer unmounts for every tool-permission prompt, so a useRef Set
  // died mid-wall and the dismissed card returned after every approved tool
  // call. The store is pure and provable without a mount.
  const { offerDismissed, noteOfferDismissal, offerAutoDone, noteOfferAutoDone, _resetOfferMemoriesForTesting } =
    await import('../../src/services/capFailover.ts')
  _resetOfferMemoriesForTesting()
  check('a fresh session holds no dismissals', !offerDismissed('slot|anthropic|subscription|123'))
  noteOfferDismissal('slot|anthropic|subscription|123')
  check('a dismissal is remembered by its wall key', offerDismissed('slot|anthropic|subscription|123'))
  check('…and only by ITS key (a new wall re-offers)', !offerDismissed('slot|anthropic|subscription|456'))
  check('the auto latch is a separate memory', !offerAutoDone('slot|anthropic|subscription|123'))
  noteOfferAutoDone('handoff|rejected|999')
  check('the auto latch holds per decision key', offerAutoDone('handoff|rejected|999'))
  _resetOfferMemoriesForTesting()
  check('the test reset clears both memories', !offerDismissed('slot|anthropic|subscription|123') && !offerAutoDone('handoff|rejected|999'))

  const composer = readFileSync(join(ROOT, 'src/components/PromptInput/PromptInput.tsx'), 'utf8')
  check('the composer consults the session-scoped memories (no component-ref sets remain)',
    composer.includes('offerDismissed(slotKey)') && !composer.includes('slotDismissedRef') && !composer.includes('capDismissedRef') && !composer.includes('slotAutoOnceRef') && !composer.includes('capAutoOnceRef'))
  // R7 — the offer card never mounts OVER a live turn: the effect defers
  // the mount to the turn boundary (deferral is not dismissal — no memory
  // is consumed, and the wall key is stable, so the boundary re-offer is
  // the same wall).
  check('the slot offer defers while a turn is in flight', composer.includes('if (turnInFlightNow) return'))
  const card = readFileSync(join(ROOT, 'src/components/SlotOfferCard.tsx'), 'utf8')
  // R7 — the card REGISTERS with the overlay stack, so useIsOverlayActive
  // stands the chat-cancel Escape down while the card owns the keyboard
  // (Escape dismisses the card; it no longer also interrupts the turn).
  check('the card registers its overlay', card.includes("useRegisterOverlay('slot-offer')"))
  // R7 — a confirm surface that appears WITHOUT a gesture arms Enter after
  // a short window, so a keystroke typed at the composer it replaced can
  // never flip the account slot.
  check('Enter arms after a short window (never a type-ahead flip)',
    card.includes('SLOT_OFFER_ENTER_ARM_MS') && card.includes('mountedAtRef'))
}

section('§G a dismissed slot offer leaves the ladder standing (FN-016 R19)')
{
  const composer = readFileSync(join(ROOT, 'src/components/PromptInput/PromptInput.tsx'), 'utf8')
  // The rung ends the ladder ONLY when it took the screen (the card
  // mounted) or performed a switch: the return rides INSIDE the mount
  // guard, and the dismissed/overlay-suppressed path falls THROUGH to the
  // cross-family decision. Before this, the bare return sat outside the
  // guard, so one Escape on the slot card silently suppressed the
  // cross-family failover offer for the rest of the window.
  check('the mount is followed by its own return (the rung took the screen)',
    /setOverlay\('slot-offer'\)\s*\n\s*\/\/ The rung TOOK the screen[\s\S]{0,80}?return/.test(composer))
  check('the dismissed path falls through to the next rung', composer.includes('the ladder keeps its next\n            // rung'))
  check('the auto arm is the offer arm\'s ELSE (a dismissed offer never auto-switches)',
    /\}\s*else if \(!offerAutoDone\(slotKey\)\)/.test(composer))
}

section('§F the offer card speaks only what the estate observed (FN-016 R18)')
{
  const card = readFileSync(join(ROOT, 'src/components/SlotOfferCard.tsx'), 'utf8')
  check('the card carries the observation fact (headroomObserved)', card.includes('headroomObserved'))
  check('…and speaks the unobserved window as such', card.includes('unobserved') && card.includes('signed in with headroom'))
  const composer = readFileSync(join(ROOT, 'src/components/PromptInput/PromptInput.tsx'), 'utf8')
  check('the composer hands the card the view\'s own wallKnown verdict', composer.includes('headroomObserved: view.other.wallKnown') && composer.includes('headroomObserved={offer.headroomObserved}'))
}

section('§H the switch receipt is durable (FN-016 R20)')
{
  // The transient is the receipt's first clause — the footer strip truncates
  // and expires; the whole sentence lives in the transcript row.
  const { slotSwitchTransient } = await import('../../src/services/providers/slotSwitch.ts')
  const receiptWords =
    'Anthropic active slot switched: Claude sign-in → Anthropic API key. The next turn rides it — session identity untouched; the sign-in stays connected.'
  check("the transient is the receipt's first clause", slotSwitchTransient(receiptWords) === 'Anthropic active slot switched: Claude sign-in → Anthropic API key.', slotSwitchTransient(receiptWords))
  const refusal = 'only the Claude sign-in is signed in — /logins anthropic adds the other slot, then the switch is one key'
  check('a one-clause refusal is its own transient', slotSwitchTransient(refusal) === refusal)

  // The owner paints ONE seat_receipt row through the focused chat's
  // display-row door — behavioural, against a stub connector on the real
  // focus slot; a chat without the door answers false so the caller keeps
  // the whole receipt in its own transient.
  const focus = await import('../../src/services/engine-connector/focusedConnector.ts')
  const { paintSlotSwitchReceipt } = await import('../../src/utils/model/slotSwitchReceipt.ts')
  type Row = { type: string; subtype?: string; content?: string; level?: string }
  const rows: Row[] = []
  focus.setFocusedSessionConnector({ addDisplayRow: (row: Row) => rows.push(row) } as never)
  const painted = paintSlotSwitchReceipt({ switched: true, family: 'anthropic', from: 'subscription', to: 'api-key', receipt: receiptWords })
  check('a switch paints one seat_receipt row with the WHOLE receipt', painted && rows.length === 1 && rows[0]?.type === 'system' && rows[0]?.subtype === 'seat_receipt' && rows[0]?.content === receiptWords, JSON.stringify(rows))
  check('…at info level', rows[0]?.level === 'info')
  paintSlotSwitchReceipt({ switched: false, family: 'anthropic', receipt: refusal })
  check('a refusal paints a WARNING row (the reason must stand)', rows.length === 2 && rows[1]?.level === 'warning' && rows[1]?.content === refusal)
  focus.setFocusedSessionConnector({} as never)
  check('a chat without the door answers false (the caller keeps the footer as the record)', paintSlotSwitchReceipt({ switched: false, family: 'openai', receipt: refusal }) === false)
  focus._resetFocusedSessionConnectorForTesting()

  // The three arms ride the one owner: the composer's auto and accept arms
  // (footer = the transient, the whole receipt only without a door) and the
  // picker's s-key arm (its notice dies with the picker).
  const composer = readFileSync(join(ROOT, 'src/components/PromptInput/PromptInput.tsx'), 'utf8')
  check('the auto arm receipts through the owner', /noteOfferAutoDone\(slotKey\)\s*\n\s*const outcome = switchActiveSlot\(family\)\s*\n[\s\S]{0,300}?const durable = paintSlotSwitchReceipt\(outcome\)/.test(composer))
  check('the accept arm receipts through the owner', /onAccept=\{\(\) => \{[\s\S]{0,600}?switchActiveSlot\(offer\.family\)[\s\S]{0,300}?const durable = paintSlotSwitchReceipt\(outcome\)/.test(composer))
  check('both footers carry the transient, the whole receipt only without a door', (composer.match(/text: durable \? slotSwitchTransient\(outcome\.receipt\) : outcome\.receipt/g) ?? []).length === 2)
  check('no arm speaks the whole receipt as a bare footer line', !/text: outcome\.receipt,/.test(composer))
  const wrapper = readFileSync(join(ROOT, 'src/commands/model/mercuryModel.tsx'), 'utf8')
  check("the picker's s-key arm receipts through the owner too", /const outcome = switchActiveSlot\(family\)\s*\n[\s\S]{0,300}?paintSlotSwitchReceipt\(outcome\)\s*\n\s*setSlotVersion/.test(wrapper))
  const renderer = readFileSync(join(ROOT, 'src/components/messages/SystemTextMessage.tsx'), 'utf8')
  check('the seat_receipt row renders above the verbose gate (a receipt is never quiet)', /case 'seat_receipt':\s*\n\s*return \(/.test(renderer))
}

console.log('\n' + '═'.repeat(60))
if (failures === 0) console.log('SLOT WALL RUNG: ALL GREEN')
else console.log(`❌ ${failures} SLOT-WALL LAW(S) BROKEN`)
console.log('═'.repeat(60))
process.exit(failures === 0 ? 0 : 1)
