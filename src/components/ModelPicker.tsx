
import React, { useCallback, useMemo, useRef, useState } from 'react'
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
  resolvesToExistingOption,
  stripContext1m,
  withContext1m,
} from '../utils/model/modelOptions.js'
import { getPublicModelDisplayName } from '../utils/model/model.js'
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

const VISIBLE_OPTIONS = 10

export type Props = {
  initial: string
  sessionModel?: string | null
  onSelect: (model: string, effort: EffortLevel | undefined) => void
  onCancel?: () => void
  isStandaloneCommand?: boolean
  headerText?: string
  skipSettingsWrite?: boolean
}

function initialContextToggle(value: string): boolean {
  return stripContext1m(value) !== value
}

export function ModelPicker({
  initial,
  sessionModel,
  onSelect,
  onCancel,
  isStandaloneCommand = false,
  headerText,
  skipSettingsWrite = false,
}: Props): React.ReactNode {
  const tokens = useMercuryTokens()
  const setAppState = useSetAppState()
  const appStateEffort = useAppState((s: AppState) => s.effortValue)
  const options = useMemo(() => {
    const catalogue = getModelOptions().filter(o => o.unavailable === undefined && !isCatalogueDoorRow(o.value))
    if (
      !resolvesToExistingOption(catalogue, initial) &&
      !catalogue.some(option => option.value === initial)
    ) {
      const appended: ModelOption = {
        value: initial,
        label: getPublicModelDisplayName(initial) ?? initial,
        description: 'current model',
      }
      return [...catalogue, appended]
    }
    return catalogue
  }, [initial])

  const focusDefault = options.some(option => option.value === initial)
    ? initial
    : options[0]!.value

  const [focusedValue, setFocusedValue] = useState(focusDefault)

  const [effortToggled, setEffortToggled] = useState(false)
  const [effortLevel, setEffortLevel] = useState<EffortLevel | undefined>(
    () =>
      toPersistableEffort(appStateEffort) ??
      toPersistableEffort(getDefaultEffortForModel(focusDefault)),
  )
  const [contextToggle, setContextToggle] = useState(() =>
    initialContextToggle(focusDefault),
  )

  const focusedModel = stripContext1m(focusedValue)
  const focusedSupportsEffort = modelSupportsEffort(focusedModel)
  const focusedSupports1m = focusedOptionSupports1m(focusedValue)

  const onFocusOption = useCallback(
    (value: string) => {
      setFocusedValue(value)
      setContextToggle(initialContextToggle(value))
      if (!effortToggled && toPersistableEffort(appStateEffort) === undefined) {
        setEffortLevel(
          toPersistableEffort(getDefaultEffortForModel(stripContext1m(value))),
        )
      }
    },
    [effortToggled, appStateEffort],
  )

  const cycleEffort = useCallback(
    (direction: 'left' | 'right') => {
      if (!focusedSupportsEffort) return
      setEffortToggled(true)
      setEffortLevel(current =>
        cycleSelectableEffort(focusedModel, current, direction),
      )
    },
    [focusedModel, focusedSupportsEffort],
  )

  useInput((input, key) => {
    if (key.leftArrow) cycleEffort('left')
    else if (key.rightArrow) cycleEffort('right')
    else if (input === 'c' && !key.ctrl && !key.meta && focusedSupports1m) {
      setContextToggle(previous => !previous)
    }
  })

  const handleSelect = useCallback(
    (value_0: string) => {
      const chosen =
        contextToggle &&
        focusedOptionSupports1m(value_0)
          ? withContext1m(value_0)
          : value_0
      const chosenModel = stripContext1m(chosen)
      const supportsEffort = modelSupportsEffort(chosenModel)
      const toggledLevel = effortToggled ? effortLevel : undefined

      if (!skipSettingsWrite) {
        if (effortToggled) {
          unpinAllLaunchEffort()
        }
        const persisted = resolvePickerEffortPersistence(
          toggledLevel,
          toPersistableEffort(getDefaultEffortForModel(chosenModel)),
          getInitialEffortSetting(),
          effortToggled,
        )
        if (persisted !== undefined) {
          updateSettingsForSource('userSettings', { effortLevel: persisted })
        }
        setAppState((previous: AppState) => ({
          ...previous,
          effortValue: persisted as EffortValue | undefined,
        }))
      }

      onSelect(
        chosen,
        effortToggled && supportsEffort ? toggledLevel : undefined,
      )
    },
    [
      contextToggle,
      effortToggled,
      effortLevel,
      skipSettingsWrite,
      setAppState,
      onSelect,
    ],
  )

  const exitState = useExitOnCtrlCDWithKeybindings(() => onCancel?.())

  const effortRow = ((): React.ReactNode => {
    if (!focusedSupportsEffort) {
      return (
        <Text dimColor>
          {getPublicModelDisplayName(focusedModel) ?? focusedModel} has no
          effort control
        </Text>
      )
    }
    const truth = resolveEffortTruth(focusedModel, effortLevel)
    const isDefault =
      toPersistableEffort(getDefaultEffortForModel(focusedModel)) ===
      effortLevel
    return (
      <Text>
        Effort: <Text bold>{truth.label}</Text>
        {truth.adjustedFrom !== undefined ? (
          <Text dimColor> (adjusted from {truth.adjustedFrom})</Text>
        ) : null}
        {isDefault ? <Text dimColor> (default)</Text> : null}
        <Text dimColor> · ←→ to change</Text>
      </Text>
    )
  })()

  const contextRow = focusedSupports1m ? (
    <Text>
      Context: <Text bold>{contextToggle ? '1M tokens' : 'standard'}</Text>
      <Text dimColor> · press c to toggle</Text>
    </Text>
  ) : null

  const [visibleTo, setVisibleTo] = React.useState(
    Math.min(options.length, VISIBLE_OPTIONS),
  )
  const hiddenCount = Math.max(0, options.length - visibleTo)

  const body = (
    <Box flexDirection="column" gap={1}>
      <Text bold>Select model</Text>
      <Text dimColor>
        {headerText ??
          'Applies to this and future sessions. Other models can be named on the command line.'}
      </Text>
      {sessionModel !== undefined && sessionModel !== null ? (
        <Text dimColor>
          This session runs {sessionModel} (set by strategy mode); selecting a
          model undoes it.
        </Text>
      ) : null}
      <Select
        options={options.map(option => ({
          label: option.label,
          description: option.description,
          value: option.value,
        }))}
        defaultFocusValue={focusDefault}
        visibleOptionCount={VISIBLE_OPTIONS}
        onFocus={onFocusOption}
        onVisibleWindowChange={(_, to) => setVisibleTo(to)}
        onChange={handleSelect}
        onCancel={onCancel}
      />
      {hiddenCount > 0 ? (
        <Text dimColor>…and {hiddenCount} more below</Text>
      ) : null}
      {effortRow}
      {contextRow}
    </Box>
  )

  if (!isStandaloneCommand) {
    return (
      <Box flexDirection="column">
        {body}
        <Box marginTop={1}>
          <Text dimColor>
            {exitState.pending
              ? exitChordNoticeText(exitState.keyName)
              : 'enter confirm · esc close'}
          </Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={tokens.borderSubtle}
      paddingX={1}
    >
      {body}
      <Box marginTop={1}>
        <Text dimColor>
          {exitState.pending
            ? exitChordNoticeText(exitState.keyName)
            : 'enter confirm · esc exit'}
        </Text>
      </Box>
    </Box>
  )
}

export default ModelPicker
