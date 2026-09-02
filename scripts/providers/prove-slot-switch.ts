#!/usr/bin/env bun
// ============================================================================
//  scripts/providers/prove-slot-switch.ts — the ACTIVE-slot switch owner:
//  one gesture flips the family's seat between
//  its two signed-in slot kinds, receipted in words, next turn rides it,
//  session identity untouched. The owner routes to the EXISTING preference
//  doors (openaiAccounts.writePreferredOpenaiSource · utils/auth
//  writeAnthropicPreferredSource) — never a third resolution path.
//
//    §A openai: pair ⇒ flip with the receipt naming both slots and the
//       mid-session law; single slot / already-there ⇒ typed refusals
//    §B anthropic: flip writes the preference AND resets the usage latch
//       (the account behind the lane changed); env pin ⇒ typed refusal
//    §C the other slot's OWN wall rides the view (per-source pools) and
//       the switch receipt discloses an observed wall — never silent
//    §D mid-session: the dispatch lanes resolve the seat at turn start
//       (structural), so the NEXT turn rides a flip (behavioral: the
//       preference write moves the resolver immediately)
//    §E the surfaces ride the one owner (structural): the Logins screen's
//       `s` + legend/detail predicate, the /model account surface's `s`,
//       /router source's anthropic arm
//
//  Run: ~/.bun/bin/bun run scripts/providers/prove-slot-switch.ts
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'slot-switch-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
delete process.env.MERCURY_HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.OPENAI_API_KEY
delete process.env.CI
delete process.env.NODE_ENV

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
const { slotSeatView, switchActiveSlot } = await import('../../src/services/providers/slotSwitch.ts')
type Reads = import('../../src/services/providers/slotSwitch.ts').SlotSwitchReads

section('§A openai — the pair flips; refusals are typed')
{
  const pair: Reads = {
    openaiSubscription: () => ({ label: 'ChatGPT plus subscription' }),
    openaiKey: () => ({ source: 'stored' }),
    openaiActiveKind: () => 'chatgpt-subscription',
    openaiWallOf: () => ({ state: 'clear' }),
  }
  const writes: string[] = []
  const outcome = switchActiveSlot('openai', {
    reads: pair,
    writes: { writeOpenaiPreference: kind => writes.push(kind) },
  })
  check('the pair flips subscription → key', outcome.switched === true && outcome.switched && outcome.to === 'api-key')
  check('the flip rides the EXISTING preference door', writes.length === 1 && writes[0] === 'api-key')
  check('the receipt names both slots', outcome.receipt.includes('ChatGPT plus subscription') && outcome.receipt.includes('OpenAI API key (stored)'))
  check('the receipt states the mid-session law (next turn · identity untouched)', outcome.receipt.includes('next turn') && outcome.receipt.includes('session identity untouched'))
  check('the receipt says the sign-in survives the flip', outcome.receipt.includes('sign-in stays connected'))

  const single: Reads = { ...pair, openaiKey: () => undefined }
  const refused = switchActiveSlot('openai', { reads: single, writes: { writeOpenaiPreference: () => { throw new Error('must not write') } } })
  check('a single slot refuses TYPED and names the add road', refused.switched === false && refused.receipt.includes('/logins openai'))

  const alreadyOutcome = switchActiveSlot('openai', { reads: pair, to: 'subscription', writes: { writeOpenaiPreference: () => { throw new Error('must not write') } } })
  check('already-on-target refuses typed, writes nothing', alreadyOutcome.switched === false && alreadyOutcome.receipt.includes('already the active'))

  const nothing = switchActiveSlot('openai', { reads: { ...pair, openaiSubscription: () => undefined, openaiKey: () => undefined, openaiActiveKind: () => undefined } })
  check('nothing signed in refuses typed with the sign-in road', nothing.switched === false && nothing.receipt.includes('/logins'))
}

section('§B anthropic — the flip writes the preference and resets the latch')
{
  const pair: Reads = {
    anthropicSubscriptionStored: () => true,
    anthropicManagedKeyPresent: () => true,
    anthropicSubscriberSeat: () => true,
    anthropicEnvCredential: () => undefined,
    anthropicSubscriptionLabel: () => 'Claude subscription (max)',
    anthropicWall: () => ({ walled: false }),
  }
  const writes: Array<string | null> = []
  let resets = 0
  const outcome = switchActiveSlot('anthropic', {
    reads: pair,
    writes: {
      writeAnthropicPreference: kind => writes.push(kind),
      resetAnthropicLimits: () => {
        resets++
      },
    },
  })
  check('subscription → managed key flips', outcome.switched === true && outcome.switched && outcome.to === 'api-key')
  check("the flip writes 'api-key' at the auth door", writes.length === 1 && writes[0] === 'api-key')
  check('the usage latch RESETS with the seat (the account changed)', resets === 1)
  const back = switchActiveSlot('anthropic', {
    reads: { ...pair, anthropicSubscriberSeat: () => false },
    writes: {
      writeAnthropicPreference: kind => writes.push(kind),
      resetAnthropicLimits: () => {
        resets++
      },
    },
  })
  check('key → subscription CLEARS the preference (default precedence is the seat)', back.switched === true && writes.length === 2 && writes[1] === null && resets === 2)

  const pinned = switchActiveSlot('anthropic', {
    reads: { ...pair, anthropicEnvCredential: () => 'ANTHROPIC_API_KEY' },
    writes: { writeAnthropicPreference: () => { throw new Error('must not write') } },
  })
  check("an env pin refuses typed (the shell's word wins)", pinned.switched === false && pinned.receipt.includes('ANTHROPIC_API_KEY') && pinned.receipt.includes('shell'))

  const single = switchActiveSlot('anthropic', {
    reads: { ...pair, anthropicManagedKeyPresent: () => false },
    writes: { writeAnthropicPreference: () => { throw new Error('must not write') } },
  })
  check('sign-in only refuses typed and names the add road', single.switched === false && single.receipt.includes('/logins anthropic'))
}

