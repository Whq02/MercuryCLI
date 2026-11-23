import React, { useState } from 'react'
import { useLoad } from '../../effects/effects.js'
import { Box, Text, useInput } from '../../themedRenderer.js'
import { getEngineModel } from '../../../models/catalogue/engineModel.js'
import { openaiObservedWindowViews, metaMuseCodeUsage, providerSessionSpend, providerUsageView, usageForProvider, zaiAccountFacts, type UsageFigureView } from '../../../models/roads/providerUsage.js'
import { useFocusedServedEffort, useFocusedServedModel } from '../../model-picker/useDisplayedSessionModel.js'
import { geminiLaneModelsByLastUse, geminiPlanQuotaFoldWords, geminiPlanQuotaMeter, geminiPlanQuotaUnreportedWords, geminiPlanQuotaView } from '../../../models/roads/gemini/geminiPlanQuota.js'
import { shownIdentityWords } from '../../../models/roads/providerIdentityLine.js'
import { openrouterSlots } from '../../../models/roads/accountSlots.js'
import { usageSourceWords } from '../../../models/roads/usageFreshness.js'
import { activeWalletEntry, walletEntries } from '../../../models/wallet/wallet.js'
import { getGptSeatAvailability } from '../../../models/roads/openai/openaiCatalogue.js'
import { readCatalogueIfPending } from '../../../models/roads/catalogueOnDemand.js'
import { useCatalogueEpoch } from '../../model-picker/useCatalogueEpoch.js'
import { resolveMoonshotAccount, resolveMoonshotApiKey } from '../../../models/roads/moonshot/moonshotAccounts.js'
import { resolveXaiAccount, resolveXaiApiKey } from '../../../models/roads/xai/xaiAccounts.js'
import { resolveHuggingfaceAccount } from '../../../models/roads/huggingface/huggingfaceAccounts.js'
import { getHuggingfaceAvailability } from '../../../models/roads/huggingface/huggingfaceCatalogue.js'
import { getCachedLocalDiscovery } from '../../../models/roads/local/localDiscovery.js'
import { resolveLocalAccount } from '../../../models/roads/local/localAccounts.js'
import { localServerName } from '../../../models/roads/local/localCatalogue.js'
import { TENSORFOLD_USAGE_SLOT, tensorFoldServing, tensorFoldServingLine, tensorFoldUsageLines } from '../../../models/roads/local/tensorfoldUsage.js'
import { localServerKind } from '../../../models/roads/localPromptProfile.js'
import { hostRentalUsage } from '../../../models/hosting/costs.js'
import { formatDuration } from '../../../platform/text/format.js'
import { geminiStoredSourcesNote, liveGeminiStoredSourceFacts } from '../../../models/roads/gemini/geminiLogin.js'
import { resolveMetaAccount, resolveMetaRawApiKey } from '../../../models/roads/meta/metaAccounts.js'
import { liveMetaConnectFacts, metaMuseCodeTierWordsWithAge, metaStoredSourcesNote } from '../../../models/roads/meta/metaLogin.js'
import { useUsageLayout, SlotHeading, IdentityLine, SlotSpend, absentSlotLine, ApiKeySlot, carryTail, FullWindowLine, useOwnerUsage, figuresLine, ObservedWindowMeter } from './lines.js'
import { ENGINE_USAGE_PRESENTATION, type UsageSection } from './plan.js'

