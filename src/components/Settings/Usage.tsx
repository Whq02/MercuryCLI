// The usage tab:
// one section per provider family the router catalogue knows (
// — the row set is DERIVED, never a hand-kept provider pair). At wide
// widths (≥120 cols) the provider sections render LEFT-TO-RIGHT as columns;
// narrower terminals keep the stacked layout — columns never clip (meters
// cap to their column). EVERY provider section carries TWO SLOTS: the
// account/subscription slot and the API-key slot — an absent credential
// renders an honest none/n-a slot, never a vanished one. The Anthropic
// subscription slot fetches its utilization meters on mount; the OpenAI
// subscription slot renders the LIVE-observed usage bands (the x-codex
// header family folded at the response seam — openaiLimitState), in the
// same bar-with-percent grammar, or an honest labeled absence while the
// source has stated nothing. Usage numbers are perishable provider facts:
// meters derive from the one live owner (providerUsage), never a second
// decode. EVERY figure on this tab traces to that owner: a section samples
// its family through the owner's refresh door (refreshProviderUsage) and
// reads the owner's view (usageForProvider) — windows, balance, figures,
// the reader's own note, the honest absence — never a reader module
// directly, so the tab can never show a figure no reader observed. Raw
// JSON at the operator is a defect: errors go through the humaniser first.

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Text } from '../../ink.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import {
  fetchUtilization,
  type RateLimit,
  type Utilization,
} from '../../services/api/usage.js'
import { isClaudeAISubscriber } from '../../utils/auth.js'
import { recentSignIns } from '../../utils/model/computedDefault.js'
import type { RouterProviderId } from '../../utils/router/providers/types.js'
import {
  anthropicPoolWindowViews,
  anthropicWindowViews,
  openaiObservedWindowViews,
  providerFamilyPresences,
  providerSessionSpend,
  providerUsageView,
  refreshProviderUsage,
  usageCreditsLine,
  usageForProvider,
  type ActiveSourceUsage,
  type ProviderFamilyPresence,
  type ProviderSessionSpend,
  type UsageWindowView,
} from '../../services/providers/providerUsage.js'
import { usageSourceWords } from '../../services/providers/usageFreshness.js'
import { activeWalletEntry, walletEntries } from '../../services/wallet/wallet.js'
import { getGptSeatAvailability } from '../../services/providers/openai/openaiCatalogue.js'
import {
  resolveMoonshotAccount,
  resolveMoonshotApiKey,
} from '../../services/providers/moonshot/moonshotAccounts.js'
import { resolveHuggingfaceAccount } from '../../services/providers/huggingface/huggingfaceAccounts.js'
import { getHuggingfaceAvailability } from '../../services/providers/huggingface/huggingfaceCatalogue.js'
import { HUGGINGFACE_UNVERIFIED_NOTE } from '../../services/providers/huggingface/huggingfaceCallModel.js'
import { getCachedLocalDiscovery } from '../../services/providers/local/localDiscovery.js'
import { resolveLocalAccount } from '../../services/providers/local/localAccounts.js'
import { LOCAL_SERVER_NAMES } from '../../services/providers/local/localCatalogue.js'
import { formatLaneSpend } from '../../cost-tracker.js'
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js'
import { ProgressBar } from '../design-system/ProgressBar.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'

/** Band escalation: success below 70, warning below 90, error above. */
const WARN_PCT = 70
const ERROR_PCT = 90
/** The bar takes 50 cells when at least this much width is available. */
const FULL_BAR_MIN_WIDTH = 62
const FULL_BAR_WIDTH = 50

/**
 * Humanise an API error body (object or JSON string). Returns null for an
 * unparseable body, a body with no error object, or a non-object error, so
 * the caller falls back to its raw path.
 */
