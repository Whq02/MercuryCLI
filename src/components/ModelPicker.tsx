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

const VISIBLE_OPTIONS = 10
const DEFAULT_HEADER_TEXT =
  'Applies to this and future sessions. Other models can be named on the command line.'

type Props = {
  initial: string | null
  sessionModel?: string | null
  onSelect: (model: string, effort?: EffortLevel) => void
  onCancel?: () => void
  isStandaloneCommand?: boolean
  skipSettingsWrite?: boolean
  headerText?: string
  sessionOverrideNotice?: string
}

function initialContextToggle(value: string): boolean {
  return stripContext1m(value) !== value
}

function seedEffortForModel(
  model: string,
  appEffortValue: EffortValue | undefined,
): EffortLevel | undefined {
  return (
    toPersistableEffort(appEffortValue) ??
    toPersistableEffort(getDefaultEffortForModel(model))
  )
}

export function ModelPicker({
  initial,
  sessionModel,
  onSelect,
  onCancel,
  isStandaloneCommand,
  skipSettingsWrite,
  headerText,
  sessionOverrideNotice,
}: Props): React.ReactNode {
  const tokens = useMercuryTokens()
  const appEffortValue = useAppState((s: AppState) => s.effortValue)
  const sessionModelFromState = useAppState((s: AppState) => s.engineModelForSession)
  const setAppState = useSetAppState()

  const { options, defaultFocusValue } = useMemo(() => {
    const filtered: ModelOption[] = getModelOptions().filter(
      opt =>
        !opt.unavailable &&
        !isCatalogueDoorRow(opt.value) &&
        !isProviderActionRow(opt.value),
    )

    const trimmedInitial = initial !== null && initial !== '' ? initial : null
    const bareInitial = trimmedInitial !== null ? stripContext1m(trimmedInitial) : null

    let matched: ModelOption | undefined
    if (trimmedInitial !== null && bareInitial !== null) {
      matched =
        filtered.find(opt => opt.value === trimmedInitial) ??
        filtered.find(opt => resolvesToExistingOption([opt], trimmedInitial)) ??
        filtered.find(opt => stripContext1m(opt.value) === bareInitial) ??
        filtered.find(opt => resolvesToExistingOption([opt], bareInitial))
    }

    const list = [...filtered]
    let focusVal = matched?.value

    if (
      focusVal === undefined &&
      trimmedInitial !== null &&
      bareInitial !== null &&
      !resolvesToExistingOption(filtered, trimmedInitial) &&
      !resolvesToExistingOption(filtered, bareInitial)
    ) {
      const appendedValue = focusedOptionSupports1m(bareInitial)
        ? bareInitial
        : trimmedInitial
      list.push({
        value: appendedValue,
        label: appendedValue,
        description: 'current model',
      })
      focusVal = appendedValue
    }

    return {
      options: list,
      defaultFocusValue: focusVal ?? list[0]?.value ?? '',
    }
  }, [initial])

  const selectOptions = useMemo(
    () =>
      options.map(opt => ({
        value: opt.value,
        label: opt.value,
        description:
          opt.description !== ''
            ? opt.label !== opt.value
              ? `${opt.label} · ${opt.description}`
              : opt.description
            : opt.label !== opt.value
              ? opt.label
              : undefined,
      })),
    [options],
  )

  const [focusedValue, setFocusedValue] = useState<string>(defaultFocusValue)
  const [effortLevel, setEffortLevel] = useState<EffortLevel | undefined>(() =>
    seedEffortForModel(defaultFocusValue, appEffortValue),
  )
  const [effortToggled, setEffortToggled] = useState(false)
  const [contextToggle, setContextToggle] = useState<boolean>(() =>
    initial !== null && initial !== '' ? initialContextToggle(initial) : false,
  )
  const [visibleTo, setVisibleTo] = useState<number>(() =>
    Math.min(VISIBLE_OPTIONS, selectOptions.length),
  )

  const exitState = useExitOnCtrlCDWithKeybindings(
    onCancel,
    undefined,
    Boolean(isStandaloneCommand),
  )

  const handleFocus = useCallback(
    (nextValue: string) => {
      setFocusedValue(nextValue)
      setContextToggle(initialContextToggle(nextValue))
      if (!effortToggled && toPersistableEffort(appEffortValue) === undefined) {
        setEffortLevel(toPersistableEffort(getDefaultEffortForModel(nextValue)))
      }
    },
    [effortToggled, appEffortValue],
  )

  const handleVisibleWindowChange = useCallback(
    (_from: number, to: number) => {
      setVisibleTo(to)
    },
    [],
  )

  useInput((input, key) => {
    if ((key.leftArrow || key.rightArrow) && modelSupportsEffort(focusedValue)) {
      const direction = key.rightArrow ? 'right' : 'left'
      setEffortLevel(prev => cycleSelectableEffort(focusedValue, prev, direction))
      setEffortToggled(true)
      return
    }
    if (
      (input === 'c' || input === 'C') &&
      !key.ctrl &&
      !key.meta &&
      focusedOptionSupports1m(focusedValue)
    ) {
      setContextToggle(prev => !prev)
    }
  })

  const handleSelect = useCallback(
    (value: string) => {
      const finalModel =
        focusedOptionSupports1m(value) && contextToggle
          ? withContext1m(value)
          : value
      const explicitEffort =
        effortToggled && modelSupportsEffort(finalModel)
          ? effortLevel
          : undefined
      if (!skipSettingsWrite) {
        if (effortToggled) {
          unpinAllLaunchEffort()
        }
        const modelDefault = toPersistableEffort(getDefaultEffortForModel(finalModel))
        const priorPersisted = getInitialEffortSetting()
        const persisted = resolvePickerEffortPersistence(
          effortLevel,
          modelDefault,
          priorPersisted,
          effortToggled,
        )
        if (persisted !== undefined) {
          updateSettingsForSource('userSettings', {
            engine: { effort: persisted },
          })
        }
        setAppState(prev => ({ ...prev, effortValue: persisted }))
      }
      onSelect(finalModel, explicitEffort)
    },
    [
      contextToggle,
      skipSettingsWrite,
      effortToggled,
      effortLevel,
      setAppState,
      onSelect,
    ],
  )

  const supportsEffort = focusedValue !== '' && modelSupportsEffort(focusedValue)
  const supports1m = focusedValue !== '' && focusedOptionSupports1m(focusedValue)
  const remainingBelow = Math.max(0, selectOptions.length - visibleTo)

  let effortRow: string | null = null
  if (focusedValue !== '') {
    if (supportsEffort) {
      const truth = resolveEffortTruth(focusedValue, effortLevel)
      const modelDefault = toPersistableEffort(getDefaultEffortForModel(focusedValue))
      const adjustedPart =
        truth.adjustedFrom !== undefined && truth.adjustedFrom !== truth.applied
          ? ` (adjusted from ${truth.adjustedFrom})`
          : ''
      const defaultPart =
        truth.applied !== undefined && truth.applied === modelDefault
          ? ' (default)'
          : ''
      effortRow = `Effort: ${truth.label}${adjustedPart}${defaultPart} · ←→ to change`
    } else {
      const displayName = getPublicModelDisplayName(focusedValue) ?? focusedValue
      effortRow = `${displayName} has no effort control`
    }
  }

  const effectiveSessionModel = sessionModel ?? sessionModelFromState
  const overrideNotice =
    sessionOverrideNotice ??
    (effectiveSessionModel !== null &&
    effectiveSessionModel !== undefined &&
    effectiveSessionModel !== '' &&
    effectiveSessionModel !== initial
      ? `Session model override active: ${getPublicModelDisplayName(effectiveSessionModel) ?? effectiveSessionModel}`
      : undefined)

  const footerText = exitState.pending
    ? exitChordNoticeText(exitState.keyName)
    : `↑↓ move · pgup/pgdn page · ↵ select · ${isStandaloneCommand ? 'esc exit' : 'esc close'}`

  const content = (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text bold>Select model</Text>
        <Text dimColor>{headerText ?? DEFAULT_HEADER_TEXT}</Text>
        {overrideNotice !== undefined ? (
          <Text color={tokens.warning}>{overrideNotice}</Text>
        ) : null}
      </Box>
      <Box flexDirection="column">
        <Select<string>
          options={selectOptions}
          defaultFocusValue={defaultFocusValue}
          visibleOptionCount={VISIBLE_OPTIONS}
          onChange={handleSelect}
          onFocus={handleFocus}
          onVisibleWindowChange={handleVisibleWindowChange}
          onCancel={onCancel}
          inlineDescriptions
        />
        {remainingBelow > 0 ? (
          <Text dimColor>{`…and ${remainingBelow} more below`}</Text>
        ) : null}
      </Box>
      {effortRow !== null ? (
        <Box flexDirection="column">
          <Text color={supportsEffort ? tokens.info : undefined} dimColor={!supportsEffort}>
            {effortRow}
          </Text>
          {supports1m ? (
            <Text color={tokens.info}>
              {`Context: ${contextToggle ? '1M tokens' : 'standard'} · press c to toggle`}
            </Text>
          ) : null}
        </Box>
      ) : null}
      <Text dimColor>{footerText}</Text>
    </Box>
  )

  if (isStandaloneCommand) {
    return (
      <Box
        flexDirection="column"
        padding={1}
        borderStyle="round"
        borderColor={tokens.borderSubtle}
      >
        {content}
      </Box>
    )
  }

  return content
}

export default ModelPicker
