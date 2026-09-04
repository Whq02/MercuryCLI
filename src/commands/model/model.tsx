import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { TransitionPreviewCard } from '../../components/TransitionPreviewCard.js'
import { useAppState, useAppStateStore, useSetAppState } from '../../state/AppState.js'
import { COMMON_HELP_ARGS, COMMON_INFO_ARGS } from '../../constants/xml.js'
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../../types/command.js'
import type { Message } from '../../types/message.js'
import { usabilityForRoute } from '../../services/providers/providerUsability.js'
import {
  previewForSelection,
  reconfirmTransitionPlan,
  transitionPlanSummary,
} from '../../services/providers/transitionPreview.js'
import {
  crossProviderNote,
  providerFamilyOfSetting,
  settleModelSelection,
  type SettledSelection,
  type TransitionPlan,
} from '../../utils/model/modelTransition.js'
import { isModelAlias } from '../../utils/model/aliases.js'
import { isModelAllowed } from '../../utils/model/modelAllowlist.js'
import { validateModel } from '../../utils/model/validateModel.js'
import { checkOpus1mAccess, checkSonnet1mAccess } from '../../utils/model/check1mAccess.js'
import {
  getDefaultMainLoopModel,
  isOpus1mMergeEnabled,
  parseUserSpecifiedModel,
  renderDefaultModelLabel,
  renderDefaultModelSetting,
  renderModelName,
  type ModelSetting,
} from '../../utils/model/model.js'
import { resolveEffortTruth, type EffortValue } from '../../utils/effort.js'
import { errorMessage } from '../../utils/errors.js'
import { getFocusedSessionConnector } from '../../services/engine-connector/focusedConnector.js'
import type { ModelSwitchReceiptV1 } from '../../services/engine-connector/types.js'

function renderModelLabel(setting: ModelSetting): string {
  if (setting === null) return renderDefaultModelLabel()
  return renderDefaultModelSetting(setting)
}

function effortParenthetical(
  base: ModelSetting,
  override: ModelSetting,
  effortValue: EffortValue | undefined,
): string {
  if (effortValue === undefined) return ''
  const requested = String(effortValue)
  const liveSetting = override ?? base
  const normalised =
    liveSetting === null ? getDefaultMainLoopModel() : parseUserSpecifiedModel(liveSetting)
  if (normalised) {
    const truth = resolveEffortTruth(normalised, effortValue)
    if (!truth.supportsEffort) {
      return ` (effort: ${requested} — not sent; ${renderModelName(normalised)} takes no effort setting)`
    }
    if (truth.wire === undefined) {
      return ` (effort: ${requested} — not sent; the provider default applies)`
    }
    if (truth.label !== requested) {
      return ` (effort: ${requested} — runs at ${truth.label})`
    }
  }
  return ` (effort: ${requested})`
}

function focusedSwitchSentence(receipt: ModelSwitchReceiptV1, target: ModelSetting): string {
  const label = renderModelLabel(target)
  switch (receipt.state) {
    case 'applied':
      return `Model set to ${label} — this session's next message runs it${receipt.note !== undefined ? ` (${receipt.note})` : ''}`
    case 'queued':
      return `Model switch queued: ${label} takes effect when this session's turn settles — the running turn keeps its model`
    case 'no-op':
      return `Already on ${label} — nothing to change.`
    default:
      return `The model switch was refused: ${receipt.detail}`
  }
}

