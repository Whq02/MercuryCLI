import React, { useCallback, useMemo, useState } from 'react'
import { exitChordNoticeText } from './PromptInput/ExitChordNotice.js'
import { Box, Text, useInput } from '../ink.js'
import { Select } from './CustomSelect/index.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { useAppState, useSetAppState } from '../state/AppState.js'
import type { AppState } from '../state/AppStateStore.js'
import {
  type ModelOption,
  focusedOptionSupports1m,
  getModelOptions,
  isCatalogueDoorRow,
  isProviderActionRow,
  resolvesToExistingOption,
  stripContext1m,
  withContext1m,
} from '../services/model/modelOptions.js'
import { getPublicModelDisplayName } from '../services/model/model.js'
import {
  type EffortLevel,
  type EffortValue,
  cycleSelectableEffort,
  getDefaultEffortForModel,
  getInitialEffortSetting,
  resolveEffortTruth,
  resolvePickerEffortPersistence,
  toPersistableEffort,
  unpinAllLaunchEffort,
} from '../utils/effort.js'
import { modelSupportsEffort } from '../utils/model/capabilities.js'
import { updateSettingsForSource } from '../utils/settings/settings.js'
import { useExitOnCtrlCDWithKeybindings } from '../hooks/useExitOnCtrlCDWithKeybindings.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'

const VISIBLE_OPTIONS = 10

type Props = Unbuilt

function initialContextToggle(value: string): boolean {
  return stripContext1m(value) !== value
}

export function ModelPicker(arg0: Props): React.ReactNode {
  return notBuilt('src/components/ModelPicker.tsx:51')
}

export default ModelPicker