function OpenaiUsageSection({ width }: { width?: number }): React.ReactNode {
  useCatalogueEpoch()
  useUsageLayout()
  useLoad(() => {
    void readCatalogueIfPending('openai')
  }, [])
  const view = providerUsageView('openai')
  const active = view.activeEntry
  const spend = view.sessionSpend
  const seat = getGptSeatAvailability()
  const sub = view.entries.find(e => e.kind === 'subscription-oauth')
  const key = view.entries.find(e => e.kind === 'api-key')
  const windows = openaiObservedWindowViews()
  const owner = useOwnerUsage('openai', sub !== undefined || key !== undefined)
  const limited =
    view.limits.kind === 'openai-observed' && view.limits.window.state === 'limited'
      ? view.limits.window
      : null
  return (
    <Box flexDirection="column">
      <Text bold>OpenAI usage</Text>
      <IdentityLine family="openai" />
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
                no usage signal observed yet — this tab reads the ChatGPT usage endpoint;
                GPT replies also update the meter.
              </Text>
            )}
            {owner.readerNote !== undefined ? <Text dimColor>{owner.readerNote}</Text> : null}
            {limited !== null ? (
              <Text dimColor>
                A usage window is reached — resets {new Date(limited.resetsAtMs).toLocaleString()}{carryTail(owner)}.
              </Text>
            ) : (
              <FullWindowLine usage={owner} />
            )}
            <SlotSpend active={active?.kind === 'subscription-oauth'} route="openai" spend={spend} withCost={false} />
          </Box>
        )}
      </Box>
      <ApiKeySlot
        presentLabel={key?.label}
        isActive={active?.kind === 'api-key'}
        route="openai"
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
  const slots = openrouterSlots()
  const spend = providerSessionSpend('openrouter')
  const oauth = slots.find(slot => slot.id === 'openrouter:oauth-key')
  const keys = slots.filter(slot => slot.kind === 'api-key')
  const usage = useOwnerUsage('openrouter', slots.length > 0)
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
      <IdentityLine family="openrouter" />
      <Box flexDirection="column" marginTop={1}>
        <SlotHeading text="OAuth-minted key" />
        {oauth === undefined ? (
          <Text dimColor>{absentSlotLine('/logins openrouter mints a scoped key through the OpenRouter OAuth flow')}</Text>
        ) : (
          <Box flexDirection="column">
            <Text dimColor>{shownIdentityWords('openrouter', oauth.identity)}</Text>
            {oauth.stateNote !== undefined ? <Text dimColor>{oauth.stateNote}</Text> : null}
            <SlotSpend active={oauth.active} route="openrouter" spend={spend} withCost />
          </Box>
        )}
      </Box>
      {keys.length === 0 ? <ApiKeySlot isActive={false} route="openrouter" spend={spend} /> : keys.map(key => (
        <Box key={key.id} flexDirection="column" marginTop={1}>
          <SlotHeading text={`${key.kindLabel}${key.active ? ' · active' : ''}`} />
          <Text dimColor>{shownIdentityWords('openrouter', key.identity)}</Text>
          {key.stateNote !== undefined ? <Text dimColor>{key.stateNote}</Text> : null}
          <SlotSpend active={key.active} route="openrouter" spend={spend} withCost />
        </Box>
      ))}
      {windows.map(w => (
        <ObservedWindowMeter key={w.key} window={w} title="Key credit cap" {...(width !== undefined ? { maxWidth: width } : {})} />
      ))}
      <Text dimColor>{creditLine}</Text>
      {usage.readerNote !== undefined && usage.readerNote !== creditLine ? <Text dimColor>{usage.readerNote}</Text> : null}
      <Text dimColor>One credential serves the whole OpenRouter multi-model catalogue.</Text>
    </Box>
  )
}