function ModelReadout({ onDone }: { onDone: LocalJSXCommandOnDone }): React.ReactNode {
  const base = useAppState(state => state.mainLoopModel)
  const override = useAppState(state => state.mainLoopModelForSession)
  const effortValue = useAppState(state => state.effortValue)
  const ranRef = useRef(false)
  useEffect(() => {
    if (ranRef.current) return
    ranRef.current = true
    const focused = getFocusedSessionConnector()
    if (focused.carrier === 'daemon') {
      const facts = focused.modelFacts()
      const pending = facts.pendingSwitch ? ` (switching to ${renderModelLabel(facts.pendingSwitch.setting)} when this turn ends)` : ''
      onDone(`Current model: ${renderModelLabel(facts.effective)}${pending}`)
      return
    }
    const parenthetical = effortParenthetical(base, override, effortValue)
    if (override !== null) {
      onDone(
        [
          `Current model: ${renderModelLabel(override)} (session override from strategy mode)`,
          `Base model: ${renderModelLabel(base)}${parenthetical}`,
        ].join('\n'),
      )
      return
    }
    onDone(`Current model: ${renderModelLabel(base)}${parenthetical}`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return null
}

function ModelSet({
  target,
  raw,
  messages,
  onDone,
}: {
  target: ModelSetting
  raw: string
  messages: Message[]
  onDone: LocalJSXCommandOnDone
}): React.ReactNode {
  const base = useAppState(state => state.mainLoopModel)
  const override = useAppState(state => state.mainLoopModelForSession)
  const pendingSwitch = useAppState(state => state.pendingModelSwitch)
  const turnRunning = useAppState(state => state.foregroundTurnActive)
  const setAppState = useSetAppState()
  const store = useAppStateStore()
  const [held, setHeld] = useState<{ plan: TransitionPlan; refreshed: boolean } | null>(null)
  const ranRef = useRef(false)

  const settlementMessage = (
    landed: SettledSelection,
    plan: TransitionPlan | null,
  ): string => {
    const label = renderModelLabel(target)
    if (landed.kind === 'no-op') {
      return `Already on ${label} — nothing to change.`
    }
    if (landed.kind === 'cancelled-pending') {
      return `Already on ${label} — cancelled the previously queued model switch.`
    }
    const lossNote = plan ? transitionPlanSummary(plan) : ''
    if (landed.kind === 'queued') {
      const cross = landed.crossProvider ? crossProviderNote(target) : ''
      return `Model switch queued: ${label} takes effect when the current turn settles — the running turn keeps its model.${cross}${lossNote}`
    }
    const cross = landed.receipt.crossProvider ? crossProviderNote(target) : ''
    return `Model set to ${label}${cross}${lossNote}`
  }

  const applyNow = async (plan: TransitionPlan | null): Promise<void> => {
    const focused = getFocusedSessionConnector()
    if (focused.carrier === 'daemon') {
      const factsBefore = focused.modelFacts()
      const receipt = await focused.setModel(target)
      const moved = receipt.state === 'applied' || receipt.state === 'queued'
      const doorCross =
        moved && providerFamilyOfSetting(factsBefore.effective) !== providerFamilyOfSetting(target)
          ? crossProviderNote(target)
          : ''
      const lossNote = plan && receipt.state !== 'no-op' && receipt.state !== 'refused' ? transitionPlanSummary(plan) : ''
      onDone(`${focusedSwitchSentence(receipt, target)}${doorCross}${lossNote}`)
      return
    }
    let landed = {
      kind: 'no-op',
      patch: null,
      receipt: null,
    } as SettledSelection
    setAppState(prev => {
      landed = settleModelSelection(prev, target, {
        turnActive: prev.foregroundTurnActive || prev.pendingModelSwitch !== null,
      })
      return landed.patch ? { ...prev, ...landed.patch } : prev
    })
    onDone(settlementMessage(landed, plan))
  }

  useEffect(() => {
    if (ranRef.current) return
    ranRef.current = true
    void (async () => {
      if (target !== null && !isModelAllowed(target)) {
        onDone(
          `${raw} isn't available: your organization restricts model selection.`,
          { display: 'system' },
        )
        return
      }
      const lowered = raw.trim().toLowerCase()
      if (target !== null) {
        if (
          lowered.includes('opus') &&
          lowered.includes('[1m]') &&
          !checkOpus1mAccess() &&
          !isOpus1mMergeEnabled()
        ) {
          onDone(
            `The 1M-context ${renderModelName(target)} model isn't available for this account. Run /model to pick a different model.`,
            { display: 'system' },
          )
          return
        }
        if (
          (lowered.includes('sonnet[1m]') || lowered.includes('sonnet-4-6[1m]')) &&
          !checkSonnet1mAccess()
        ) {
          onDone(
            `The 1M-context ${renderModelName(target)} model isn't available for this account. Run /model to pick a different model.`,
            { display: 'system' },
          )
          return
        }
        if (!isModelAlias(lowered)) {
          try {
            const verdict = await validateModel(raw)
            if (!verdict.valid) {
              onDone(verdict.error ?? `Model ${raw} not found.`, { display: 'system' })
              return
            }
          } catch (thrown) {
            onDone(`Model validation failed: ${errorMessage(thrown)}`, {
              display: 'system',
            })
            return
          }
        }
      }
      const focusedForPlan = getFocusedSessionConnector()
      if (focusedForPlan.carrier === 'daemon') {
        const sessionFacts = focusedForPlan.modelFacts()
        if (sessionFacts.effectiveSource === 'ambient') {
          onDone(
            "The model switch was refused: the session's own model facts could not be resolved (no live facts and no recorded model on its admission record) — the preview will not be built from another session's state. Retry once the session reports its facts.",
            { display: 'system' },
          )
          return
        }
        const sessionMessages = [...focusedForPlan.records()]
        const plan = previewForSelection(sessionMessages, sessionFacts.effective, target)
        if (plan.needsChoice) {
          setHeld({ plan, refreshed: false })
          return
        }
        void applyNow(plan)
        return
      }
      const probe = settleModelSelection(
        {
          mainLoopModel: base,
          mainLoopModelForSession: override,
          pendingModelSwitch: pendingSwitch,
        },
        target,
        {
          turnActive: turnRunning || pendingSwitch !== null,
        },
      )
      if (probe.kind === 'queued' || probe.kind === 'applied') {
        const plan = previewForSelection(messages, override ?? base, target)
        if (plan.needsChoice) {
          setHeld({ plan, refreshed: false })
          return
        }
        void applyNow(plan)
        return
      }
      void applyNow(null)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (held) {
    const heldIsDaemon = getFocusedSessionConnector().carrier === 'daemon'
    const effective = override ?? base
    return (
      <TransitionPreviewCard
        plan={held.plan}
        fromLabel={renderModelLabel(heldIsDaemon ? held.plan.from : effective)}
        toLabel={renderModelLabel(target)}
        refreshed={held.refreshed}
        targetUsability={usabilityForRoute(held.plan.targetRoute)}
        onConfirm={() => {
          const confirmMessages =
            getFocusedSessionConnector().carrier === 'daemon'
              ? [...getFocusedSessionConnector().records()]
              : messages
          const verdict = reconfirmTransitionPlan(held.plan, confirmMessages)
          if (!verdict.ok) {
            setHeld({ plan: verdict.freshPlan, refreshed: true })
            return
          }
          setHeld(null)
          void applyNow(held.plan)
        }}
        onCancel={() => {
          setHeld(null)
          onDone(
            `Kept ${renderModelLabel(effective)} — the model switch was cancelled at the preview.`,
          )
        }}
      />
    )
  }
  return null
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args?: string,
): Promise<React.ReactNode | undefined> {
  const trimmed = (args ?? '').trim()
  if (!trimmed) return undefined
  const lowered = trimmed.toLowerCase()
  if (COMMON_INFO_ARGS.includes(lowered)) {
    return <ModelReadout onDone={onDone} />
  }
  if (COMMON_HELP_ARGS.includes(lowered)) {
    onDone(
      'Run /model with no argument to open the model selection menu, or /model <modelName> to set the model directly.',
      { display: 'system' },
    )
    return undefined
  }
  return (
    <ModelSet
      target={trimmed === 'default' ? null : trimmed}
      raw={trimmed}
      messages={context.messages ?? []}
      onDone={onDone}
    />
  )
}
