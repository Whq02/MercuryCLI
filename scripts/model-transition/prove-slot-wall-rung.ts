#!/usr/bin/env bun
(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

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
  check('off: the appendix OFFERS — names the other slot, the one key, the /logins door', ask.includes('OpenAI API key (stored)') && ask.includes('signed in with headroom') && ask.includes('one key') && ask.includes("s on the family's row in /logins"))
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
  check('anthropic: the appendix names the managed key and the /logins door', anthropicAsk.includes('Anthropic API key (/logins managed key)') && anthropicAsk.includes("s on the family's row in /logins"))
  check('anthropic: an UNOBSERVABLE window is spoken as such — never "headroom"', anthropicAsk.includes('unobserved') && !anthropicAsk.includes('signed in with headroom'))
  const anthropicAuto = slotWallAppendix('anthropic', { reads: anthropicPair, posture: 'auto' })
  check('anthropic auto: the armed-switch receipt claims the switch, not headroom', anthropicAuto.includes("'auto' is armed") && !anthropicAuto.includes('headroom'))
}

section('§C2 the wall row remedies are composed ONCE, where the row is created (FN-016 R9)')
{
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


section('§E the card never fights the keyboard, and the memories outlive the composer (FN-016 R7 + R8)')
{
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

}


section('§H the switch receipt is durable (FN-016 R20)')
{
  const { slotSwitchTransient } = await import('../../src/services/providers/slotSwitch.ts')
  const receiptWords =
    'Anthropic active slot switched: Claude sign-in → Anthropic API key. The next turn rides it — session identity untouched; the sign-in stays connected.'
  check("the transient is the receipt's first clause", slotSwitchTransient(receiptWords) === 'Anthropic active slot switched: Claude sign-in → Anthropic API key.', slotSwitchTransient(receiptWords))
  const refusal = 'only the Claude sign-in is signed in — /logins anthropic adds the other slot, then the switch is one key'
  check('a one-clause refusal is its own transient', slotSwitchTransient(refusal) === refusal)

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

}

section('§H the wall key is stable: a reset-moment shift never re-arms; an observed clear does')
{
  const { slotWallKey, noteSlotWallObserved, offerDismissed, noteOfferDismissal, offerAutoDone, noteOfferAutoDone, _resetOfferMemoriesForTesting } =
    await import('../../src/services/capFailover.ts')
  _resetOfferMemoriesForTesting()
  const key = slotWallKey('anthropic', 'subscription')
  check('the wall key is the family and the walled seat — it carries no reset moment', key === 'slot|anthropic|subscription' && !/\d/.test(key))
  check('the same wall re-stated with a shifted reset is the SAME key', slotWallKey('anthropic', 'subscription') === key)
  noteOfferDismissal(key)
  noteOfferAutoDone(key)
  noteSlotWallObserved('anthropic', 'subscription', true)
  check('a reset-moment shift without a material change does not re-arm the answered offer', offerDismissed(key))
  check('…nor the auto latch', offerAutoDone(key))
  noteSlotWallObserved('anthropic', 'subscription', false)
  check('a real reset (the wall observed clear) re-arms the offer', !offerDismissed(key))
  check('…and the auto latch', !offerAutoDone(key))
  noteOfferDismissal(key)
  noteSlotWallObserved('anthropic', 'api-key', false)
  check("the other seat's clear leaves this seat's answered wall alone", offerDismissed(key))
  check('a seat flip keys a new wall', slotWallKey('anthropic', 'api-key') !== key)
  _resetOfferMemoriesForTesting()
}

console.log('\n' + '═'.repeat(60))
if (failures === 0) console.log('SLOT WALL RUNG: ALL GREEN')
else console.log(`❌ ${failures} SLOT-WALL LAW(S) BROKEN`)
console.log('═'.repeat(60))
process.exit(failures === 0 ? 0 : 1)