export function humanizeUsageError(body: unknown): string | null {
  let parsed: unknown = body
  if (typeof body === 'string') {
    try {
      parsed = JSON.parse(body)
    } catch {
      return null
    }
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const error = (parsed as { error?: unknown }).error
  if (typeof error !== 'object' || error === null) return null
  const type = (error as { type?: unknown }).type
  const message = (error as { message?: unknown }).message
  const typeText = typeof type === 'string' ? type : undefined
  const messageText = typeof message === 'string' ? message : undefined
  if (typeText === 'rate_limit_error') {
    return 'rate limited — usage data is temporarily unavailable, retry in a moment'
  }
  if (typeText === 'overloaded_error') {
    return 'the API is overloaded — usage data is temporarily unavailable, retry in a moment'
  }
  if (messageText !== undefined && typeText !== undefined) {
    return `${messageText} (${typeText})`
  }
  if (messageText !== undefined) return messageText
  if (typeText !== undefined) return typeText
  return null
}

function pctOf(limit: RateLimit | null | undefined): number | null {
  if (limit == null || limit.utilization === null) return null
  return Math.floor(limit.utilization)
}

function fillFor(pct: number, tokens: ReturnType<typeof useMercuryTokens>): string {
  if (pct >= ERROR_PCT) return tokens.failure
  if (pct >= WARN_PCT) return tokens.warning
  return tokens.success
}

function resetLineOf(resetsAt: string | null, hideTime: boolean): string | null {
  if (resetsAt === null) return null
  const date = new Date(resetsAt)
  if (Number.isNaN(date.getTime())) return null
  const text = hideTime
    ? date.toLocaleDateString()
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  return `resets ${text}`
}

function Meter({
  title,
  limit,
  subtext,
  hideResetTime = false,
  maxWidth,
}: {
  title: string
  limit: RateLimit
  subtext?: string
  hideResetTime?: boolean
  /** Column mode: the bar caps to its column so columns never clip. */
  maxWidth?: number
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const { columns } = useTerminalSize()
  const pct = pctOf(limit)
  // A meter whose utilisation is null renders nothing.
  if (pct === null) return null
  const available = Math.min(maxWidth ?? columns - 2, 80)
  const barWidth = available >= FULL_BAR_MIN_WIDTH ? FULL_BAR_WIDTH : available
  const fill = fillFor(pct, tokens)
  const reset = resetLineOf(limit.resets_at, hideResetTime)
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color={pct >= WARN_PCT ? fill : undefined}>
        {title} <Text bold={false}>· {pct}%</Text>
      </Text>
      <ProgressBar
        ratio={pct / 100}
        width={barWidth}
        fillColor={fill}
        emptyColor={tokens.surface2}
      />
      {subtext !== undefined ? <Text dimColor>{subtext}</Text> : null}
      {reset !== null ? <Text dimColor>{reset}</Text> : null}
    </Box>
  )
}

// ── the two-slot grammar (every provider column: subscription + API key) ────
//  Both slots ALWAYS render: an absent credential is an honest none/n-a
//  body, never a vanished slot — the operator sees at a glance which lanes
//  exist and which are empty.

function SlotHeading({ text }: { text: string }): React.ReactNode {
  const tokens = useMercuryTokens()
  return <Text bold color={tokens.textSecondary}>{text}</Text>
}

function spendLine(spend: ProviderSessionSpend, withCost: boolean): string {
  if (spend.models === 0) return 'This session: 0 tokens.'
  // The figure is spelled by the one law (formatLaneSpend): an unpriced
  // lane reads "unpriced", a mixed lane says "+ N unpriced turns", an
  // estimated lane says so — never a $0.00 that reads as free.
  return `This session: ${spend.inputTokens.toLocaleString()} input · ${spend.outputTokens.toLocaleString()} output tokens${withCost ? ` · ${formatLaneSpend(spend)}` : ''}`
}

/** The API-key slot — present for EVERY provider column. The active billing
 *  slot carries the session spend; a present-but-inactive key says so; an
 *  absent key renders the honest none/n-a body. */
/** THE SLOT GRAMMAR — one spelling for every family (no family favoured):
 *  an absent slot names its route; a present slot that is not the session's
 *  billing source says so. The per-family sections used to spell these
 *  their own way ("none connected", "none on this lane", "attached —",
 *  "connected —"), a drift with no reason behind it. */
export function absentSlotLine(route: string): string {
  return `none — ${route} · n/a`
}
export const INACTIVE_SLOT_LINE = 'not the active billing source this session'

function ApiKeySlot({
  presentLabel,
  isActive,
  spend,
  note,
  creditsLine,
}: {
  /** The custodian's non-secret label when a key exists; undefined = absent. */
  presentLabel?: string
  isActive: boolean
  spend: ProviderSessionSpend
  /** The owner's absence line for an ACTIVE key whose usage this lane
   *  cannot read (the provider console is the view). */
  note?: string
  /** The owner's credits line for an ACTIVE key — the provider-stated
   *  balance with its feed and age, or "not reported by the provider". */
  creditsLine?: string
}): React.ReactNode {
  return (
    <Box flexDirection="column" marginTop={1}>
      <SlotHeading text="API key" />
      {presentLabel === undefined ? (
        <Text dimColor>{absentSlotLine('a pasted key attaches one')}</Text>
      ) : (
        <Box flexDirection="column">
          <Text dimColor>{presentLabel}</Text>
          <Text dimColor>
            {isActive ? spendLine(spend, true) : INACTIVE_SLOT_LINE}
          </Text>
          {isActive && creditsLine !== undefined ? <Text dimColor>{creditsLine}</Text> : null}
          {isActive && note !== undefined ? <Text dimColor>{note}</Text> : null}
        </Box>
      )}
    </Box>
  )
}

/** ONE sampling road for every family section: the mount asks the owner's
 *  refresh door to sample the family's reader (TTL-bounded inside; a family
 *  that publishes nothing resolves at once), and every render reads the
 *  owner's view — so the section paints exactly what a reader observed, at
 *  the stamp it observed it. Nothing is asked for an absent credential. */
function useOwnerUsage(id: RouterProviderId, credentialed: boolean): ActiveSourceUsage {
  const [, setSample] = useState(0)
  useEffect(() => {
    if (!credentialed) return
    let disposed = false
    void refreshProviderUsage(id).then(() => {
      if (!disposed) setSample(s => s + 1)
    })
    return () => {
      disposed = true
    }
  }, [id, credentialed])
  return usageForProvider(id)
}

function observedStamp(atMs: number | undefined): string {
  return atMs !== undefined ? ` · observed ${new Date(atMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''
}

/** The owner's provider-stated figures as ONE line in the provider's own
 *  units and words (each figure `value label`), stamped; the reader's own
 *  note beside it when it has one; nothing when nothing was observed. */
function figuresLine(usage: ActiveSourceUsage): string | undefined {
  const figures = usage.figures ?? []
  if (figures.length === 0) return undefined
  const parts = figures.map(f => `${f.value} ${f.label}`)
  return `${parts.join(' · ')}${observedStamp(figures[0]?.observedAtMs)}`
}

/** An observed window view → the shared Meter grammar (bar + percent +
 *  reset), captioned with the ONE source + freshness vocabulary (its feed
 *  and the read's age; stale past the reader's horizon) — a record,
 *  presented as observed, never as eternal. */
function ObservedWindowMeter({
  window: w,
  title,
  maxWidth,
}: {
  window: UsageWindowView
  /** The row title; derived from the window label when absent. */
  title?: string
  maxWidth?: number
}): React.ReactNode {
  if (w.usedPct === undefined) return null
  const observed = usageSourceWords(w)
  return (
    <Meter
      title={title ?? (w.label === 'wk' ? 'Current week' : `Window (${w.label})`)}
      limit={{
        utilization: w.usedPct,
        resets_at: w.resetsAtMs !== undefined ? new Date(w.resetsAtMs).toISOString() : null,
      }}
      {...(observed !== undefined ? { subtext: observed } : {})}
      {...(maxWidth !== undefined ? { maxWidth } : {})}
    />
  )
}

// ── the derived section plan ─────────────────────────────────
//  Which sections mount, in catalogue order — one per provider family the
//  router catalogue knows. Presentation facts per KNOWN id; an id the table does not
//  know still gets an honest section labeled by its id, so a future adapter
//  can never be silent here.

/** Per-KNOWN-id presentation (display casing + the product's connect route +
 *  the honest limits note for the generic section body). */
const ENGINE_USAGE_PRESENTATION: Record<
  string,
  { title: string; connect: string; limitsNote: string }
> = {
  openai: {
    title: 'OpenAI usage',
    connect: '/logins adds an OpenAI account',
    // The rich OpenAI section below owns its own limits copy.
    limitsNote: 'Usage bills to your OpenAI account; no polled limit meter exists on this lane.',
  },
  zai: {
    title: 'Z.AI usage',
    connect: '/logins zai adds a Z.AI API key (general or GLM Coding Plan; ZAI_API_KEY works too)',
    limitsNote: 'Usage bills to your Z.AI account; no polled limit meter exists on this lane.',
  },
  openrouter: {
    title: 'OpenRouter usage',
    connect: '/logins adds OpenRouter (OAuth mints a key, or paste one)',
    // The rich OpenRouter section below owns its own limits copy.
    limitsNote: 'Usage bills OpenRouter credits; the key endpoint serves live credit truth.',
  },
  gemini: {
    title: 'Gemini usage',
    connect: '/logins adds Gemini (API key, or Google OAuth with your own client)',
    // The rich Gemini section below paints the owner's absence line.
    limitsNote: 'Usage bills to your Google account; the connected section states what the provider publishes.',
  },
  moonshot: {
    title: 'Moonshot usage',
    connect: '/logins moonshot adds Kimi (device-code sign-in, or a Moonshot API key; MOONSHOT_API_KEY works too)',
    // The rich Moonshot section below owns its own limits copy.
    limitsNote: 'A Kimi sign-in meters its plan windows; a key bills to your Moonshot account balance.',
  },
  deepseek: {
    title: 'DeepSeek usage',
    connect: '/logins deepseek adds a DeepSeek API key (DEEPSEEK_API_KEY works too)',
    // The generic body appends the OBSERVED balance line below when the
    // provider has stated one (GET /user/balance — the lane's billing truth).
    limitsNote: 'Usage bills to your DeepSeek account balance.',
  },
  'openai-compat': {
    title: 'Custom endpoint usage',
    connect: 'set MERCURY_COMPAT_BASE_URL (key optional — /router key compat)',
    limitsNote: 'Usage bills to the endpoint you configured; no polled limit meter exists on this lane.',
  },
  huggingface: {
    title: 'Hugging Face usage',
    connect: '/logins adds Hugging Face (device-code sign-in, or paste a token; HF_TOKEN works too)',
    // The rich Hugging Face section below paints the owner's absence line.
    limitsNote: 'Usage bills to your Hugging Face account; the connected section states what the provider publishes.',
  },
  local: {
    title: 'Local models usage',
    connect: 'start Ollama (:11434), LM Studio (:1234), vLLM (:8000) or llama.cpp-server (:8080), or set MERCURY_LOCAL_BASE_URL',
    // The rich local section below owns its own copy.
    limitsNote: 'local · no metering',
  },
}

export interface UsageSection {
  id: RouterProviderId
  kind: 'anthropic' | 'engine'
  title: string
  /** Engine grammar: the absent-credential connect route. */
  connect: string
  /** Engine grammar: the honest no-meter line for the generic body. */
  limitsNote: string
  family: ProviderFamilyPresence
}

/** Pure: the mounted sections in the /usage LISTING order — every signed-in
 *  family by its most recent sign-in (`recency` is the shared sign-in
 *  ledger's order, newest first, untimed credentials after the timed ones —
 *  the same order the computed default reads, never a second copy of the
 *  rule), then the absent families in catalogue order. No family leads by
 *  name: the provider the operator signed into last is the first column. */
export function orderUsageSections(plan: UsageSection[], recency: readonly string[]): UsageSection[] {
  const rank = new Map<string, number>(recency.map((family, index) => [family, index]))
  const byRecency = (a: UsageSection, b: UsageSection): number =>
    (rank.get(a.id) ?? Number.POSITIVE_INFINITY) - (rank.get(b.id) ?? Number.POSITIVE_INFINITY)
  const signedIn = plan.filter(section => section.family.credentialed).sort(byRecency)
  const absent = plan.filter(section => !section.family.credentialed)
  return [...signedIn, ...absent]
}

/** The live recency read — the sign-in ledger through its one owner; a
 *  read that cannot answer orders nothing (catalogue order stands). */
function liveSignInRecency(): string[] {
  try {
    return recentSignIns().map(credential => credential.family)
  } catch {
    return []
  }
}

/** Pure: families → the mounted section list (the derivation-law prover
 *  feeds a fabricated third family and gets a third section, no UI edit). */
export function usageSectionPlan(families: ProviderFamilyPresence[]): UsageSection[] {
  return families
    .map(family => {
      if (family.id === 'anthropic') {
        return {
          id: family.id,
          kind: 'anthropic' as const,
          title: 'Anthropic usage',
          connect: '/logins connects one',
          limitsNote: '',
          family,
        }
      }
      const meta = ENGINE_USAGE_PRESENTATION[family.id] ?? {
        title: `${family.id} usage`,
        connect: 'connect an account for this provider (see /capabilities)',
        limitsNote: 'No polled usage meter exists for this provider in Mercury.',
      }
      return { id: family.id, kind: 'engine' as const, ...meta, family }
    })
}

/** The OpenAI section (provider parity, two slots): identity + spend +
 *  limits through the ONE per-provider facade (providerUsageView +
 *  openaiObservedWindowViews, stage 9 / model-truth). The subscription slot
 *  renders the LIVE-observed usage bands in the same bar-with-percent
 *  grammar the Anthropic meters use (the x-codex header family, folded at
 *  the response seam) — and while the source has stated nothing, an honest
 *  labeled absence. Never a fabricated meter. */
function OpenaiUsageSection({ width }: { width?: number }): React.ReactNode {
  const view = providerUsageView('openai')
  const active = view.activeEntry
  const spend = view.sessionSpend
  const seat = getGptSeatAvailability()
  const sub = view.entries.find(e => e.kind === 'subscription-oauth')
  const key = view.entries.find(e => e.kind === 'api-key')
  const windows = openaiObservedWindowViews()
  // The owner's view of the ACTIVE source (a key's absence line).
  const owner = usageForProvider('openai')
  const limited =
    view.limits.kind === 'openai-observed' && view.limits.window.state === 'limited'
      ? view.limits.window
      : null
  return (
    <Box flexDirection="column">
      <Text bold>OpenAI usage</Text>
      <Box flexDirection="column" marginTop={1}>
        <SlotHeading text="Subscription" />
        {sub === undefined ? (
          <Text dimColor>{absentSlotLine('/logins openai adds a ChatGPT account')}</Text>
        ) : (
          <Box flexDirection="column">
            <Text dimColor>{sub.label}</Text>
            {windows.length > 0 ? (
              windows.map(w => (
                <ObservedWindowMeter key={w.key} window={w} {...(width !== undefined ? { maxWidth: width } : {})} />
              ))
            ) : (
              <Text dimColor>
                no usage signal observed from the account source yet — the weekly meter fills
                after the first GPT reply (no polled endpoint exists on this lane; meters
                derive live from response headers).
              </Text>
            )}
            {limited !== null ? (
              <Text dimColor>
                A usage window is reached — resets {new Date(limited.resetsAtMs).toLocaleString()}.
              </Text>
            ) : null}
            <Text dimColor>
              {active?.kind === 'subscription-oauth'
                ? spendLine(spend, false)
                : INACTIVE_SLOT_LINE}
            </Text>
          </Box>
        )}
      </Box>
      <ApiKeySlot
        presentLabel={key?.label}
        isActive={active?.kind === 'api-key'}
        spend={spend}
        {...(owner.absence !== undefined ? { note: owner.absence } : {})}
        {...(usageCreditsLine(owner.credits) !== undefined ? { creditsLine: usageCreditsLine(owner.credits)! } : {})}
      />
      <Text dimColor>
        {seat.state === 'ready'
          ? `Models: ${seat.ids.length} qualified via the live catalogue.`
          : `Models: ${seat.reason}.`}
      </Text>
    </Box>
  )
}

/** The OpenRouter section: the OAuth-minted
 *  key is its "account" slot, the plain key slot beside it, and the LIVE
 *  credit truth from the polled key endpoint — sampled through the owner's
 *  refresh door on mount (the Anthropic subscription-slot precedent),
 *  rendered stale-but-labelled from the owner's figures, honest absence
 *  until the endpoint has answered. */
function OpenrouterUsageSection({ width }: { width?: number }): React.ReactNode {
  const entries = walletEntries().filter(e => e.provider === 'openrouter')
  const active = activeWalletEntry('openrouter')
  const spend = providerSessionSpend('openrouter')
  const oauth = entries.find(e => e.id === 'openrouter:oauth-key')
  const key = entries.find(e => e.id.startsWith('openrouter:api-key'))
  const usage = useOwnerUsage('openrouter', entries.length > 0)
  const windows = usage.windows
  const creditLine =
    figuresLine(usage) ??
    usage.readerNote ??
    (usage.sourceKind === 'none'
      ? 'no credential — nothing to poll'
      : 'fetching live credit truth from the key endpoint…')
  // The balance fact in the one credits spelling (the remaining credit
  // under a capped key, stamped; an uncapped key states none there).
  const balanceLine = usageCreditsLine(usage.credits)
  return (
    <Box flexDirection="column">
      <Text bold>OpenRouter usage</Text>
      <Box flexDirection="column" marginTop={1}>
        <SlotHeading text="OAuth-minted key" />
        {oauth === undefined ? (
          <Text dimColor>{absentSlotLine('/logins openrouter mints a scoped key through the OpenRouter OAuth flow')}</Text>
        ) : (
          <Box flexDirection="column">
            <Text dimColor>{oauth.label}</Text>
            <Text dimColor>
              {active?.id === oauth.id
                ? spendLine(spend, true)
                : INACTIVE_SLOT_LINE}
            </Text>
          </Box>
        )}
      </Box>
      <ApiKeySlot presentLabel={key?.label} isActive={active !== undefined && active.id === key?.id} spend={spend} />
      {windows.map(w => (
        <ObservedWindowMeter key={w.key} window={w} title="Key credit cap" {...(width !== undefined ? { maxWidth: width } : {})} />
      ))}
      <Text dimColor>{creditLine}</Text>
      {balanceLine !== undefined ? <Text dimColor>{balanceLine}</Text> : null}
      <Text dimColor>One credential serves the whole OpenRouter multi-model catalogue.</Text>
    </Box>
  )
}

/** The Gemini section: the Google OAuth
 *  slot and the key-ladder slot, plus the VERIFIED-ABSENCE limits copy —
 *  the Gemini API exposes no usage endpoint, and an honest note beats a
 *  fabricated meter. */
function GeminiUsageSection({ width }: { width?: number }): React.ReactNode {
  void width
  const entries = walletEntries().filter(e => e.provider === 'gemini')
  const active = activeWalletEntry('gemini')
  const spend = providerSessionSpend('gemini')
  const oauth = entries.find(e => e.kind === 'oauth')
  const key = entries.find(e => e.kind === 'api-key')
  // The owner's absence line — the verified no-usage-endpoint truth.
  const usage = usageForProvider('gemini')
  return (
    <Box flexDirection="column">
      <Text bold>Gemini usage</Text>
      <Box flexDirection="column" marginTop={1}>
        <SlotHeading text="Google account" />
        {oauth === undefined ? (
          <Text dimColor>{absentSlotLine('/logins gemini connects Google OAuth (needs your own OAuth client)')}</Text>
        ) : (
          <Box flexDirection="column">
            <Text dimColor>{oauth.label}</Text>
            <Text dimColor>
              {active?.kind === 'oauth'
                ? spendLine(spend, true)
                : INACTIVE_SLOT_LINE}
            </Text>
          </Box>
        )}
      </Box>
      <ApiKeySlot
        presentLabel={key?.label}
        isActive={active?.kind === 'api-key'}
        spend={spend}
        {...(usageCreditsLine(usage.credits) !== undefined ? { creditsLine: usageCreditsLine(usage.credits)! } : {})}
      />
      <Text dimColor>{usage.absence ?? ENGINE_USAGE_PRESENTATION.gemini!.limitsNote}</Text>
    </Box>
  )
}

/** The generic engine-family section (two slots): the owning resolver's
 *  honest state — a truthful no-subscription-lane slot, the API-key slot
 *  with presence/spend, and the honest no-meter line. KNOWN ids with a
 *  richer surface (openai) mount it instead; an unknown future id renders
 *  THIS body, so a catalogue addition is never silent here. */
/** The Hugging Face section: the sign-in/token slot with the Hub identity,
 *  the session ledger, the live catalogue count, and the documented
 *  ABSENCE of a spend API (credits then pay-as-you-go, viewed on the Hub's
 *  billing page) — plus any limit facts a response stated. */
function HuggingfaceUsageSection(): React.ReactNode {
  const account = resolveHuggingfaceAccount()
  const spend = providerSessionSpend('huggingface')
  const availability = getHuggingfaceAvailability()
  // The owner's view: the stated-rate figure, the reached limit, the
  // documented absence of a spend API.
  const usage = usageForProvider('huggingface')
  const rateLine = figuresLine(usage)
  const rateReset = usage.figures?.[0]?.resetsAtMs
  return (
    <Box flexDirection="column">
      <Text bold>Hugging Face usage</Text>
      <Box flexDirection="column" marginTop={1}>
        <SlotHeading text="Sign-in" />
        {account?.kind === 'oauth' ? (
          <Box flexDirection="column">
            <Text dimColor>{account.label}</Text>
            <Text dimColor>{spendLine(spend, false)}</Text>
          </Box>
        ) : (
          <Text dimColor>{absentSlotLine("/logins huggingface signs in with the Hub's device-code flow")}</Text>
        )}
      </Box>
      <ApiKeySlot
        presentLabel={account?.kind === 'api-key' ? account.label : undefined}
        isActive={account?.kind === 'api-key'}
        spend={spend}
        {...(usageCreditsLine(usage.credits) !== undefined ? { creditsLine: usageCreditsLine(usage.credits)! } : {})}
      />
      {account && (rateLine !== undefined || usage.limited !== undefined) ? (
        <Text dimColor>
          {rateLine !== undefined
            ? `${rateLine}${rateReset !== undefined ? ` · resets ${new Date(rateReset).toLocaleTimeString()}` : ''}`
            : ''}
          {usage.limited !== undefined ? ` A limit is reached — resets ${new Date(usage.limited.resetsAtMs).toLocaleTimeString()}.` : ''}
        </Text>
      ) : null}
      <Text dimColor>
        {account
          ? `Billing: ${usage.absence ?? ENGINE_USAGE_PRESENTATION.huggingface!.limitsNote}.`
          : `Not connected — ${ENGINE_USAGE_PRESENTATION.huggingface!.connect}.`}
      </Text>
      <Text dimColor>
        {availability.state === 'ready'
          ? `Models: ${availability.modelCount > 0 ? `${availability.modelCount} live via the router catalogue` : (availability.catalogueNote ?? 'catalogue pending')} · ${HUGGINGFACE_UNVERIFIED_NOTE}.`
          : `Models: ${availability.liveIds.length > 0 ? `${availability.liveIds.length} live-listed (sign in to select)` : availability.reason} · ${HUGGINGFACE_UNVERIFIED_NOTE}.`}
      </Text>
    </Box>
  )
}

/** The local section: the discovered servers ARE the account — each with
 *  its model count — and the one honest line: nothing is metered locally.
 *  The mount samples through the owner's door (a TTL'd re-probe) so a
 *  server started since boot shows. */
function LocalUsageSection(): React.ReactNode {
  const usage = useOwnerUsage('local', true)
  const account = resolveLocalAccount()
  const snapshot = getCachedLocalDiscovery()
  const spend = providerSessionSpend('local')
  return (
    <Box flexDirection="column">
      <Text bold>Local models usage</Text>
      <Box flexDirection="column" marginTop={1}>
        <SlotHeading text="Servers" />
        {account && snapshot ? (
          <Box flexDirection="column">
            {snapshot.servers.map(server => (
              <Text key={`${server.kind}:${server.root}`} dimColor>
                {server.label} · {LOCAL_SERVER_NAMES[server.kind]} at {server.root} · {server.models.length} model
                {server.models.length === 1 ? '' : 's'}
                {server.models.some(m => m.toolsDeclared === false) ? ' · some declare no tool support' : ''}
              </Text>
            ))}
            <Text dimColor>{spendLine(spend, false)}</Text>
          </Box>
        ) : (
          <Text dimColor>{absentSlotLine(ENGINE_USAGE_PRESENTATION.local!.connect)}</Text>
        )}
      </Box>
      <Text dimColor>
        {account
          ? `${usage.absence ?? 'local · no metering'} — ${account.kind === 'keyless' ? 'keyless' : `key (${account.keySource})`}.`
          : `local · no metering · probes ${snapshot ? `ran ${new Date(snapshot.probedAtMs).toLocaleTimeString()}` : 'pending'}.`}
      </Text>
    </Box>
  )
}

function EngineUsageSection({ section, width }: { section: UsageSection; width?: number }): React.ReactNode {
  // Engine billing truth on this generic body: the family is sampled
  // through the owner's refresh door (DeepSeek's documented balance API
  // answers; a family that publishes nothing resolves at once) and the
  // body renders the owner's LAST-OBSERVED record with its stamp; no
  // observation renders as labeled absence, never a fabricated figure. The
  // hook sits ahead of every family branch below so the hook order is the
  // same on every render (a family that returns early is still a render of
  // this component).
  const usage = useOwnerUsage(section.id, section.family.credentialed)
  // An absent family is ONE quiet line — its title and the connect route —
  // so the connected families keep the room (ten families share one tab;
  // the old full-height absent bodies pushed the later sections off the
  // fixed-height pane).
  if (!section.family.credentialed) {
    return (
      <Box flexDirection="column">
        <Text bold>{section.title}</Text>
        <Text dimColor>not connected — {section.connect}.</Text>
      </Box>
    )
  }
  if (section.id === 'openai') return <OpenaiUsageSection {...(width !== undefined ? { width } : {})} />
  if (section.id === 'openrouter') return <OpenrouterUsageSection {...(width !== undefined ? { width } : {})} />
  if (section.id === 'gemini') return <GeminiUsageSection {...(width !== undefined ? { width } : {})} />
  if (section.id === 'huggingface') return <HuggingfaceUsageSection />
  if (section.id === 'moonshot') return <MoonshotUsageSection />
  if (section.id === 'local') return <LocalUsageSection />
  const spend = providerSessionSpend(section.id)
  return (
    <Box flexDirection="column">
      <Text bold>{section.title}</Text>
      <Box flexDirection="column" marginTop={1}>
        <SlotHeading text="Subscription" />
        <Text dimColor>{absentSlotLine('this family connects by API key')}</Text>
      </Box>
      <ApiKeySlot
        presentLabel={section.family.credentialLabel}
        isActive={section.family.credentialed}
        spend={spend}
        {...(usageCreditsLine(usage.credits) !== undefined ? { creditsLine: usageCreditsLine(usage.credits)! } : {})}
      />
      {section.family.credentialed && usage.readerNote !== undefined ? (
        // The reader speaking about itself (the provider marks the account
        // unavailable) — beside the credits line the slot carries.
        <Text dimColor>{usage.readerNote}</Text>
      ) : null}
      <Text dimColor>
        {section.family.credentialed ? (usage.absence ?? section.limitsNote) : `Not connected — ${section.connect}.`}
      </Text>
    </Box>
  )
}

/** The Moonshot section: a Kimi sign-in meters its plan — the overall quota
 *  and the stated rate windows from GET {coding base}/usages, LAST-OBSERVED
 *  with the stamp (the mount samples through the owner's door); a key is
 *  the API-key slot with the provider-stated balance. Both read the owner's
 *  view — the windows ARE the owner's kimi window views. Nothing observed
 *  renders as labeled absence, never a fabricated figure. */
function MoonshotUsageSection(): React.ReactNode {
  const account = resolveMoonshotAccount()
  const key = resolveMoonshotApiKey()
  const spend = providerSessionSpend('moonshot')
  const usage = useOwnerUsage('moonshot', account !== undefined)
  const windows = usage.windows
  // The managed record's feed + age in the one vocabulary (every window of
  // one poll shares the stamp).
  const managedSourceWords = windows[0] !== undefined ? usageSourceWords(windows[0]) : undefined
  return (
    <Box flexDirection="column">
      <Text bold>Moonshot usage</Text>
      <Box flexDirection="column" marginTop={1}>
        <SlotHeading text="Kimi sign-in" />
        {account?.kind === 'kimi-oauth' ? (
          <Box flexDirection="column">
            <Text dimColor>{account.label}</Text>
            <Text dimColor>{spendLine(spend, false)}</Text>
            {windows.length > 0 ? (
              windows.map(window => (
                <Text key={window.key} dimColor>
                  {`${window.label}: ${window.usedPct !== undefined ? `${Math.round(window.usedPct)}% used` : 'no limit stated'}${window.resetsAtMs !== undefined ? ` · resets ${new Date(window.resetsAtMs).toLocaleString()}` : ''}`}
                </Text>
              ))
            ) : (
              <Text dimColor>Plan windows: not yet observed — the usage endpoint is asked on this tab.</Text>
            )}
            {managedSourceWords !== undefined ? (
              <Text dimColor>{`${managedSourceWords} (GET /usages on the coding base)`}</Text>
            ) : null}
          </Box>
        ) : (
          <Text dimColor>none — /logins moonshot signs in with a device code · n/a</Text>
        )}
      </Box>
      <ApiKeySlot
        presentLabel={
          key ? (key.source === 'env' ? 'MOONSHOT_API_KEY (env)' : 'Moonshot API key (stored, auth-scoped)') : undefined
        }
        isActive={account?.kind === 'api-key'}
        spend={spend}
        {...(usageCreditsLine(usage.credits) !== undefined ? { creditsLine: usageCreditsLine(usage.credits)! } : {})}
      />
      <Text dimColor>
        {account
          ? ENGINE_USAGE_PRESENTATION.moonshot!.limitsNote
          : `Not connected — ${ENGINE_USAGE_PRESENTATION.moonshot!.connect}.`}
      </Text>
    </Box>
  )
}

function AnthropicUsageSection({ width }: { width?: number }): React.ReactNode {
  const tokens = useMercuryTokens()
  // Provider split: the SUBSCRIPTION slot's fetch only runs for a signed-in
  // subscription — an OpenAI-only or key-only boot must not paint a spurious
  // auth failure; the API key gets its own honest slot below either way.
  const subscriber = isClaudeAISubscriber()
  const [state, setState] = useState<{
    loading: boolean
    error: unknown
    data: Utilization | null
  }>({ loading: subscriber, error: null, data: null })

  // Esc can close Settings while the fetch is in flight — the resolved
  // promise must not setState on the unmounted tab.
  const disposedRef = useRef(false)
  useEffect(() => () => {
    disposedRef.current = true
  }, [])

  const load = useCallback((): void => {
    if (!subscriber) return
    setState(previous => ({ ...previous, loading: true, error: null }))
    fetchUtilization()
      .then(data => {
        if (!disposedRef.current) setState({ loading: false, error: null, data })
      })
      .catch((error: unknown) => {
        if (!disposedRef.current) setState({ loading: false, error, data: null })
      })
  }, [subscriber])
  useEffect(() => {
    load()
  }, [load])

  const showingError = !state.loading && state.error !== null
  useKeybinding(
    'settings:retry',
    () => {
      load()
    },
    { context: 'Settings', isActive: showingError },
  )

  const anthropicSection = ((): React.ReactNode => {
    if (!subscriber) {
      return <Text dimColor>{absentSlotLine('/logins anthropic connects a subscription account')}</Text>
    }
    if (state.loading) {
      return <Text dimColor>loading usage…</Text>
    }
    if (showingError) {
      const humanised = humanizeUsageError(state.error)
      const raw =
        state.error instanceof Error
          ? state.error.message
          : state.error !== null && state.error !== undefined
            ? String(state.error)
            : ''
      return (
        <Box flexDirection="column">
          <Text color={tokens.failure}>
            {humanised ?? `Failed to load usage${raw !== '' ? `: ${raw}` : ''}`}
          </Text>
          <Text dimColor>
            <ConfigurableShortcutHint
              action="settings:retry"
              context="Settings"
              fallback="r"
              description="retry"
            />
            {' · '}
            <ConfigurableShortcutHint
              action="confirm:no"
              context="Settings"
              fallback="esc"
              description="cancel"
            />
          </Text>
        </Box>
      )
    }

    // The 5h/7d meters derive from the ONE owner view (providerUsage.
    // anthropicWindowViews — the claudeAiLimits record the rail/deck/frame
    // meters and the cap-failover read; the fetch above already FED it via
    // the fold seam, and a header observation fresher than the fetch wins
    // there). The per-model weekly pools read the SAME record through the
    // owner's pool view (anthropicPoolWindowViews — where the rail, the
    // deck, the doctor and the strip's limit warning read them): every
    // pool the endpoint stated paints its own titled row, none the plan
    // word would hide, and a pool it did not state is absent — never 0%.
    const ownerWindows = anthropicWindowViews().filter(w => w.state === 'live')
    const fiveHourView = ownerWindows.find(w => w.key === '5h')
    const sevenDayView = ownerWindows.find(w => w.key === '7d')
    const poolViews = anthropicPoolWindowViews().filter(w => w.state === 'live')
    const hasAnyLimit = ownerWindows.length > 0 || poolViews.length > 0
    if (!hasAnyLimit) {
      return (
        <Text dimColor>
          Usage limits are only available on subscription plans.
        </Text>
      )
    }
    return (
      <Box flexDirection="column">
        {fiveHourView !== undefined ? (
          <ObservedWindowMeter window={fiveHourView} title="Current session" {...(width !== undefined ? { maxWidth: width } : {})} />
        ) : null}
        {sevenDayView !== undefined ? (
          <ObservedWindowMeter window={sevenDayView} title="Current week (all models)" {...(width !== undefined ? { maxWidth: width } : {})} />
        ) : null}
        {poolViews.map(w => (
          <ObservedWindowMeter key={w.key} window={w} title={`Current week (${w.label})`} {...(width !== undefined ? { maxWidth: width } : {})} />
        ))}
      </Box>
    )
  })()

  // The API-key slot rides the wallet facade (presence + active-billing
  // truth) — the two-slot law: the slot renders honest n/a when absent;
  // an ACTIVE key carries the owner's absence line (no per-key usage
  // endpoint is read on this lane).
  const view = providerUsageView('anthropic')
  const keyEntry = view.entries.find(e => e.kind === 'api-key')
  const owner = usageForProvider('anthropic')
  return (
    <Box flexDirection="column">
      <Text bold>Anthropic usage</Text>
      <Box flexDirection="column" marginTop={1}>
        <SlotHeading text="Subscription" />
        {anthropicSection}
      </Box>
      <ApiKeySlot
        presentLabel={keyEntry?.label}
        isActive={view.activeEntry?.kind === 'api-key'}
        spend={view.sessionSpend}
        {...(owner.absence !== undefined ? { note: owner.absence } : {})}
        {...(usageCreditsLine(owner.credits) !== undefined ? { creditsLine: usageCreditsLine(owner.credits)! } : {})}
      />
    </Box>
  )
}

export function Usage(): React.ReactNode {
  // One section per provider family the catalogue knows, in catalogue order
  // The set is DERIVED — a future adapter appears here with
  // no edit. At ≥120 columns the sections render LEFT-TO-RIGHT as columns
  // (each capped so nothing clips); narrower keeps the stacked layout.
  const { columns } = useTerminalSize()
  // The LISTING order (the usage-neutrality law): every signed-in family
  // by its most recent sign-in — the shared sign-in ledger's order, the
  // provider the operator signed into last first — then the absent
  // one-liners in catalogue order. No family leads by name (the plan itself
  // keeps catalogue order for its provers; the order is applied here).
  const plan = orderUsageSections(usageSectionPlan(providerFamilyPresences()), liveSignInRecency())
  const wide = columns >= 120 && plan.length > 1
  if (!wide) {
    // The containers own the spacing (one row between sections, none above
    // the first, columns of the wide grid flush at the top): a per-section
    // top margin put the Anthropic column's heading one row above its
    // siblings' in the grid.
    return (
      <Box flexDirection="column" gap={1}>
        {plan.map(section =>
          section.kind === 'anthropic' ? (
            <AnthropicUsageSection key={section.id} />
          ) : (
            <EngineUsageSection key={section.id} section={section} />
          ),
        )}
      </Box>
    )
  }
  const gap = 2
  const usable = columns - 6 // frame/tab padding allowance — never clip
  // Columns keep a readable floor, so the sections WRAP into as many rows as
  // the width needs: ten families at 120 columns are three or four rows of
  // columns, every section on screen, none clipped off the right edge.
  const minColW = 30
  const perRow = Math.max(1, Math.min(plan.length, Math.floor((usable + gap) / (minColW + gap))))
  const colW = Math.max(minColW, Math.floor((usable - gap * (perRow - 1)) / perRow))
  const meterW = colW - 2
  const bands: UsageSection[][] = []
  for (let start = 0; start < plan.length; start += perRow) bands.push(plan.slice(start, start + perRow))
  return (
    <Box flexDirection="column">
      {bands.map((band, bandIndex) => (
        <Box key={band.map(section => section.id).join('|')} flexDirection="row" marginTop={bandIndex > 0 ? 1 : 0}>
          {band.map((section, index) => (
            <Box
              key={section.id}
              flexDirection="column"
              width={colW}
              flexShrink={0}
              marginRight={index < band.length - 1 ? gap : 0}
            >
              {section.kind === 'anthropic' ? (
                <AnthropicUsageSection width={meterW} />
              ) : (
                <EngineUsageSection section={section} width={meterW} />
              )}
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  )
}
