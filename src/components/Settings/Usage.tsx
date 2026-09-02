
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Text } from '../../ink.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import {
  fetchUtilization,
  type RateLimit,
  type Utilization,
} from '../../services/api/usage.js'
import { getSubscriptionType, isClaudeAISubscriber } from '../../utils/auth.js'
import { recentSignIns } from '../../utils/model/computedDefault.js'
import type { RouterProviderId } from '../../utils/router/providers/types.js'
import {
  anthropicWindowViews,
  openaiObservedWindowViews,
  providerFamilyPresences,
  providerSessionSpend,
  providerUsageView,
  refreshProviderUsage,
  usageForProvider,
  type ActiveSourceUsage,
  type ProviderFamilyPresence,
  type ProviderSessionSpend,
  type UsageWindowView,
} from '../../services/providers/providerUsage.js'
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

const WARN_PCT = 70
const ERROR_PCT = 90
const FULL_BAR_MIN_WIDTH = 62
const FULL_BAR_WIDTH = 50

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
  maxWidth?: number
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const { columns } = useTerminalSize()
  const pct = pctOf(limit)
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


function SlotHeading({ text }: { text: string }): React.ReactNode {
  const tokens = useMercuryTokens()
  return <Text bold color={tokens.textSecondary}>{text}</Text>
}

function spendLine(spend: ProviderSessionSpend, withCost: boolean): string {
  if (spend.models === 0) return 'This session: 0 tokens.'
  return `This session: ${spend.inputTokens.toLocaleString()} input · ${spend.outputTokens.toLocaleString()} output tokens${withCost ? ` · ${formatLaneSpend(spend)}` : ''}`
}

function ApiKeySlot({
  presentLabel,
  isActive,
  spend,
  note,
}: {
  presentLabel?: string
  isActive: boolean
  spend: ProviderSessionSpend
  note?: string
}): React.ReactNode {
  return (
    <Box flexDirection="column" marginTop={1}>
      <SlotHeading text="API key" />
      {presentLabel === undefined ? (
        <Text dimColor>none attached — n/a · 0 this session</Text>
      ) : (
        <Box flexDirection="column">
          <Text dimColor>{presentLabel}</Text>
          <Text dimColor>
            {isActive ? spendLine(spend, true) : 'attached — not the active billing source this session'}
          </Text>
          {isActive && note !== undefined ? <Text dimColor>{note}</Text> : null}
        </Box>
      )}
    </Box>
  )
}

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

function figuresLine(usage: ActiveSourceUsage): string | undefined {
  const figures = usage.figures ?? []
  if (figures.length === 0) return undefined
  const parts = figures.map(f => `${f.value} ${f.label}`)
  return `${parts.join(' · ')}${observedStamp(figures[0]?.observedAtMs)}`
}