function GeminiUsageSection({ width }: { width?: number }): React.ReactNode {
  const entries = walletEntries().filter(e => e.provider === 'gemini')
  const active = activeWalletEntry('gemini')
  const spend = providerSessionSpend('gemini')
  const oauth = entries.find(e => e.kind === 'oauth')
  const plan = entries.find(e => e.kind === 'subscription-oauth')
  const key = entries.find(e => e.kind === 'api-key')
  const geminiSourcesNote = geminiStoredSourcesNote(liveGeminiStoredSourceFacts())
  const usage = usageForProvider('gemini')
  const planActive = active?.kind === 'subscription-oauth'
  const tierFigure = planActive ? usage.figures?.find(f => f.key === 'plan-tier') : undefined
  const tierStamp = tierFigure !== undefined ? usageSourceWords(tierFigure) : undefined
  const sessionModel = useFocusedServedModel()
  const sessionEffort = useFocusedServedEffort()
  const quota = planActive ? geminiPlanQuotaView(usage.figures ?? [], { ...(sessionModel !== null ? { model: sessionModel } : {}), ...(sessionEffort !== null ? { effort: sessionEffort } : {}), usedModels: geminiLaneModelsByLastUse() }) : { used: [], others: [], unreported: [] }
  const [othersOpen, setOthersOpen] = useState(false)
  useInput((_input, key, event) => {
    if (!key.return || quota.others.length === 0) return
    event.stopImmediatePropagation()
    setOthersOpen(open => !open)
  })
  const quotaLine = (figure: UsageFigureView, tail?: string): string => [`${figure.label}: ${figure.value}`, ...(figure.resetsAtMs !== undefined ? [`resets ${new Date(figure.resetsAtMs).toLocaleString()}`] : []), ...(usageSourceWords(figure) !== undefined ? [usageSourceWords(figure)!] : []), ...(tail !== undefined ? [tail] : [])].join(' · ')
  const quotaRow = (figure: UsageFigureView, tail?: string): React.ReactNode => {
    const meter = geminiPlanQuotaMeter(figure)
    if (meter === null) return <Text key={figure.key} dimColor>{quotaLine(figure, tail)}</Text>
    return (
      <ObservedWindowMeter
        key={figure.key}
        window={meter.window}
        title={meter.title}
        {...(tail !== undefined ? { tail } : {})}
        {...(width !== undefined ? { maxWidth: width } : {})}
      />
    )
  }
  return (
    <Box flexDirection="column">
      <Text bold>Gemini usage</Text>
      <IdentityLine family="gemini" />
      <Box flexDirection="column" marginTop={1}>
        <SlotHeading text="Google sign-in" />
        {plan === undefined ? (
          <Text dimColor>{absentSlotLine('/logins gemini → Sign in with Google rides your plan\'s quota')}</Text>
        ) : (
          <Box flexDirection="column">
            <Text dimColor>{shownIdentityWords('gemini', plan.identity?.email !== undefined ? `${plan.label} · ${plan.identity.email}` : plan.label)}</Text>
            {tierFigure !== undefined ? <Text dimColor>{[`${tierFigure.label}: ${tierFigure.value}`, ...(tierStamp !== undefined ? [tierStamp] : [])].join(' · ')}</Text> : null}
            {quota.active !== undefined ? quotaRow(quota.active, `the session's model${quota.activeRow !== undefined && sessionModel !== null && quota.activeRow !== sessionModel.toLowerCase() ? ` (${sessionModel} ▸ ${quota.activeRow})` : ''}`) : null}
            {quota.used.map(figure => quotaRow(figure, 'used this session'))}
            {quota.unreported.map(entry => (
              <Text key={`plan-quota-unreported:${entry.model}`} dimColor>{`${geminiPlanQuotaUnreportedWords(entry.model)} · ${entry.active ? "the session's model" : 'used this session'}`}</Text>
            ))}
            {quota.others.length > 0 ? <Text dimColor>{geminiPlanQuotaFoldWords(quota.others.length, othersOpen)}</Text> : null}
            {othersOpen ? quota.others.map(figure => quotaRow(figure)) : null}
            {planActive && usage.readerNote !== undefined ? <Text dimColor>{usage.readerNote}</Text> : null}
            <SlotSpend active={planActive} route="gemini" spend={spend} withCost={false} />
          </Box>
        )}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <SlotHeading text="Google account" />
        {oauth === undefined ? (
          <Text dimColor>{absentSlotLine('/logins gemini connects Google OAuth (needs your own OAuth client)')}</Text>
        ) : (
          <Box flexDirection="column">
            <Text dimColor>{oauth.label}</Text>
            <SlotSpend active={active?.kind === 'oauth'} route="gemini" spend={spend} withCost />
          </Box>
        )}
      </Box>
      <ApiKeySlot
        presentLabel={key?.label}
        isActive={active?.kind === 'api-key'}
        route="gemini"
        spend={spend}
      />
      {geminiSourcesNote !== undefined ? <Text dimColor>{geminiSourcesNote}</Text> : null}
      <Text dimColor>{usage.absence ?? ENGINE_USAGE_PRESENTATION.gemini!.limitsNote}</Text>
    </Box>
  )
}

