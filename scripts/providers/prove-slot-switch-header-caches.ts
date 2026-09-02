#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const { switchActiveSlot } = await import(join(SRC, 'services/providers/slotSwitch.ts'))

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
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

console.log('L3 the live wiring names both cache owners in both doors')
{
  const slotSwitch = readFileSync(join(SRC, 'services/providers/slotSwitch.ts'), 'utf8')
  t('slotSwitch liveWrites clears the beta and tool-schema caches', slotSwitch.includes('clearBetasCaches()') && slotSwitch.includes('clearToolSchemaCache()'))
  t('the switch tail rides the seam', slotSwitch.includes('writes.clearAuthHeaderCaches()'))
  const router = readFileSync(join(SRC, 'commands/router/router.tsx'), 'utf8')
  const resetAt = router.indexOf('resetLimitsForCredentialSwitch()')
  const betasAt = router.indexOf('clearBetasCaches()')
  const schemaAt = router.indexOf('clearToolSchemaCache()')
  t('the /router words-door clears both too, after its limits reset', resetAt >= 0 && betasAt > resetAt && schemaAt > resetAt, `reset=${resetAt} betas=${betasAt} schema=${schemaAt}`)
}

console.log(failures === 0 ? 'SLOT SWITCH HEADER CACHES: ALL PASS' : 'SLOT SWITCH HEADER CACHES: RED')
process.exit(failures)