section("§C the other slot's OWN wall rides the view and the receipt")
{
  const reads: Reads = {
    anthropicSubscriptionStored: () => true,
    anthropicManagedKeyPresent: () => true,
    anthropicSubscriberSeat: () => false,
    anthropicEnvCredential: () => undefined,
    anthropicSubscriptionLabel: () => 'Claude subscription (max)',
    anthropicWall: () => ({ walled: true, resetsAtMs: Date.now() + 3_600_000 }),
  }
  const view = slotSeatView('anthropic', reads)
  check('key-seated view names the subscription as the other slot, walled', view.active === 'api-key' && view.other?.kind === 'subscription' && view.other.walled === true && view.other.resetsAtMs !== undefined)
  const outcome = switchActiveSlot('anthropic', {
    reads,
    writes: { writeAnthropicPreference: () => {}, resetAnthropicLimits: () => {} },
  })
  check('switching ONTO an observed wall still switches but DISCLOSES it', outcome.switched === true && outcome.receipt.includes('OBSERVED') && outcome.receipt.includes('window reached'))

  const openaiReads: Reads = {
    openaiSubscription: () => ({ label: 'ChatGPT plus subscription' }),
    openaiKey: () => ({ source: 'stored' }),
    openaiActiveKind: () => 'api-key',
    openaiWallOf: kind => (kind === 'chatgpt-subscription' ? { state: 'limited', resetsAtMs: Date.now() + 60_000, observedAtMs: Date.now() } : { state: 'clear' }),
  }
  const openaiView = slotSeatView('openai', openaiReads)
  check("openai: the other slot's wall comes from ITS per-source pool", openaiView.other?.kind === 'subscription' && openaiView.other.walled === true)
}

section("§C2 an unobservable wall is UNKNOWN, never invented headroom (FN-016 R18)")
{
  // The claim must be observable or unspoken. With the subscription seated,
  // the managed key's own Anthropic window has NO observation road at all
  // (the limits latch is subscriber-gated), so the view says wallKnown
  // false — the words then say 'unobserved', never 'headroom'.
  const subscriptionActive: Reads = {
    anthropicSubscriptionStored: () => true,
    anthropicManagedKeyPresent: () => true,
    anthropicSubscriberSeat: () => true,
    anthropicEnvCredential: () => undefined,
    anthropicSubscriptionLabel: () => 'Claude subscription (max)',
    anthropicWall: () => ({ walled: false }),
    anthropicDepartedWall: () => null,
  }
  const keyOther = slotSeatView('anthropic', subscriptionActive)
  check("the managed key's window is UNKNOWN from the subscription seat", keyOther.other?.walled === false && keyOther.other?.wallKnown === false)

  // With the key seated, a LIVE latch observation is known…
  const keyActive: Reads = {
    ...subscriptionActive,
    anthropicSubscriberSeat: () => false,
    anthropicWall: () => ({ walled: true, resetsAtMs: Date.now() + 3_600_000 }),
  }
  const observed = slotSeatView('anthropic', keyActive)
  check('a live latch observation is KNOWN', observed.other?.walled === true && observed.other?.wallKnown === true)

  // …and so is the DEPARTED slot's recorded wall: the flip away from a
  // walled subscription resets the latch (the new seat must not inherit
  // it), which used to ERASE the only record of that wall — the next offer
  // then promised headroom on the very slot whose exhaustion caused the
  // flip, and the accepted switch walled immediately.
  const departedRecorded: Reads = {
    ...keyActive,
    anthropicWall: () => ({ walled: false }),
    anthropicDepartedWall: () => ({ kind: 'subscription', resetsAtMs: Date.now() + 3_600_000 }),
  }
  const remembered = slotSeatView('anthropic', departedRecorded)
  check("the departed slot's recorded wall is KNOWN across the flip", remembered.other?.walled === true && remembered.other?.wallKnown === true && remembered.other?.resetsAtMs !== undefined)
  const expired: Reads = {
    ...departedRecorded,
    anthropicDepartedWall: () => ({ kind: 'subscription', resetsAtMs: Date.now() - 1_000 }),
  }
  const lapsed = slotSeatView('anthropic', expired)
  check('an EXPIRED departed record claims nothing (back to unknown)', lapsed.other?.walled === false && lapsed.other?.wallKnown === false)

  // The flip itself RECORDS the departed wall before resetting the latch.
  const noted: Array<{ kind: string; resetsAtMs: number } | null> = []
  const walledNow = Date.now() + 3_600_000
  switchActiveSlot('anthropic', {
    reads: { ...subscriptionActive, anthropicWall: () => ({ walled: true, resetsAtMs: walledNow }) },
    writes: {
      writeAnthropicPreference: () => {},
      resetAnthropicLimits: () => {},
      noteAnthropicDepartedWall: wall => noted.push(wall),
    },
  })
  check('leaving a walled subscription RECORDS its wall', noted.length === 1 && noted[0]?.kind === 'subscription' && noted[0]?.resetsAtMs === walledNow)
  switchActiveSlot('anthropic', {
    reads: { ...subscriptionActive, anthropicSubscriberSeat: () => false, anthropicWall: () => ({ walled: false }) },
    writes: {
      writeAnthropicPreference: () => {},
      resetAnthropicLimits: () => {},
      noteAnthropicDepartedWall: wall => noted.push(wall),
    },
  })
  check('coming home CLEARS the record (the seat re-observes live)', noted.length === 2 && noted[1] === null)

  // openai keeps its own law: the per-source pools ARE that family's
  // observation surface, so its verdicts stay known either way.
  const openaiKnown = slotSeatView('openai', {
    openaiSubscription: () => ({ label: 'ChatGPT plus subscription' }),
    openaiKey: () => ({ source: 'stored' }),
    openaiActiveKind: () => 'chatgpt-subscription',
    openaiWallOf: () => ({ state: 'clear' }),
  })
  check("openai stays KNOWN (its pools are the family's own observation design)", openaiKnown.other?.wallKnown === true)
}

