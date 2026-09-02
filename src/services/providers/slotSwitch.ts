import type { OpenaiLimitWindow } from './openai/openaiLimitState.js'
import { familyDisplayName } from './accountSlots.js'

export type SwitchableFamily = 'anthropic' | 'openai'
export type SlotKind = 'subscription' | 'api-key'

export interface SlotSeatView {
  family: SwitchableFamily
  active?: SlotKind
  activeLabel?: string
  other?: {
    kind: SlotKind
    label: string
    walled: boolean
    wallKnown: boolean
    resetsAtMs?: number
  }
  envPinned?: string
}

export interface SlotSwitchReads {
  anthropicSubscriptionStored?: () => boolean
  anthropicManagedKeyPresent?: () => boolean
  anthropicSubscriberSeat?: () => boolean
  anthropicEnvCredential?: () => string | undefined
  anthropicSubscriptionLabel?: () => string
  anthropicWall?: () => { walled: boolean; resetsAtMs?: number }
  anthropicDepartedWall?: () => { kind: SlotKind; resetsAtMs: number } | null
  openaiSubscription?: () => { label: string } | undefined
  openaiKey?: () => { source: 'env' | 'stored' } | undefined
  openaiActiveKind?: () => ('chatgpt-subscription' | 'api-key') | undefined
  openaiWallOf?: (kind: 'chatgpt-subscription' | 'api-key') => OpenaiLimitWindow
}

let departedAnthropicWall: { kind: SlotKind; resetsAtMs: number } | null = null

function liveReads(): Required<SlotSwitchReads> {
  return {
    anthropicSubscriptionStored: () => {
      const { getClaudeAIOAuthTokens } = require('../../utils/auth.js') as typeof import('../../utils/auth.js')
      const { shouldUseClaudeAIAuth } = require('../oauth/client.js') as typeof import('../oauth/client.js')
      try {
        const tokens = getClaudeAIOAuthTokens()
        return tokens !== null && Boolean(tokens.accessToken) && shouldUseClaudeAIAuth(tokens.scopes)
      } catch {
        return false
      }
    },
    anthropicManagedKeyPresent: () => {
      const { getAnthropicApiKeyWithSource } = require('../../utils/auth.js') as typeof import('../../utils/auth.js')
      try {
        return getAnthropicApiKeyWithSource({ skipRetrievingKeyFromApiKeyHelper: true }).source === '/logins managed key'
      } catch {
        return false
      }
    },
    anthropicSubscriberSeat: () => {
      const { isClaudeAISubscriber } = require('../../utils/auth.js') as typeof import('../../utils/auth.js')
      return isClaudeAISubscriber()
    },
    anthropicEnvCredential: () => {
      const { getAnthropicApiKeyWithSource, getAuthTokenSource } = require('../../utils/auth.js') as typeof import('../../utils/auth.js')
      try {
        const source = getAuthTokenSource().source
        if (source === 'ANTHROPIC_AUTH_TOKEN' || source === 'MERCURY_OAUTH_TOKEN' || source === 'MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR') return source
        const key = getAnthropicApiKeyWithSource({ skipRetrievingKeyFromApiKeyHelper: true })
        if (key.source === 'ANTHROPIC_API_KEY') return 'ANTHROPIC_API_KEY'
        if (key.source === 'apiKeyHelper') return 'apiKeyHelper (settings)'
        return undefined
      } catch {
        return undefined
      }
    },
    anthropicSubscriptionLabel: () => {
      const { getSubscriptionType } = require('../../utils/auth.js') as typeof import('../../utils/auth.js')
      const plan = getSubscriptionType()
      return plan ? `Claude subscription (${plan})` : 'Claude subscription'
    },
    anthropicWall: () => {
      const { currentLimits } = require('../claudeAiLimits.js') as typeof import('../claudeAiLimits.js')
      return currentLimits.status === 'rejected'
        ? { walled: true, ...(currentLimits.resetsAt !== undefined ? { resetsAtMs: currentLimits.resetsAt * 1000 } : {}) }
        : { walled: false }
    },
    anthropicDepartedWall: () => {
      if (departedAnthropicWall !== null && departedAnthropicWall.resetsAtMs <= Date.now()) {
        departedAnthropicWall = null
      }
      return departedAnthropicWall
    },
    openaiSubscription: () => {
      const { openaiSubscriptionRef } = require('./openai/openaiAccounts.js') as typeof import('./openai/openaiAccounts.js')
      const ref = openaiSubscriptionRef()
      return ref ? { label: ref.label } : undefined
    },
    openaiKey: () => {
      const { resolveOpenaiApiKey } = require('./openai/openaiAccounts.js') as typeof import('./openai/openaiAccounts.js')
      const key = resolveOpenaiApiKey()
      return key ? { source: key.source } : undefined
    },
    openaiActiveKind: () => {
      const { resolveOpenaiAccount } = require('./openai/openaiAccounts.js') as typeof import('./openai/openaiAccounts.js')
      return resolveOpenaiAccount()?.kind
    },
    openaiWallOf: kind => {
      const { openaiLimitWindow } = require('./openai/openaiLimitState.js') as typeof import('./openai/openaiLimitState.js')
      return openaiLimitWindow(kind)
    },
  }
}

