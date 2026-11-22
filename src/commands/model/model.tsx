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
import { notBuilt } from '../../pi/holes.js'

function renderModelLabel(setting: ModelSetting): string {
  if (setting === null) return renderDefaultModelLabel()
  return renderDefaultModelSetting(setting)
}

function effortParenthetical(
  base: ModelSetting,
  override: ModelSetting,
  effortValue: EffortValue | undefined,
): string {
  return notBuilt('src/commands/model/model.tsx:51')
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
  return notBuilt('src/commands/model/model.tsx:120')
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args?: string,
  typed?: string,
): Promise<React.ReactNode | undefined> {
  return notBuilt('src/commands/model/model.tsx:337')
}
