// ============================================================================
//  providers/slotSwitch — the ACTIVE-slot switch owner (account handling
//  must never cost the operator a session).
//
//  The two-slot families (anthropic · openai) each hold at most two
//  Mercury-held credentials of different KINDS — a subscription sign-in and
//  an API key. This module is the ONE owner of the seat flip between them:
//  every surface gesture (the Logins screen's `s`, the /model account
//  surface's `s`, /router source, the quota-wall offer/auto failover) calls
//  switchActiveSlot and paints the receipt it returns. The flip itself is
//  ROUTED to each family's existing preference door — openaiAccounts'
//  writePreferredOpenaiSource and utils/auth's writeAnthropicPreferredSource
//  — never a third resolution path; the NEXT turn rides the new seat
//  because both dispatch lanes resolve their credential at turn start
//  (openaiCallModel's resolveOpenaiAccount · getAnthropicClient's
//  subscriber pick), with session identity untouched.
//
//  The retired account-RING switching (the tombstone in
//  prove-account-slots §4) stays dead: this is the slot-KIND seat within
//  one login per kind — no scope re-pointing, no staged switch, no relay.
//
//  Pure over injectable reads/writes so the prover drives every arm; the
//  live defaults read the owning stores.
// ============================================================================
import type { OpenaiLimitWindow } from './openai/openaiLimitState.js'
import { familyDisplayName } from './accountSlots.js'

export type SwitchableFamily = 'anthropic' | 'openai'
export type SlotKind = 'subscription' | 'api-key'

/** One family's seat view: which slot the wire bills NOW, and the other
 *  slot's presence/wall facts when a switchable pair exists. Never carries
 *  a secret — labels only. */
export interface SlotSeatView {
  family: SwitchableFamily
  /** The seat — the slot a dispatch on this family bills right now;
   *  undefined when nothing is signed in. */
  active?: SlotKind
  /** The seat's display label (plan/source words). */
  activeLabel?: string
  /** The OTHER slot, present exactly when it is signed in (the pair
   *  exists and the switch gesture is real). */
  other?: {
    kind: SlotKind
    label: string
    /** The other slot's own OBSERVED wall (per-source pools) — an offer
     *  must not advertise headroom the estate knows is spent. */
    walled: boolean
    /** Whether `walled` is a real observation (FN-016 R18: the claim must
     *  be observable or unspoken). openai's per-source pools ARE that
     *  family's observation surface, so its verdicts are always known;
     *  anthropic's limits latch is subscriber-gated and not slot-
     *  attributed, so the managed key's window is NEVER observable and the
     *  subscription's is known only from the live latch or the recorded
     *  departed wall — everything else is walled:false with wallKnown
     *  false, and the words say 'unobserved', never 'headroom'. */
    wallKnown: boolean
    resetsAtMs?: number
  }
  /** An env pin owns the family's resolution (the shell's word wins) — the
   *  switch is refused with this honest reason. */
  envPinned?: string
}

export interface SlotSwitchReads {
  // anthropic
  anthropicSubscriptionStored?: () => boolean
  anthropicManagedKeyPresent?: () => boolean
  anthropicSubscriberSeat?: () => boolean
  anthropicEnvCredential?: () => string | undefined
  anthropicSubscriptionLabel?: () => string
  anthropicWall?: () => { walled: boolean; resetsAtMs?: number }
  /** The DEPARTED slot's recorded wall (see the module record below): the
   *  flip away from a walled seat resets the limits latch, which would
   *  otherwise erase the only observation of that slot's window. */
  anthropicDepartedWall?: () => { kind: SlotKind; resetsAtMs: number } | null
  // openai
  openaiSubscription?: () => { label: string } | undefined
  openaiKey?: () => { source: 'env' | 'stored' } | undefined
  openaiActiveKind?: () => ('chatgpt-subscription' | 'api-key') | undefined
  openaiWallOf?: (kind: 'chatgpt-subscription' | 'api-key') => OpenaiLimitWindow
}

// ── the departed-wall record (session-scoped, never persisted) ──────────────
//  switchActiveSlot's anthropic arm RESETS the limits latch on a flip (the
//  new seat must not inherit the departed seat's wall), but that reset used
//  to erase the estate's only observation of the departed slot's window —
//  the very next wall row and offer card then promised headroom on the slot
//  whose exhaustion caused the flip, and the accepted switch walled
//  immediately (FN-016 R18). The record holds exactly what was observed at
//  the flip: the departed slot kind and its stated reset; it expires at
//  that reset and clears when the seat flips back (the live latch
//  re-observes from there). Only a wall WITH a stated reset is recorded —
//  an unexpirable claim would be its own dishonesty.
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
      // Self-healing read: an expired record claims nothing and clears.
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