const asSlotKind = (kind: 'chatgpt-subscription' | 'api-key'): SlotKind =>
  kind === 'api-key' ? 'api-key' : 'subscription'

export function slotSeatView(family: SwitchableFamily, reads?: SlotSwitchReads): SlotSeatView {
  const r = { ...liveReads(), ...(reads ?? {}) }
  if (family === 'openai') {
    const subscription = r.openaiSubscription()
    const key = r.openaiKey()
    const activeKind = r.openaiActiveKind()
    const view: SlotSeatView = { family }
    if (activeKind !== undefined) {
      view.active = asSlotKind(activeKind)
      view.activeLabel =
        activeKind === 'chatgpt-subscription'
          ? (subscription?.label ?? 'ChatGPT subscription')
          : `OpenAI API key (${key?.source ?? 'stored'})`
      const otherKind = activeKind === 'chatgpt-subscription' ? 'api-key' : 'chatgpt-subscription'
      const otherPresent = otherKind === 'api-key' ? key !== undefined : subscription !== undefined
      if (otherPresent) {
        const wall = r.openaiWallOf(otherKind)
        view.other = {
          kind: asSlotKind(otherKind),
          label:
            otherKind === 'chatgpt-subscription'
              ? (subscription?.label ?? 'ChatGPT subscription')
              : `OpenAI API key (${key?.source ?? 'stored'})`,
          walled: wall.state === 'limited',
          wallKnown: true,
          ...(wall.state === 'limited' ? { resetsAtMs: wall.resetsAtMs } : {}),
        }
      }
    }
    return view
  }
  const view: SlotSeatView = { family }
  const envPin = r.anthropicEnvCredential()
  if (envPin !== undefined) {
    view.envPinned = envPin
    return view
  }
  const subscriptionStored = r.anthropicSubscriptionStored()
  const keyPresent = r.anthropicManagedKeyPresent()
  const subscriberSeat = r.anthropicSubscriberSeat()
  if (!subscriptionStored && !keyPresent) return view
  if (subscriberSeat && subscriptionStored) {
    view.active = 'subscription'
    view.activeLabel = r.anthropicSubscriptionLabel()
    if (keyPresent) {
      view.other = {
        kind: 'api-key',
        label: 'Anthropic API key (/logins managed key)',
        walled: false,
        wallKnown: false,
      }
    }
    return view
  }
  if (keyPresent) {
    view.active = 'api-key'
    view.activeLabel = 'Anthropic API key (/logins managed key)'
    if (subscriptionStored) {
      const wall = r.anthropicWall()
      if (wall.walled) {
        view.other = {
          kind: 'subscription',
          label: r.anthropicSubscriptionLabel(),
          walled: true,
          wallKnown: true,
          ...(wall.resetsAtMs !== undefined ? { resetsAtMs: wall.resetsAtMs } : {}),
        }
        return view
      }
      const departed = r.anthropicDepartedWall()
      if (departed !== null && departed.kind === 'subscription' && departed.resetsAtMs > Date.now()) {
        view.other = {
          kind: 'subscription',
          label: r.anthropicSubscriptionLabel(),
          walled: true,
          wallKnown: true,
          resetsAtMs: departed.resetsAtMs,
        }
        return view
      }
      view.other = {
        kind: 'subscription',
        label: r.anthropicSubscriptionLabel(),
        walled: false,
        wallKnown: false,
      }
    }
    return view
  }
  view.active = 'subscription'
  view.activeLabel = r.anthropicSubscriptionLabel()
  return view
}

export interface SlotSwitchWrites {
  writeOpenaiPreference?: (kind: 'chatgpt-subscription' | 'api-key') => void
  writeAnthropicPreference?: (kind: 'api-key' | null) => void
  resetAnthropicLimits?: () => void
  clearAuthHeaderCaches?: () => void
  noteAnthropicDepartedWall?: (wall: { kind: SlotKind; resetsAtMs: number } | null) => void
}

function liveWrites(): Required<SlotSwitchWrites> {
  return {
    writeOpenaiPreference: kind => {
      const { writePreferredOpenaiSource } = require('./openai/openaiAccounts.js') as typeof import('./openai/openaiAccounts.js')
      writePreferredOpenaiSource(kind)
    },
    writeAnthropicPreference: kind => {
      const { writeAnthropicPreferredSource } = require('../../utils/auth.js') as typeof import('../../utils/auth.js')
      writeAnthropicPreferredSource(kind)
    },
    resetAnthropicLimits: () => {
      const { resetLimitsForCredentialSwitch } = require('../claudeAiLimits.js') as typeof import('../claudeAiLimits.js')
      resetLimitsForCredentialSwitch()
    },
    clearAuthHeaderCaches: () => {
      const { clearBetasCaches } = require('../../utils/model/capabilities.js') as typeof import('../../utils/model/capabilities.js')
      const { clearToolSchemaCache } = require('../../utils/toolSchemaCache.js') as typeof import('../../utils/toolSchemaCache.js')
      clearBetasCaches()
      clearToolSchemaCache()
    },
    noteAnthropicDepartedWall: wall => {
      departedAnthropicWall = wall
    },
  }
}

