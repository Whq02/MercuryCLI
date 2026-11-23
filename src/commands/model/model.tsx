import * as React from 'react'
import { useRef, useState } from 'react'
import { useLoad, useMount } from '../../hooks/effects.js'
import { TransitionPreviewCard } from '../../components/TransitionPreviewCard.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import { COMMON_HELP_ARGS, COMMON_INFO_ARGS } from '../../constants/xml.js'
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../../types/command.js'
import type { Message } from '../../types/message.js'
import { usabilityForRoute } from '../../services/providers/providerUsability.js'
import { requestCommandDispatch } from '../../utils/cockpit/helmFocus.js'
import {
  previewForSelection,
  reconfirmTransitionPlan,
  transitionPlanSummary,
} from '../../services/providers/transitionPreview.js'
import {
  crossProviderNote,
  providerFamilyOfSetting,
  seatWithFold,
  settleModelSelection,
  type SeatReceiptState,
  type SettledSelection,
  type TransitionPlan,
} from '../../services/model/modelTransition.js'
import { isModelAlias } from '../../utils/model/aliases.js'
import { isModelAllowed } from '../../services/model/modelAllowlist.js'
import { isModelFromDisabledProvider, isProviderDisabled } from '../../services/providers/disabledProviders.js'
import { BARE_FAMILY_WORDS } from '../../services/model/bareFamilyWords.js'
import { validateModel } from '../../services/providers/validateModel.js'
import { checkOpus1mAccess, checkSonnet1mAccess } from '../../utils/model/check1mAccess.js'
import {
  getDefaultEngineModel,
  isOpus1mMergeEnabled,
  parseUserSpecifiedModel,
  renderDefaultModelLabel,
  renderDefaultModelSetting,
  renderModelName,
  type ModelSetting,
} from '../../services/model/model.js'
import { resolveEffortTruth, type EffortValue } from '../../utils/effort.js'
import { errorMessage } from '../../utils/errors.js'
import { getFocusedSessionConnector } from '../../services/engine-connector/focusedConnector.js'
import type { ModelSwitchReceiptV1 } from '../../services/engine-connector/types.js'
import { persistModelChoice } from './persistModelChoice.js'

function renderModelLabel(setting: ModelSetting): string {
  if (setting === null) return renderDefaultModelLabel()
  return renderDefaultModelSetting(setting)
}

function effortParenthetical(
  base: ModelSetting,
  override: ModelSetting,
  effortValue: EffortValue | undefined,
): string {
  const effective = override ?? base ?? getDefaultEngineModel()
  const resolvedModel = parseUserSpecifiedModel(effective)
  const truth = resolveEffortTruth(resolvedModel, effortValue)
  if (truth.requested === undefined) return ''
  if (!truth.supportsEffort) {
    return ` (effort: ${truth.requested} — ${resolvedModel} takes no effort setting)`
  }
  if (truth.wire === undefined) {
    return ` (effort: ${truth.requested} — not sent; the provider default applies)`
  }
  if (truth.adjustedFrom !== undefined || truth.wire !== String(truth.requested)) {
    return ` (effort: ${truth.requested} — runs at ${truth.label})`
  }
  return ` (effort: ${truth.requested})`
}

function focusedSwitchSentence(receipt: ModelSwitchReceiptV1, target: ModelSetting, saved: string): string {
  const label = renderModelLabel(target)
  switch (receipt.state) {
    case 'applied':
      return `Model set to ${label}${saved} — this session's next message runs it${receipt.note !== undefined ? ` (${receipt.note})` : ''}`
    case 'queued':
      return `Model switch queued: ${label}${saved} — takes effect when this session's turn settles, the running turn keeps its model`
    case 'no-op':
      return saved === '' ? `Already on ${label} — nothing to change.` : `Already on ${label}${saved}.`
    default:
      return `The model switch was refused: ${receipt.detail}`
  }
}

function ModelReadout({ onDone }: { onDone: LocalJSXCommandOnDone }): React.ReactNode {
  const base = useAppState(state => state.engineModel)
  const override = useAppState(state => state.engineModelForSession)
  const effortValue = useAppState(state => state.effortValue)
  const ranRef = useRef(false)
  useMount(() => {
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
          `Current model: ${renderModelLabel(override)} (session override)`,
          `Base model: ${renderModelLabel(base)}${parenthetical}`,
        ].join('\n'),
      )
      return
    }
    onDone(`Current model: ${renderModelLabel(base)}${parenthetical}`)
  })
  return null
}