/** The family's seat view — the facts every switch surface paints from. */
export function slotSeatView(family: SwitchableFamily, reads?: SlotSwitchReads): SlotSeatView {
  const r = { ...liveReads(), ...(reads ?? {}) }
  if (family === 'openai') {
    const subscription = r.openaiSubscription()
    const key = r.openaiKey()
    const activeKind = r.openaiActiveKind()
    // An env OPENAI_API_KEY wins the key SOURCE by the resolver's own
    // precedence, but the seat between subscription and key stays the
    // stored preference's — the switch is real either way, so no env
    // refusal arm exists on this family.
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
          // The per-source pools are this family's own observation surface
          // (openaiLimitState): 'clear' is its honest verdict, not absence.
          wallKnown: true,
          ...(wall.state === 'limited' ? { resetsAtMs: wall.resetsAtMs } : {}),
        }
      }
    }
    return view
  }
  // anthropic
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
      // The managed key's own Anthropic window has NO observation road
      // from this seat (the limits latch is subscriber-gated and never
      // slot-attributed): walled:false here is ABSENCE, not headroom —
      // wallKnown carries that honestly (FN-016 R18).
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
      // The latch cannot observe the subscription's window from the key
      // seat — but the DEPARTED-WALL record can still be speaking for it
      // (the flip away from a walled subscription recorded the wall the
      // reset was about to erase).
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
  // A stored sign-in whose seat yielded with no key left (the guard hands
  // the seat back at the resolver) — the view reads subscription-active.
  view.active = 'subscription'
  view.activeLabel = r.anthropicSubscriptionLabel()
  return view
}

export interface SlotSwitchWrites {
  writeOpenaiPreference?: (kind: 'chatgpt-subscription' | 'api-key') => void
  writeAnthropicPreference?: (kind: 'api-key' | null) => void
  resetAnthropicLimits?: () => void
  /** The auth-flip cache discipline (release-hardening audit rank 49): the
   *  beta-header set and the tool-schema shape are memoised per credential
   *  kind, and the capabilities module's own contract says auth flips must
   *  route through clearBetasCaches — a switch that skipped it kept
   *  emitting the OAuth beta header on key-credentialed requests (a hard
   *  400 on an unexpected anthropic-beta value) until something else
   *  cleared the memo. */
  clearAuthHeaderCaches?: () => void
  /** Record (or clear, with null) the departed slot's observed wall —
   *  written BEFORE the latch reset erases the observation. */
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

/** The wall-row APPENDIX: the sentence a usage-wall row appends
 *  when the family's OTHER slot could carry the work — the transcript's own
 *  receipt of the offer (or of the armed auto switch, which the composer's
 *  decision block then executes through the SAME decision function). Empty
 *  when no second slot is signed in (today's words stand); an other slot
 *  whose OWN wall the estate has observed is named, never advertised as
 *  headroom. Pure over the injected reads + posture so the lanes and the
 *  provers compose identical words. */
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
    // The armed-switch receipt claims the SWITCH — a fact — never headroom.
    return ` Cap failover posture 'auto' is armed: the active slot switches to the ${view.other.label} now — the next turn rides it (${wordsDoor} switches back).`
  }
  // FN-016 R18: the claim must be observable or unspoken. An OBSERVED clear
  // pool may say headroom; an unobservable window is spoken as such.
  if (!view.other.wallKnown) {
    return ` The ${view.other.label} slot is signed in — its own window is unobserved from this seat; the wall card offers the switch in one key (${wordsDoor} in words; the sign-in stays connected either way).`
  }
  return ` The ${view.other.label} slot is signed in with headroom — the wall card offers the switch in one key (${wordsDoor} in words; the sign-in stays connected either way).`
}

export type SlotSwitchOutcome =
  | { switched: true; family: SwitchableFamily; from: SlotKind; to: SlotKind; receipt: string }
  | { switched: false; family: SwitchableFamily; receipt: string }

/**
 * Flip the family's ACTIVE slot to the other signed-in slot (or to an
 * explicit target). Refusals are TYPED words, never silence: no pair, an
 * env pin ruling the family, or already on the target. The receipt names
 * both slots and the mid-session law (the next turn rides the new seat;
 * the sign-in stays connected; session identity untouched).
 */
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
    // The departed slot's observed wall is RECORDED before the latch reset
    // erases it (FN-016 R18): leaving the subscription seat, the latch is
    // that slot's own observation — only a wall with a stated reset is
    // recorded (it expires there). Coming home clears the record: the
    // seated subscription re-observes live from here.
    if (target === 'api-key' && view.active === 'subscription') {
      const activeWall = r.anthropicWall()
      if (activeWall.walled && activeWall.resetsAtMs !== undefined) {
        writes.noteAnthropicDepartedWall({ kind: 'subscription', resetsAtMs: activeWall.resetsAtMs })
      }
    } else if (target === 'subscription') {
      writes.noteAnthropicDepartedWall(null)
    }
    // 'subscription' clears the preference (the default precedence IS the
    // subscription seat); 'api-key' stores the yield.
    writes.writeAnthropicPreference(target === 'api-key' ? 'api-key' : null)
    // The account behind the session's Anthropic lane changed — the limits
    // latch and the window feeders must not outlive the departed seat.
    writes.resetAnthropicLimits()
    // Neither may the memoised header set: the next turn must resolve its
    // anthropic-beta values and tool schemas under the NEWLY seated
    // credential, or the promised "the next turn rides it" arrives as an
    // unexplained 400 (release-hardening audit rank 49).
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

/** The footer's transient for a switch receipt (FN-016 R20): the receipt's
 *  FIRST clause — the switch itself — while the whole receipt lives in the
 *  transcript row. A one-clause refusal is its own transient. */
export function slotSwitchTransient(receipt: string): string {
  const end = receipt.indexOf('. ')
  return end === -1 ? receipt : receipt.slice(0, end + 1)
}