function HuggingfaceUsageSection(): React.ReactNode {
  useCatalogueEpoch()
  useUsageLayout()
  useLoad(() => {
    void readCatalogueIfPending('huggingface')
  }, [])
  const account = resolveHuggingfaceAccount()
  const spend = providerSessionSpend('huggingface')
  const availability = getHuggingfaceAvailability()
  const usage = useOwnerUsage('huggingface', account !== undefined)
  const rate = usage.figures?.find(f => f.key === 'rate-remaining')
  const plan = usage.figures?.find(f => f.key === 'plan')
  const rateLine = rate !== undefined ? figuresLine({ ...usage, figures: [rate] }) : undefined
  const rateReset = rate?.resetsAtMs
  const planStamp = plan !== undefined ? usageSourceWords(plan) : undefined
  const planLine =
    plan !== undefined
      ? [
          `${plan.value} ${plan.label}`,
          ...(plan.resetsAtMs !== undefined ? [`period ends ${new Date(plan.resetsAtMs).toLocaleDateString()}`] : []),
          ...(planStamp !== undefined ? [planStamp] : []),
        ].join(' · ')
      : undefined
  const planRow = [planLine, usage.readerNote].filter((line): line is string => line !== undefined).join(' · ')
  return (
    <Box flexDirection="column">
      <Text bold>Hugging Face usage</Text>
      <IdentityLine family="huggingface" />
      <Box flexDirection="column" marginTop={1}>
        <SlotHeading text="Sign-in" />
        {account?.kind === 'oauth' ? (
          <Box flexDirection="column">
            <Text dimColor>{shownIdentityWords('huggingface', account.label)}</Text>
            <SlotSpend active route="huggingface" spend={spend} withCost={false} />
          </Box>
        ) : (
          <Text dimColor>{absentSlotLine("/logins huggingface signs in with the Hub's device-code flow")}</Text>
        )}
      </Box>
      <ApiKeySlot
        presentLabel={account?.kind === 'api-key' ? shownIdentityWords('huggingface', account.label) : undefined}
        isActive={account?.kind === 'api-key'}
        route="huggingface"
        spend={spend}
      />
      {account && planRow !== '' ? <Text dimColor>{planRow}</Text> : null}
      {account && (rateLine !== undefined || usage.limited !== undefined) ? (
        <Text dimColor>
          {rateLine !== undefined
            ? `${rateLine}${rateReset !== undefined ? ` · resets ${new Date(rateReset).toLocaleTimeString()}` : ''}`
            : ''}
          {usage.limited !== undefined ? ` A limit is reached — resets ${new Date(usage.limited.resetsAtMs).toLocaleTimeString()}${carryTail(usage)}.` : ''}
        </Text>
      ) : null}
      <Text dimColor>
        {account
          ? `Billing: ${usage.absence ?? ENGINE_USAGE_PRESENTATION.huggingface!.limitsNote}.`
          : `Not connected — ${ENGINE_USAGE_PRESENTATION.huggingface!.connect}.`}
      </Text>
      <Text dimColor>
        {availability.state === 'ready'
          ? `Models: ${availability.modelCount > 0 ? `${availability.modelCount} live via the router catalogue` : (availability.catalogueNote ?? 'catalogue pending')}`
          : `Models: ${availability.liveIds.length > 0 ? `${availability.liveIds.length} live-listed (sign in to select)` : availability.reason}`}
      </Text>
    </Box>
  )
}

function LocalUsageSection(): React.ReactNode {
  const usage = useOwnerUsage('local', true)
  const account = resolveLocalAccount()
  const snapshot = getCachedLocalDiscovery()
  const spend = providerSessionSpend('local')
  const served = useFocusedServedModel()
  const tensorFold = tensorFoldServing(served ?? getEngineModel())
  const tensorFoldLines = tensorFold !== undefined ? [tensorFoldServingLine(tensorFold), ...tensorFoldUsageLines()] : localServerKind(served ?? getEngineModel()) === 'tensorfold' ? tensorFoldUsageLines() : []
  return (
    <Box flexDirection="column">
      <Text bold>Local models usage</Text>
      <IdentityLine family="local" />
      <Box flexDirection="column" marginTop={1}>
        <SlotHeading text="Servers" />
        {account && snapshot ? (
          <Box flexDirection="column">
            {snapshot.servers.map(server => (
              <Text key={`${server.kind}:${server.root}`} dimColor>
                {server.label} · {localServerName({ server: server.kind, ...(server.engine?.servedBy !== undefined ? { servedBy: server.engine.servedBy } : {}) })} at {server.root} · {server.models.length} model
                {server.models.length === 1 ? '' : 's'}
                {server.models.some(m => m.toolsDeclared === false) ? ' · some declare no tool support' : ''}
              </Text>
            ))}
            <SlotSpend active route="local" spend={spend} withCost={false} />
          </Box>
        ) : (
          <Text dimColor>{absentSlotLine(ENGINE_USAGE_PRESENTATION.local!.connect)}</Text>
        )}
      </Box>
      {tensorFoldLines.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <SlotHeading text={TENSORFOLD_USAGE_SLOT} />
          {tensorFoldLines.map((line, index) => <Text key={`tensorfold-${index}`} dimColor>{line}</Text>)}
        </Box>
      ) : null}
      <Text dimColor>
        {account
          ? `${usage.absence ?? 'local · no metering'} — ${account.kind === 'keyless' ? 'keyless' : `key (${account.keySource})`}.`
          : `local · no metering · probes ${snapshot ? `ran ${new Date(snapshot.probedAtMs).toLocaleTimeString()}` : 'pending'}.`}
      </Text>
    </Box>
  )
}

