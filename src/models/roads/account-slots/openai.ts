import type { AccountSlotReads, AccountSlot } from './shapes.js'
import { openaiSubscriptionRef, resolveOpenaiApiKey, resolveOpenaiAccount, openaiSubscriptionPresence } from '../openai/openaiAccounts.js'
import { label } from './keyLane.js'
import { maskedKeyTail } from '../../sign-in/account-ledger/credentialIdentity.js'

export function openaiSlots(reads: AccountSlotReads): AccountSlot[] {
  const subscription = (reads.openaiSubscription ?? openaiSubscriptionRef)()
  const key = (reads.openaiApiKey ?? resolveOpenaiApiKey)()
  const active = (reads.openaiActiveAccount ?? resolveOpenaiAccount)()
  const slots: AccountSlot[] = []
  if (subscription === undefined) {
    const presence = (reads.openaiSubscriptionPresence ?? openaiSubscriptionPresence)()
    if (presence.state === 'expired') {
      slots.push({
        family: 'openai',
        id: 'openai:subscription',
        name: 'chatgpt',
        kind: 'subscription',
        kindLabel: presence.planType ? `${presence.planType} subscription` : 'subscription',
        identity: presence.email ?? 'ChatGPT sign-in',
        active: false,
        envPinned: false,
        signedIn: false,
        stateNote: 'sign-in expired — /logins openai signs in again',
        removal: { route: 'openai-subscription' },
      })
    }
  }
  if (subscription) {
    slots.push({
      family: 'openai',
      id: 'openai:subscription',
      name: 'chatgpt',
      kind: 'subscription',
      kindLabel: subscription.planType
        ? `${subscription.planType} subscription`
        : 'subscription',
      identity: subscription.email ?? subscription.label,
      active: active?.kind === 'chatgpt-subscription',
      envPinned: false,
      signedIn: true,
      credits: (require('../providerUsage.js') as typeof import('../providerUsage.js')).openaiSubscriptionCredits(),
      removal: { route: 'openai-subscription' },
    })
  }
  if (key) {
    const env = key.source === 'env'
    slots.push({
      family: 'openai',
      id: 'openai:api-key',
      name: 'api-key',
      kind: 'api-key',
      kindLabel: env ? 'API key · env' : 'API key',
      identity: label([
        env ? 'OPENAI_API_KEY (env)' : 'stored key (auth-scoped)',
        maskedKeyTail(key.key),
      ]),
      active: active?.kind === 'api-key',
      envPinned: env,
      signedIn: true,
      removal: env
        ? { route: 'env', envVar: 'OPENAI_API_KEY' }
        : { route: 'openai-stored-key' },
    })
  }
  return slots
}