section('§D mid-session — the seat is read at turn start; a flip moves the resolver now')
{
  const call = readFileSync(join(ROOT, 'src/services/providers/openai/openaiCallModel.ts'), 'utf8')
  check('openaiCallModel resolves the account at turn entry (turn-start capture)', call.includes('const account = resolveOpenaiAccount()'))
  const client = readFileSync(join(ROOT, 'src/services/api/client.ts'), 'utf8')
  check('getAnthropicClient consults the subscriber seat per request', client.includes('const subscriber = isClaudeAISubscriber()'))
  // Behavioral: the preference write moves the resolver immediately (the
  // hermetic home's auth file), so the NEXT turn-start capture rides it.
  const { writePreferredOpenaiSource, resolveOpenaiAccount } = await import(
    '../../src/services/providers/openai/openaiAccounts.ts'
  )
  process.env.OPENAI_API_KEY = 'sk-proof-openai-key-000000'
  writePreferredOpenaiSource('api-key')
  check('a written preference is the very next resolution (no restart, no cache)', resolveOpenaiAccount()?.kind === 'api-key')
  writePreferredOpenaiSource(null)
  delete process.env.OPENAI_API_KEY
}

section('§E the surfaces ride the ONE owner (structural)')
{
  const logins = readFileSync(join(ROOT, 'src/components/BootLoginsScreen.tsx'), 'utf8')
  check("the Logins screen's `s` runs switchActiveSlot exactly where the pair is", logins.includes("key: 's'") && logins.includes('loginsSwitchableFamily(a, facts) !== null') && logins.includes('switchActiveSlot(family)'))
  check('the legend advertises the move under the same predicate', logins.includes('s switch slot') && logins.includes('loginsSwitchableFamily(selected, facts) !== null'))
  const picker = readFileSync(join(ROOT, 'src/components/MercuryModelPicker.tsx'), 'utf8')
  check("the /model picker's `s` rides the wrapper's onSlotSwitch", picker.includes("input === 's'") && picker.includes('onSlotSwitch(focusedModel.group)'))
  const wrapper = readFileSync(join(ROOT, 'src/commands/model/mercuryModel.tsx'), 'utf8')
  check('the /model wrapper wires the owner + the seat words on the account surface', wrapper.includes('switchActiveSlot(family)') && wrapper.includes('active slot:') && wrapper.includes('s switches to'))
  const router = readFileSync(join(ROOT, 'src/commands/router/router.tsx'), 'utf8')
  check('/router source grew the anthropic arm on the same doors', router.includes("rest[0] === 'anthropic'") && router.includes('writeAnthropicPreferredSource') && router.includes('resetLimitsForCredentialSwitch()'))
}

console.log('\n' + '═'.repeat(60))
if (failures === 0) console.log('SLOT SWITCH: ALL GREEN')
else console.log(`❌ ${failures} SLOT-SWITCH LAW(S) BROKEN`)
console.log('═'.repeat(60))
process.exit(failures === 0 ? 0 : 1)