function ObservedWindowMeter({ window: w, maxWidth }: { window: UsageWindowView; maxWidth?: number }): React.ReactNode {
  if (w.usedPct === undefined) return null
  const observed =
    w.observedAtMs !== undefined
      ? `live from the account source · observed ${new Date(w.observedAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : undefined
  return (
    <Meter
      title={w.label === 'wk' ? 'Current week' : `Window (${w.label})`}
      limit={{
        utilization: w.usedPct,
        resets_at: w.resetsAtMs !== undefined ? new Date(w.resetsAtMs).toISOString() : null,
      }}
      {...(observed !== undefined ? { subtext: observed } : {})}
      {...(maxWidth !== undefined ? { maxWidth } : {})}
    />
  )
}


const ENGINE_USAGE_PRESENTATION: Record<
  string,
  { title: string; connect: string; limitsNote: string }
> = {
  openai: {
    title: 'OpenAI usage',
    connect: '/logins adds an OpenAI account',
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
    limitsNote: 'Usage bills OpenRouter credits; the key endpoint serves live credit truth.',
  },
  gemini: {
    title: 'Gemini usage',
    connect: '/logins adds Gemini (API key, or Google OAuth with your own client)',
    limitsNote: 'Usage bills to your Google account; the connected section states what the provider publishes.',
  },
  moonshot: {
    title: 'Moonshot usage',
    connect: '/logins moonshot adds Kimi (device-code sign-in, or a Moonshot API key; MOONSHOT_API_KEY works too)',
    limitsNote: 'A Kimi sign-in meters its plan windows; a key bills to your Moonshot account balance.',
  },
  deepseek: {
    title: 'DeepSeek usage',
    connect: '/logins deepseek adds a DeepSeek API key (DEEPSEEK_API_KEY works too)',
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
    limitsNote: 'Usage bills to your Hugging Face account; the connected section states what the provider publishes.',
  },
  local: {
    title: 'Local models usage',
    connect: 'start Ollama (:11434), LM Studio (:1234), vLLM (:8000) or llama.cpp-server (:8080), or set MERCURY_LOCAL_BASE_URL',
    limitsNote: 'local · no metering',
  },
}

export interface UsageSection {
  id: RouterProviderId
  kind: 'anthropic' | 'engine'
  title: string
  connect: string
  limitsNote: string
  family: ProviderFamilyPresence
}

export function orderUsageSections(plan: UsageSection[], recency: readonly string[]): UsageSection[] {
  const rank = new Map<string, number>(recency.map((family, index) => [family, index]))
  const byRecency = (a: UsageSection, b: UsageSection): number =>
    (rank.get(a.id) ?? Number.POSITIVE_INFINITY) - (rank.get(b.id) ?? Number.POSITIVE_INFINITY)
  const signedIn = plan.filter(section => section.family.credentialed).sort(byRecency)
  const absent = plan.filter(section => !section.family.credentialed)
  return [...signedIn, ...absent]
}

function liveSignInRecency(): string[] {
  try {
    return recentSignIns().map(credential => credential.family)
  } catch {
    return []
  }
}

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

function OpenaiUsageSection({ width }: { width?: number }): React.ReactNode {
  const view = providerUsageView('openai')
  const active = view.activeEntry
  const spend = view.sessionSpend
  const seat = getGptSeatAvailability()
  const sub = view.entries.find(e => e.kind === 'subscription-oauth')
  const key = view.entries.find(e => e.kind === 'api-key')
  const windows = openaiObservedWindowViews()
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
          <Text dimColor>none connected — /logins adds a ChatGPT account · n/a</Text>
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
                : 'not the active billing source this session'}
            </Text>
          </Box>
        )}
      </Box>
      <ApiKeySlot
        presentLabel={key?.label}
        isActive={active?.kind === 'api-key'}
        spend={spend}
        {...(owner.absence !== undefined ? { note: owner.absence } : {})}
      />
      <Text dimColor>
        {seat.state === 'ready'
          ? `Models: ${seat.ids.length} qualified via the live catalogue.`
          : `Models: ${seat.reason}.`}
      </Text>
    </Box>
  )
}

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
  return (
    <Box flexDirection="column">
      <Text bold>OpenRouter usage</Text>
      <Box flexDirection="column" marginTop={1}>
        <SlotHeading text="OAuth-minted key" />
        {oauth === undefined ? (
          <Text dimColor>none — /logins mints a scoped key via the OpenRouter OAuth flow · n/a</Text>
        ) : (
          <Box flexDirection="column">
            <Text dimColor>{oauth.label}</Text>
            <Text dimColor>
              {active?.id === oauth.id
                ? spendLine(spend, true)
                : 'attached — not the active billing source this session'}
            </Text>
          </Box>
        )}
      </Box>
      <ApiKeySlot presentLabel={key?.label} isActive={active !== undefined && active.id === key?.id} spend={spend} />
      {windows.map(w => (
        <ObservedWindowMeter key={w.key} window={w} {...(width !== undefined ? { maxWidth: width } : {})} />
      ))}
      <Text dimColor>{creditLine}</Text>
      <Text dimColor>One credential serves the whole OpenRouter multi-model catalogue.</Text>
    </Box>
  )
}

function GeminiUsageSection({ width }: { width?: number }): React.ReactNode {
  void width
  const entries = walletEntries().filter(e => e.provider === 'gemini')
  const active = activeWalletEntry('gemini')
  const spend = providerSessionSpend('gemini')
  const oauth = entries.find(e => e.kind === 'oauth')
  const key = entries.find(e => e.kind === 'api-key')
  const usage = usageForProvider('gemini')
  return (
    <Box flexDirection="column">
      <Text bold>Gemini usage</Text>
      <Box flexDirection="column" marginTop={1}>
        <SlotHeading text="Google account" />
        {oauth === undefined ? (
          <Text dimColor>none connected — /logins connects Google OAuth (needs your own OAuth client) · n/a</Text>
        ) : (
          <Box flexDirection="column">
            <Text dimColor>{oauth.label}</Text>
            <Text dimColor>
              {active?.kind === 'oauth'
                ? spendLine(spend, true)
                : 'connected — not the active billing source this session'}
            </Text>
          </Box>
        )}
      </Box>
      <ApiKeySlot presentLabel={key?.label} isActive={active?.kind === 'api-key'} spend={spend} />
      <Text dimColor>{usage.absence ?? ENGINE_USAGE_PRESENTATION.gemini!.limitsNote}</Text>
    </Box>
  )
}

function HuggingfaceUsageSection(): React.ReactNode {
  const account = resolveHuggingfaceAccount()
  const spend = providerSessionSpend('huggingface')
  const availability = getHuggingfaceAvailability()
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
          <Text dimColor>none — /logins signs in with the Hub's device-code flow · n/a</Text>
        )}
      </Box>
      <ApiKeySlot
        presentLabel={account?.kind === 'api-key' ? account.label : undefined}
        isActive={account?.kind === 'api-key'}
        spend={spend}
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
          <Text dimColor>none discovered — {ENGINE_USAGE_PRESENTATION.local!.connect} · n/a</Text>
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
  const usage = useOwnerUsage(section.id, section.family.credentialed)
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
        <Text dimColor>none on this lane — this provider connects by API key · n/a</Text>
      </Box>
      <ApiKeySlot
        presentLabel={section.family.credentialLabel}
        isActive={section.family.credentialed}
        spend={spend}
      />
      {section.id === 'deepseek' && section.family.credentialed ? (
        <Text dimColor>
          {usage.balance
            ? `Balance (provider-stated): ${usage.balance.display} · observed ${new Date(usage.balance.observedAtMs).toLocaleTimeString()}${usage.readerNote !== undefined ? ` · ${usage.readerNote}` : ''}`
            : 'Balance: not yet observed — the provider is asked on this tab.'}
        </Text>
      ) : null}
      <Text dimColor>
        {section.family.credentialed ? (usage.absence ?? section.limitsNote) : `Not connected — ${section.connect}.`}
      </Text>
    </Box>
  )
}

function MoonshotUsageSection(): React.ReactNode {
  const account = resolveMoonshotAccount()
  const key = resolveMoonshotApiKey()
  const spend = providerSessionSpend('moonshot')
  const usage = useOwnerUsage('moonshot', account !== undefined)
  const windows = usage.windows
  const managedObservedAtMs = windows[0]?.observedAtMs
  const balance = usage.balance
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
            {managedObservedAtMs !== undefined ? (
              <Text dimColor>{`observed ${new Date(managedObservedAtMs).toLocaleTimeString()} (GET /usages on the coding base)`}</Text>
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
      />
      {account?.kind === 'api-key' ? (
        <Text dimColor>
          {balance
            ? `Balance (provider-stated): ${balance.display} · observed ${new Date(balance.observedAtMs).toLocaleTimeString()}`
            : 'Balance: not yet observed — the provider is asked on this tab.'}
        </Text>
      ) : null}
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
  const subscriber = isClaudeAISubscriber()
  const [state, setState] = useState<{
    loading: boolean
    error: unknown
    data: Utilization | null
  }>({ loading: subscriber, error: null, data: null })

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
      return <Text dimColor>none connected — /logins connects one · n/a</Text>
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

    const data = state.data ?? {}
    const plan = getSubscriptionType()
    const ownerWindows = anthropicWindowViews().filter(w => w.state === 'live')
    const fiveHourView = ownerWindows.find(w => w.key === '5h')
    const sevenDayView = ownerWindows.find(w => w.key === '7d')
    const modelWeekRows: Array<[string, RateLimit]> = []
    for (const [family, limit] of [
      ['Fable', data.seven_day_fable],
      ['Opus', data.seven_day_opus],
      ['Sonnet', data.seven_day_sonnet],
    ] as const) {
      if (limit != null) modelWeekRows.push([family, limit])
    }
    const hasAnyLimit = ownerWindows.length > 0 || modelWeekRows.length > 0
    if (!hasAnyLimit) {
      return (
        <Text dimColor>
          Usage limits are only available on subscription plans.
        </Text>
      )
    }

    const showModelSpecific = plan === 'max' || plan === 'team' || plan === null

    const meterOf = (w: UsageWindowView): RateLimit => ({
      utilization: w.usedPct ?? null,
      resets_at: w.resetsAtMs !== undefined ? new Date(w.resetsAtMs).toISOString() : null,
    })
    return (
      <Box flexDirection="column">
        {fiveHourView !== undefined ? (
          <Meter title="Current session" limit={meterOf(fiveHourView)} {...(width !== undefined ? { maxWidth: width } : {})} />
        ) : null}
        {sevenDayView !== undefined ? (
          <Meter title="Current week (all models)" limit={meterOf(sevenDayView)} {...(width !== undefined ? { maxWidth: width } : {})} />
        ) : null}
        {showModelSpecific
          ? modelWeekRows.map(([family, limit]) => (
              <Meter key={family} title={`Current week (${family})`} limit={limit} {...(width !== undefined ? { maxWidth: width } : {})} />
            ))
          : null}
      </Box>
    )
  })()

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
      />
    </Box>
  )
}

export function Usage(): React.ReactNode {
  const { columns } = useTerminalSize()
  const plan = orderUsageSections(usageSectionPlan(providerFamilyPresences()), liveSignInRecency())
  const wide = columns >= 120 && plan.length > 1
  if (!wide) {
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
  const usable = columns - 6
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