export function rentalUsageLines(rental: NonNullable<ReturnType<typeof hostRentalUsage>>): string[] {
  return [rental.machine, `$${rental.price.toFixed(2)}/hr · ${formatDuration(rental.elapsedMs)} elapsed`, `$${rental.spendUSD.toFixed(2)} so far + storage`]
}

function RentalUsageSection({ rental }: { rental: NonNullable<ReturnType<typeof hostRentalUsage>> }): React.ReactNode {
  const spend = providerSessionSpend('openai-compat')
  return <Box flexDirection="column">
    <Text bold>Custom endpoint usage</Text>
    {rentalUsageLines(rental).map((line, index) => <Text key={index} dimColor>{line}</Text>)}
    <Box flexDirection="column" marginTop={1}>
      <SlotSpend active route="openai-compat" spend={spend} withCost={false} />
    </Box>
  </Box>
}

export function EngineUsageSection({ section, width }: { section: UsageSection; width?: number }): React.ReactNode {
  const usage = useOwnerUsage(section.id, section.family.credentialed)
  const served = useFocusedServedModel()
  const rental = section.id === 'openai-compat' && section.family.credentialed ? hostRentalUsage(served ?? getEngineModel()) : undefined
  if (!section.family.credentialed) {
    return (
      <Box flexDirection="column">
        <Text bold>{section.title}</Text>
        <IdentityLine family={section.id} />
        <Text dimColor>not connected — {section.connect}.</Text>
      </Box>
    )
  }
  if (section.id === 'openai') return <OpenaiUsageSection {...(width !== undefined ? { width } : {})} />
  if (section.id === 'openrouter') return <OpenrouterUsageSection {...(width !== undefined ? { width } : {})} />
  if (section.id === 'gemini') return <GeminiUsageSection {...(width !== undefined ? { width } : {})} />
  if (section.id === 'huggingface') return <HuggingfaceUsageSection />
  if (section.id === 'moonshot') return <MoonshotUsageSection {...(width !== undefined ? { width } : {})} />
  if (section.id === 'zai') return <ZaiUsageSection {...(width !== undefined ? { width } : {})} {...(section.family.credentialLabel !== undefined ? { credentialLabel: section.family.credentialLabel } : {})} />
  if (section.id === 'xai') return <XaiUsageSection {...(width !== undefined ? { width } : {})} />
  if (section.id === 'meta') return <MetaUsageSection {...(width !== undefined ? { width } : {})} />
  if (section.id === 'zen') return <ZenUsageSection {...(width !== undefined ? { width } : {})} {...(section.family.credentialLabel !== undefined ? { credentialLabel: section.family.credentialLabel } : {})} credentialed={section.family.credentialed} />
  if (section.id === 'minimax') return <MinimaxUsageSection {...(width !== undefined ? { width } : {})} {...(section.family.credentialLabel !== undefined ? { credentialLabel: section.family.credentialLabel } : {})} credentialed={section.family.credentialed} />
  if (section.id === 'local') return <LocalUsageSection />
  if (rental) return <RentalUsageSection rental={rental} />
  const spend = providerSessionSpend(section.id)
  return (
    <Box flexDirection="column">
      <Text bold>{section.title}</Text>
      <IdentityLine family={section.id} />
      <Box flexDirection="column" marginTop={1}>
        <SlotHeading text="Subscription" />
        <Text dimColor>{absentSlotLine('this family connects by API key')}</Text>
      </Box>
      <ApiKeySlot
        presentLabel={section.family.credentialLabel}
        isActive={section.family.credentialed}
        route={section.id}
        spend={spend}
      />
      {figuresLine(usage) !== undefined ? <Text dimColor>{figuresLine(usage)}</Text> : null}
      {section.family.credentialed && usage.readerNote !== undefined ? (
        <Text dimColor>{usage.readerNote}</Text>
      ) : null}
      <Text dimColor>
        {section.family.credentialed ? (usage.absence ?? section.limitsNote) : `Not connected — ${section.connect}.`}
      </Text>
    </Box>
  )
}

