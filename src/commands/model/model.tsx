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
    return ` (effort: ${truth.requested} — model takes no effort)`
  }
  if (truth.applied === undefined) {
    return ` (effort: ${truth.requested} — provider default applies)`
  }
  if (truth.adjustedFrom !== undefined) {
    return ` (effort: ${truth.requested}, runs at ${truth.label})`
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
      reason: "Cannot switch models right now — the session's own model facts could not be resolved.",
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
          onDone(`Failed to switch model: ${errorMessage(thrown)}`)
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
      onDone(`Already on ${label} — queued switch cancelled${saved}.`)
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
        `Model switch queued: ${label}${saved} — takes effect when the current turn settles, the running turn keeps its model${cross}${lossNote}${effortNote}`,
      )
      return
    }
    const cross = settled.receipt.crossProvider ? crossProviderNote(target) : ''
    onDone(`Model set to ${label}${saved}${cross}${lossNote}${effortNote}`)
  }

  useLoad(() => {
    if (startedRef.current) return
    startedRef.current = true
    let cancelled = false
    void (async () => {
      try {
        if (target !== null) {
          if (isModelFromDisabledProvider(target)) {
            onDone(`Model not found — ${typed}`, { display: 'system' })
            return
          }
          if (!isModelAllowed(target)) {
            onDone(`Model "${typed}" is not in the list of available models.`, { display: 'system' })
            return
          }
          const lowerTarget = target.toLowerCase()
          if (lowerTarget.includes('[1m]')) {
            if (lowerTarget.includes('opus') && !checkOpus1mAccess() && !isOpus1mMergeEnabled()) {
              onDone('1M context window is not available for Opus on this account.', { display: 'system' })
              return
            }
            if (lowerTarget.includes('sonnet') && !checkSonnet1mAccess()) {
              onDone('1M context window is not available for Sonnet on this account.', { display: 'system' })
              return
            }
          }
          if (!isModelAlias(lowerTarget)) {
            const verdict = await validateModel(target)
            if (cancelled) return
            if (!verdict.valid) {
              onDone(verdict.error ?? `Model "${typed}" could not be validated.`, { display: 'system' })
              return
            }
          }
        }
        if (cancelled) return
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
        if (cancelled) return
        onDone(`Failed to validate model: ${errorMessage(thrown)}`, { display: 'system' })
      }
    })()
    return () => {
      cancelled = true
    }
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
    const families = BARE_FAMILY_WORDS.filter(entry => !isProviderDisabled(entry.route)).map(entry => entry.word)
    onDone(
      [
        'Usage: /model [model-name | default | info | help]',
        '  /model             Open the interactive model picker',
        '  /model <name>      Switch to a model alias or ID (e.g. sonnet, opus, default)',
        ...(families.length > 0 ? [`  Family aliases:    ${families.join(', ')}`] : []),
        '  /model info        Show the current model and effort level',
      ].join('\n'),
      { display: 'system' },
    )
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