export function previewDaemonModelSelection(target: ModelSetting): { plan: TransitionPlan } | { reason: string } | null {
  const focused = getFocusedSessionConnector()
  if (focused.carrier !== 'daemon') return null
  const facts = focused.modelFacts()
  if (facts.effectiveSource === 'ambient') {
    return {
      reason:
        "The model switch was refused: the session's own model facts could not be resolved (no live facts and no recorded model on its admission record) — the preview will not be built from another session's state. Retry once the session reports its facts.",
    }
  }
  return {
    plan: previewForSelection([...focused.records()], facts.effective, target),
  }
}

type HeldTransitionConfirm = {
  plan: TransitionPlan
  refreshed: boolean
  fromLabel: string
  toLabel: string
}

function ModelDirectSet({
  target,
  typed,
  words,
  messages,
  onDone,
}: {
  target: ModelSetting
  typed: string
  words: string | undefined
  messages: Message[]
  onDone: LocalJSXCommandOnDone
}): React.ReactNode {
  const base = useAppState(state => state.engineModel)
  const override = useAppState(state => state.engineModelForSession)
  const effortValue = useAppState(state => state.effortValue)
  const foregroundTurnActive = useAppState(state => state.foregroundTurnActive)
  const pendingModelSwitch = useAppState(state => state.pendingModelSwitch)
  const setAppState = useSetAppState()
  const [confirm, setConfirm] = useState<HeldTransitionConfirm | null>(null)
  const startedRef = useRef(false)

  function applySwitch(seated?: (state: SeatReceiptState) => void): void {
    const focused = getFocusedSessionConnector()
    if (focused.carrier === 'daemon') {
      const factsBefore = focused.modelFacts()
      const messagesBefore = [...focused.records()]
      const choice = persistModelChoice(target)
      void focused.setModel(target, words, choice.replacedDefault ?? undefined).then(
        receipt => {
          if (receipt.state === 'refused') {
            choice.restore()
            onDone(focusedSwitchSentence(receipt, target, ''))
            seated?.(receipt.state)
            return
          }
          const baseSentence = focusedSwitchSentence(receipt, target, choice.sentence)
          if (receipt.state === 'no-op') {
            onDone(baseSentence)
            seated?.(receipt.state)
            return
          }
          const cross =
            providerFamilyOfSetting(factsBefore.effective) !== providerFamilyOfSetting(target)
              ? crossProviderNote(target)
              : ''
          const plan = previewForSelection(messagesBefore, factsBefore.effective, target)
          const lossNote = transitionPlanSummary(plan)
          const effortNote = effortParenthetical(target, null, effortValue)
          onDone(`${baseSentence}${cross}${lossNote}${effortNote}`)
          seated?.(receipt.state)
        },
        thrown => {
          choice.restore()
          onDone(`The model switch was refused: ${errorMessage(thrown)}`)
          seated?.('refused')
        },
      )
      return
    }

    const turnActive = foregroundTurnActive || pendingModelSwitch !== null
    const settled: SettledSelection = settleModelSelection(
      {
        engineModel: base,
        engineModelForSession: override,
        pendingModelSwitch,
      },
      target,
      { turnActive },
    )
    const choice = persistModelChoice(target)
    const label = renderModelLabel(target)
    const saved = choice.sentence
    if (settled.kind === 'no-op') {
      onDone(saved === '' ? `Already on ${label} — nothing to change.` : `Already on ${label}${saved}.`)
      return
    }
    if (settled.kind === 'cancelled-pending') {
      setAppState(prev => ({ ...prev, ...settled.patch }))
      onDone(`Already on ${label} — cancelled the previously queued model switch${saved}.`)
      return
    }
    const effectiveFrom = override ?? base
    const plan = previewForSelection(messages, effectiveFrom, target)
    const lossNote = transitionPlanSummary(plan)
    const effortNote = effortParenthetical(target, null, effortValue)
    setAppState(prev => ({ ...prev, ...settled.patch }))
    if (settled.kind === 'queued') {
      const cross = settled.crossProvider ? crossProviderNote(target) : ''
      onDone(
        `Model switch queued: ${label}${saved} — takes effect when the current turn settles, the running turn keeps its model.${cross}${lossNote}${effortNote}`,
      )
      return
    }
    const cross = settled.receipt.crossProvider ? crossProviderNote(target) : ''
    onDone(`Model set to ${label}${saved}${cross}${lossNote}${effortNote}`)
  }

  useLoad(signal => {
    if (startedRef.current) return
    startedRef.current = true
    void (async () => {
      try {
        const lowerTyped = typed.toLowerCase()
        const disabledFamily = BARE_FAMILY_WORDS.some(entry => entry.word === lowerTyped && isProviderDisabled(entry.route))
        if (disabledFamily || isModelFromDisabledProvider(target)) {
          onDone(`Model ${typed} not found.`, { display: 'system' })
          return
        }
        if (target !== null) {
          if (!isModelAllowed(target)) {
            onDone(`${typed} isn't available: your organization restricts model selection.`, { display: 'system' })
            return
          }
          const opusLocked = lowerTyped.includes('opus') && lowerTyped.includes('[1m]') && !checkOpus1mAccess() && !isOpus1mMergeEnabled()
          const sonnetLocked = (lowerTyped.includes('sonnet[1m]') || lowerTyped.includes('sonnet-4-6[1m]')) && !checkSonnet1mAccess()
          if (opusLocked || sonnetLocked) {
            onDone(`The 1M-context ${renderModelName(target)} model isn't available for this account. Run /model to pick a different model.`, { display: 'system' })
            return
          }
          if (!isModelAlias(target.toLowerCase())) {
            const verdict = await validateModel(target)
            if (signal.aborted) return
            if (!verdict.valid) {
              onDone(verdict.error ?? `Model ${typed} not found.`, { display: 'system' })
              return
            }
          }
        }
        if (signal.aborted) return
        const daemonPreview = previewDaemonModelSelection(target)
        if (daemonPreview !== null) {
          if ('reason' in daemonPreview) {
            onDone(daemonPreview.reason, { display: 'system' })
            return
          }
          if (daemonPreview.plan.needsChoice) {
            const facts = getFocusedSessionConnector().modelFacts()
            setConfirm({
              plan: daemonPreview.plan,
              refreshed: false,
              fromLabel: renderModelLabel(facts.effective),
              toLabel: target === null ? renderDefaultModelLabel() : renderModelName(target),
            })
            return
          }
          applySwitch()
          return
        }
        const effectiveFrom = override ?? base
        const turnActive = foregroundTurnActive || pendingModelSwitch !== null
        const probe = settleModelSelection(
          {
            engineModel: base,
            engineModelForSession: override,
            pendingModelSwitch,
          },
          target,
          { turnActive },
        )
        if (probe.kind === 'queued' || probe.kind === 'applied') {
          const plan = previewForSelection(messages, effectiveFrom, target)
          if (plan.needsChoice) {
            setConfirm({
              plan,
              refreshed: false,
              fromLabel: renderModelLabel(effectiveFrom),
              toLabel: target === null ? renderDefaultModelLabel() : renderModelName(target),
            })
            return
          }
        }
        applySwitch()
      } catch (thrown) {
        if (signal.aborted) return
        onDone(`Model validation failed: ${errorMessage(thrown)}`, { display: 'system' })
      }
    })()
  }, [])

  if (confirm !== null) {
    const held = confirm
    return (
      <TransitionPreviewCard
        plan={held.plan}
        targetUsability={usabilityForRoute(held.plan.targetRoute)}
        fromLabel={held.fromLabel}
        toLabel={held.toLabel}
        refreshed={held.refreshed}
        onConfirm={() => {
          const focused = getFocusedSessionConnector()
          const confirmMessages = focused.carrier === 'daemon' ? [...focused.records()] : messages
          const verdict = reconfirmTransitionPlan(held.plan, confirmMessages)
          if (!verdict.ok) {
            setConfirm({ ...held, plan: verdict.freshPlan, refreshed: true })
            return
          }
          setConfirm(null)
          if (held.plan.window?.fits === false) {
            seatWithFold(focused, held.plan.targetRoute, seated => applySwitch(seated), requestCommandDispatch)
            return
          }
          applySwitch()
        }}
        onCancel={() => {
          setConfirm(null)
          onDone(`Kept ${held.fromLabel} — the model switch was cancelled at the preview.`)
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
  typed?: string,
): Promise<React.ReactNode | undefined> {
  const trimmed = (args ?? '').trim()
  if (trimmed === '') return undefined
  const lowered = trimmed.toLowerCase()
  if (COMMON_INFO_ARGS.includes(lowered)) {
    return <ModelReadout onDone={onDone} />
  }
  if (COMMON_HELP_ARGS.includes(lowered)) {
    onDone('Run /model with no argument to open the model selection menu, or /model <modelName> to set the model directly.', { display: 'system' })
    return null
  }
  const target: ModelSetting = trimmed === 'default' ? null : trimmed
  const trimmedTyped = typed?.trim()
  const words = trimmedTyped !== undefined && trimmedTyped !== '' ? trimmedTyped : undefined
  return (
    <ModelDirectSet
      target={target}
      typed={words ?? trimmed}
      words={words}
      messages={context.messages ?? []}
      onDone={onDone}
    />
  )
}