function MoonshotUsageSection({ width }: { width?: number }): React.ReactNode {
  const account = resolveMoonshotAccount()
  const key = resolveMoonshotApiKey()
  const spend = providerSessionSpend('moonshot')
  const usage = useOwnerUsage('moonshot', account !== undefined)
  const windows = usage.windows
  return (
    <Box flexDirection="column">
      <Text bold>Moonshot usage</Text>
      <IdentityLine family="moonshot" />
      <Box flexDirection="column" marginTop={1}>
        <SlotHeading text="Kimi sign-in" />
        {account?.kind === 'kimi-oauth' ? (
          <Box flexDirection="column">
            <Text dimColor>{account.label}</Text>
            <SlotSpend active route="moonshot" spend={spend} withCost={false} />
            {windows.length > 0 ? (
              windows.map(window => window.usedPct !== undefined ? (
                <ObservedWindowMeter
                  key={window.key}
                  window={window}
                  {...(window.label === '7d' ? { title: 'Current week (7d)' } : {})}
                  {...(width !== undefined ? { maxWidth: width } : {})}
                />
              ) : (
                <Text key={window.key} dimColor>{`${window.label}: no limit stated`}</Text>
              ))
            ) : (
              <Text dimColor>Plan windows: not yet observed — the usage endpoint is asked on this tab.</Text>
            )}
            <FullWindowLine usage={usage} />
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
        route="moonshot"
        spend={spend}
      />
      <Text dimColor>
        {account
          ? ENGINE_USAGE_PRESENTATION.moonshot!.limitsNote
          : `Not connected — ${ENGINE_USAGE_PRESENTATION.moonshot!.connect}.`}
      </Text>
    </Box>
  )
}

function MinimaxUsageSection({ width, credentialLabel, credentialed }: { width?: number; credentialLabel?: string; credentialed: boolean }): React.ReactNode {
  const spend = providerSessionSpend('minimax')
  const usage = useOwnerUsage('minimax', credentialed)
  const windows = usage.windows
  return (
    <Box flexDirection="column">
      <Text bold>MiniMax usage</Text>
      <IdentityLine family="minimax" />
      <Box flexDirection="column" marginTop={1}>
        <SlotHeading text="M Plan" />
        {credentialed && windows.length > 0 ? (
          windows.map(window => window.usedPct !== undefined ? (
            <ObservedWindowMeter key={window.key} window={window} {...(width !== undefined ? { maxWidth: width } : {})} />
          ) : (
            <Text key={window.key} dimColor>{`${window.label}: no limit stated`}</Text>
          ))
        ) : (
          <Text dimColor>{credentialed ? (usage.readerNote ?? 'none stated for this key — the plan endpoint is asked on this tab') : absentSlotLine('an M Plan meters here once its key is stored')}</Text>
        )}
      </Box>
      <ApiKeySlot presentLabel={credentialLabel} isActive={credentialed} route="minimax" spend={spend} />
      <Text dimColor>
        {credentialed ? (usage.absence ?? ENGINE_USAGE_PRESENTATION.minimax!.limitsNote) : `Not connected — ${ENGINE_USAGE_PRESENTATION.minimax!.connect}.`}
      </Text>
    </Box>
  )
}

function ZenUsageSection({ width, credentialLabel, credentialed }: { width?: number; credentialLabel?: string; credentialed: boolean }): React.ReactNode {
  const spend = providerSessionSpend('zen')
  const usage = useOwnerUsage('zen', credentialed)
  const windows = usage.windows
  return (
    <Box flexDirection="column">
      <Text bold>OpenCode Zen usage</Text>
      <IdentityLine family="zen" />
      <Box flexDirection="column" marginTop={1}>
        <SlotHeading text="OpenCode Go plan" />
        {credentialed && windows.length > 0 ? (
          windows.map(window => window.usedPct !== undefined ? (
            <ObservedWindowMeter key={window.key} window={window} {...(width !== undefined ? { maxWidth: width } : {})} />
          ) : (
            <Text key={window.key} dimColor>{`${window.label}: no limit stated`}</Text>
          ))
        ) : (
          <Text dimColor>{credentialed ? (usage.readerNote ?? 'none stated for this key — the usage endpoint is asked on this tab') : absentSlotLine('a Go plan meters here once its key is stored')}</Text>
        )}
      </Box>
      <ApiKeySlot presentLabel={credentialLabel} isActive={credentialed} route="zen" spend={spend} />
      <Text dimColor>
        {credentialed ? (usage.absence ?? ENGINE_USAGE_PRESENTATION.zen!.limitsNote) : `Not connected — ${ENGINE_USAGE_PRESENTATION.zen!.connect}.`}
      </Text>
    </Box>
  )
}

function XaiUsageSection({ width }: { width?: number }): React.ReactNode {
  const account = resolveXaiAccount()
  const key = resolveXaiApiKey()
  const subscription = account?.kind === 'grok-subscription'
  const spend = providerSessionSpend('xai')
  const usage = useOwnerUsage('xai', account !== undefined)
  const windows = usage.windows
  const figures = figuresLine(usage)
  return (
    <Box flexDirection="column">
      <Text bold>xAI usage</Text>
      <IdentityLine family="xai" />
      <Box flexDirection="column" marginTop={1}>
        <SlotHeading text="Grok subscription" />
        {subscription ? (
          <Box flexDirection="column">
            <Text dimColor>{[account.label, usage.tier !== account.label ? usage.tier : undefined].filter((part): part is string => part !== undefined).join(' · ')}</Text>
            <SlotSpend active route="xai" spend={spend} withCost={false} />
            {usage.absence !== undefined ? (
              <Text dimColor>{usage.absence}</Text>
            ) : windows.length > 0 ? (
              windows.map(window => (
                <ObservedWindowMeter
                  key={window.key}
                  window={window}
                  {...(width !== undefined ? { maxWidth: width } : {})}
                />
              ))
            ) : (
              <Text dimColor>{usage.readerNote ?? 'Included pool: not yet observed — the Grok pool endpoint is asked on this tab.'}</Text>
            )}
            {windows.length > 0 && usage.readerNote !== undefined ? <Text dimColor>{usage.readerNote}</Text> : null}
            <FullWindowLine usage={usage} />
          </Box>
        ) : (
          <Text dimColor>{absentSlotLine('/logins xai signs in with a device code')}</Text>
        )}
      </Box>
      <ApiKeySlot
        presentLabel={key ? (key.source === 'env' ? 'XAI_API_KEY (env)' : 'xAI API key (stored, auth-scoped)') : undefined}
        isActive={account?.kind === 'api-key'}
        route="xai"
        spend={spend}
      />
      {!subscription && figures !== undefined ? <Text dimColor>{figures}</Text> : null}
      {!subscription && account !== undefined && usage.readerNote !== undefined ? <Text dimColor>{usage.readerNote}</Text> : null}
      <Text dimColor>
        {account === undefined
          ? `Not connected — ${ENGINE_USAGE_PRESENTATION.xai!.connect}.`
          : subscription
            ? ENGINE_USAGE_PRESENTATION.xai!.limitsNote
            : (usage.absence ?? ENGINE_USAGE_PRESENTATION.xai!.limitsNote)}
      </Text>
    </Box>
  )
}

function MetaUsageSection({ width }: { width?: number }): React.ReactNode {
  const account = resolveMetaAccount()
  const key = resolveMetaRawApiKey()
  const subscription = account?.kind === 'muse-code'
  const spend = providerSessionSpend('meta')
  const usage = useOwnerUsage('meta', account !== undefined)
  const planUsage = metaMuseCodeUsage(spend)
  const windows = planUsage?.windows ?? []
  const facts = liveMetaConnectFacts()
  const storedNote = metaStoredSourcesNote(facts)
  const tierWithAge = metaMuseCodeTierWordsWithAge(facts)
  return (
    <Box flexDirection="column">
      <Text bold>Meta usage</Text>
      <IdentityLine family="meta" />
      <Box flexDirection="column" marginTop={1}>
        <SlotHeading text="Muse Code subscription" />
        {planUsage !== undefined ? (
          <Box flexDirection="column">
            <Text dimColor>{[facts.museCodeEmail ? shownIdentityWords('meta', facts.museCodeEmail) : undefined, tierWithAge].filter((part): part is string => part !== undefined && part !== '').join(' · ')}</Text>
            {!subscription ? <Text dimColor>not active — ↵ on its /logins row makes it active</Text> : null}
            <SlotSpend active={subscription} route="meta" spend={spend} withCost={false} />
            {windows.length > 0 ? (
              windows.map(window => (
                <ObservedWindowMeter
                  key={window.key}
                  window={window}
                  {...(width !== undefined ? { maxWidth: width } : {})}
                />
              ))
            ) : (
              <Text dimColor>{planUsage.readerNote ?? (subscription ? 'Plan windows: not yet observed — the key endpoint is asked on this tab.' : planUsage.absence)}</Text>
            )}
            {windows.length > 0 && planUsage.readerNote !== undefined ? <Text dimColor>{planUsage.readerNote}</Text> : null}
            <FullWindowLine usage={planUsage} />
          </Box>
        ) : (
          <Text dimColor>{absentSlotLine('/logins meta signs in with a device code')}</Text>
        )}
      </Box>
      <ApiKeySlot
        presentLabel={key ? (key.source === 'env' ? `${key.envName!} (env)` : 'Meta API key (stored, auth-scoped)') : undefined}
        isActive={account?.kind === 'api-key'}
        route="meta"
        spend={spend}
      />
      {storedNote !== undefined ? <Text dimColor>{storedNote}</Text> : null}
      <Text dimColor>
        {account === undefined
          ? `Not connected — ${ENGINE_USAGE_PRESENTATION.meta!.connect}.`
          : subscription
            ? ENGINE_USAGE_PRESENTATION.meta!.limitsNote
            : (usage.absence ?? ENGINE_USAGE_PRESENTATION.meta!.limitsNote)}
      </Text>
    </Box>
  )
}

function ZaiUsageSection({ width, credentialLabel }: { width?: number; credentialLabel?: string }): React.ReactNode {
  const account = zaiAccountFacts()
  const coding = account?.plan === 'coding'
  const spend = providerSessionSpend('zai')
  const usage = useOwnerUsage('zai', account !== undefined)
  const windows = usage.windows
  const figures = figuresLine(usage)
  return (
    <Box flexDirection="column">
      <Text bold>Z.AI usage</Text>
      <IdentityLine family="zai" />
      <Box flexDirection="column" marginTop={1}>
        <SlotHeading text="GLM Coding Plan" />
        {coding ? (
          <Box flexDirection="column">
            <Text dimColor>{[credentialLabel ?? 'GLM Coding Plan key', usage.tier].filter((part): part is string => part !== undefined).join(' · ')}</Text>
            <SlotSpend active route="zai" spend={spend} withCost={false} />
            {usage.absence !== undefined ? (
              <Text dimColor>{usage.absence}</Text>
            ) : windows.length > 0 ? (
              windows.map(window => (
                <ObservedWindowMeter
                  key={window.key}
                  window={window}
                  {...(window.label === '7d' ? { title: 'Current week (7d)' } : {})}
                  {...(width !== undefined ? { maxWidth: width } : {})}
                />
              ))
            ) : (
              <Text dimColor>{usage.readerNote ?? 'Plan windows: not yet observed — the quota endpoint is asked on this tab.'}</Text>
            )}
            {windows.length > 0 && usage.readerNote !== undefined ? <Text dimColor>{usage.readerNote}</Text> : null}
            <FullWindowLine usage={usage} />
            {figures !== undefined ? <Text dimColor>{figures}</Text> : null}
          </Box>
        ) : (
          <Text dimColor>{absentSlotLine('/logins zai adds a GLM Coding Plan key')}</Text>
        )}
      </Box>
      <ApiKeySlot
        presentLabel={!coding && account !== undefined ? credentialLabel ?? 'Z.AI API key' : undefined}
        isActive={!coding && account !== undefined}
        route="zai"
        spend={spend}
      />
      <Text dimColor>
        {account === undefined
          ? `Not connected — ${ENGINE_USAGE_PRESENTATION.zai!.connect}.`
          : coding
            ? ENGINE_USAGE_PRESENTATION.zai!.limitsNote
            : (usage.absence ?? ENGINE_USAGE_PRESENTATION.zai!.limitsNote)}
      </Text>
    </Box>
  )
}