export function slotWallAppendix(
  family: SwitchableFamily,
  opts?: { reads?: SlotSwitchReads; posture?: 'off' | 'offer' | 'auto' },
): string {
  const view = slotSeatView(family, opts?.reads)
  if (view.other === undefined) return ''
  const posture =
    opts?.posture ??
    ((): 'off' | 'offer' | 'auto' => {
      const { resolveCapPosture } = require('../capFailover.js') as typeof import('../capFailover.js')
      return resolveCapPosture()
    })()
  if (view.other.walled) {
    return ` The other ${familyDisplayName(family)} slot (${view.other.label}) has its OWN window reached${
      view.other.resetsAtMs !== undefined ? ` (resets ${new Date(view.other.resetsAtMs).toLocaleTimeString()})` : ''
    } — no headroom to offer.`
  }
  const wordsDoor = family === 'anthropic' ? '/router source anthropic' : '/router source'
  if (posture === 'auto') {
    return ` Cap failover posture 'auto' is armed: the active slot switches to the ${view.other.label} now — the next turn rides it (${wordsDoor} switches back).`
  }
  if (!view.other.wallKnown) {
    return ` The ${view.other.label} slot is signed in — its own window is unobserved from this seat; the wall card offers the switch in one key (${wordsDoor} in words; the sign-in stays connected either way).`
  }
  return ` The ${view.other.label} slot is signed in with headroom — the wall card offers the switch in one key (${wordsDoor} in words; the sign-in stays connected either way).`
}

export type SlotSwitchOutcome =
  | { switched: true; family: SwitchableFamily; from: SlotKind; to: SlotKind; receipt: string }
  | { switched: false; family: SwitchableFamily; receipt: string }

export function switchActiveSlot(
  family: SwitchableFamily,
  opts?: { to?: SlotKind; reads?: SlotSwitchReads; writes?: SlotSwitchWrites },
): SlotSwitchOutcome {
  const view = slotSeatView(family, opts?.reads)
  const writes = { ...liveWrites(), ...(opts?.writes ?? {}) }
  const r = { ...liveReads(), ...(opts?.reads ?? {}) }
  if (view.envPinned !== undefined) {
    return {
      switched: false,
      family,
      receipt: `${view.envPinned} owns the ${family} credential — the shell's pin wins; unset it to switch slots here`,
    }
  }
  if (view.active === undefined) {
    return {
      switched: false,
      family,
      receipt: `no ${family} slot is signed in — /logins ${family === 'anthropic' ? 'anthropic' : 'openai'} signs one in`,
    }
  }
  if (view.other === undefined) {
    return {
      switched: false,
      family,
      receipt: `only the ${view.activeLabel ?? view.active} is signed in — /logins ${family === 'anthropic' ? 'anthropic' : 'openai'} adds the other slot, then the switch is one key`,
    }
  }
  const target = opts?.to ?? view.other.kind
  if (target === view.active) {
    return {
      switched: false,
      family,
      receipt: `${view.activeLabel ?? view.active} is already the active ${family} slot — nothing to change`,
    }
  }
  if (family === 'openai') {
    writes.writeOpenaiPreference(target === 'api-key' ? 'api-key' : 'chatgpt-subscription')
  } else {
    if (target === 'api-key' && view.active === 'subscription') {
      const activeWall = r.anthropicWall()
      if (activeWall.walled && activeWall.resetsAtMs !== undefined) {
        writes.noteAnthropicDepartedWall({ kind: 'subscription', resetsAtMs: activeWall.resetsAtMs })
      }
    } else if (target === 'subscription') {
      writes.noteAnthropicDepartedWall(null)
    }
    writes.writeAnthropicPreference(target === 'api-key' ? 'api-key' : null)
    writes.resetAnthropicLimits()
    writes.clearAuthHeaderCaches()
  }
  const wallNote = view.other.walled
    ? ` Note: the estate has OBSERVED that slot's own window reached${view.other.resetsAtMs !== undefined ? ` (resets ${new Date(view.other.resetsAtMs).toLocaleTimeString()})` : ''}.`
    : ''
  return {
    switched: true,
    family,
    from: view.active,
    to: target,
    receipt:
      `${familyDisplayName(family)} active slot switched: ${view.activeLabel ?? view.active} → ${view.other.label}. ` +
      `The next turn rides it — session identity untouched; the ${view.active === 'subscription' ? 'sign-in stays connected' : 'key stays stored'}.` +
      wallNote,
  }
}

export function slotSwitchTransient(receipt: string): string {
  const end = receipt.indexOf('. ')
  return end === -1 ? receipt : receipt.slice(0, end + 1)
}
