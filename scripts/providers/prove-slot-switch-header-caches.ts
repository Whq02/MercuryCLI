#!/usr/bin/env bun
import { join } from 'node:path'

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const { switchActiveSlot } = await import(join(SRC, 'models/roads/slotSwitch.ts'))

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) {
    failures = 1
    console.log('      fix: switchActiveSlot in src/models/roads/slotSwitch.ts must call writes.writeAnthropicPreference and then writes.clearAuthHeaderCaches once on a landed switch, and call neither on a refused arm')
  }
}

const anthropicPair = {
  anthropicSubscriptionStored: () => true,
  anthropicManagedKeyPresent: () => true,
  anthropicSubscriberSeat: () => true,
  anthropicEnvCredential: () => undefined,
  anthropicSubscriptionLabel: () => 'Claude subscription',
  anthropicWall: () => ({ walled: false }),
}

console.log('L1 a landed switch clears the header caches after the preference write')
{
  const calls: string[] = []
  const outcome = switchActiveSlot('anthropic', {
    to: 'api-key',
    reads: anthropicPair,
    writes: {
      writeAnthropicPreference: () => calls.push('preference'),
      resetAnthropicLimits: () => calls.push('limits'),
      clearAuthHeaderCaches: () => calls.push('caches'),
    },
  } as never) as { switched: boolean }
  t('the switch lands', outcome.switched === true, JSON.stringify(outcome))
  t('the header caches are cleared exactly once', calls.filter(c => c === 'caches').length === 1, JSON.stringify(calls))
  t('…after the preference write (the new seat is on disk first)', calls.indexOf('preference') >= 0 && calls.indexOf('caches') > calls.indexOf('preference'), JSON.stringify(calls))
}

console.log('L2 refused arms clear nothing')
{
  const calls: string[] = []
  const spyWrites = {
    writeAnthropicPreference: () => calls.push('preference'),
    resetAnthropicLimits: () => calls.push('limits'),
    clearAuthHeaderCaches: () => calls.push('caches'),
  }
  const pinned = switchActiveSlot('anthropic', {
    reads: { ...anthropicPair, anthropicEnvCredential: () => 'ANTHROPIC_API_KEY' },
    writes: spyWrites,
  } as never) as { switched: boolean }
  const already = switchActiveSlot('anthropic', {
    to: 'subscription',
    reads: anthropicPair,
    writes: spyWrites,
  } as never) as { switched: boolean }
  t('the env-pinned and already-active arms refuse', pinned.switched === false && already.switched === false)
  t('…and no cache was cleared on either', calls.length === 0, JSON.stringify(calls))
}


console.log(failures === 0 ? 'SLOT SWITCH HEADER CACHES: ALL PASS' : 'SLOT SWITCH HEADER CACHES: RED')
process.exit(failures)
