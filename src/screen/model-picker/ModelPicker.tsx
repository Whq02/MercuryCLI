import React, { useCallback, useMemo, useState } from 'react'
import { exitChordNoticeText } from '../composer/ExitChordNotice.js'
import { Box, Text, useInput } from '../themedRenderer.js'
import { Select } from '../select/index.js'
import { useMercuryTokens } from '../widgets/useMercuryTokens.js'
import { useAppState, useSetAppState } from '../app-state/AppState.js'
import type { AppState } from '../app-state/AppStateStore.js'
import {
  type ModelOption,
  focusedOptionSupports1m,
  getModelOptions,
  isCatalogueDoorRow,
  isProviderActionRow,
  resolvesToExistingOption,
  stripContext1m,
  withContext1m,
} from '../../models/catalogue/modelOptions.js'
import { getPublicModelDisplayName } from '../../models/catalogue/engineModel.js'
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
} from '../../models/effort/effort.js'
import { modelSupportsEffort } from '../../models/facts/capabilities.js'
import { updateSettingsForSource } from '../../platform/settings/settings.js'
import { useExitChord } from '../keys/useExitChord.js'

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
}: Props): React.ReactNode {
  const tokens = useMercuryTokens()
  const appEffortValue = useAppState((s: AppState) => s.effortValue)
  const sessionModelFromState = useAppState((s: AppState) => s.engineModelForSession)
  const setAppState = useSetAppState()

  const { options, defaultFocusValue } = useMemo(() => {
    const filtered: ModelOption[] = getModelOptions().filter(
      opt => !opt.unavailable && !isCatalogueDoorRow(opt.value),
    )

    const trimmedInitial = initial !== null && initial !== '' ? initial : null
    const bareInitial = trimmedInitial !== null ? stripContext1m(trimmedInitial) : null

    let matched: ModelOption | undefined
    if (trimmedInitial !== null && bareInitial !== null) {
      matched =
        filtered.find(opt => opt.value === trimmedInitial) ??
        filtered.find(opt => resolvesToExistingOption([opt], trimmedInitial)) ??
        filtered.find(opt => opt.value === bareInitial) ??
        filtered.find(opt => resolvesToExistingOption([opt], bareInitial)) ??
        filtered.find(opt => stripContext1m(opt.value) === bareInitial)
    }

    const list = [...filtered]
    let focusVal = matched?.value

    if (focusVal === undefined && trimmedInitial !== null) {
      list.push({
        value: trimmedInitial,
        label: getPublicModelDisplayName(trimmedInitial) ?? trimmedInitial,
        description: 'current model',
      })
      focusVal = trimmedInitial
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
        label: isProviderActionRow(opt.value) ? opt.label : opt.value,
        description: opt.description,
      })),
    [options],
  )

  const [focusedValue, setFocusedValue] = useState<string>(defaultFocusValue)
  const [effortLevel, setEffortLevel] = useState<EffortLevel | undefined>(() =>
    seedEffortForModel(defaultFocusValue, appEffortValue),
  )
  const [effortToggled, setEffortToggled] = useState(false)
  const [contextToggle, setContextToggle] = useState<boolean>(() =>
    initial !== null && initial !== ''
      ? initialContextToggle(initial)
      : initialContextToggle(defaultFocusValue),
  )
  const [visibleTo, setVisibleTo] = useState<number>(() =>
    Math.min(VISIBLE_OPTIONS, selectOptions.length),
  )

  const exitState = useExitChord(
    onCancel,
    undefined,
    Boolean(isStandaloneCommand),
  )

  const handleFocus = useCallback(
    (nextValue: string) => {
      if (nextValue === focusedValue) return
      setFocusedValue(nextValue)
      setContextToggle(initialContextToggle(nextValue))
      if (!effortToggled && toPersistableEffort(appEffortValue) === undefined) {
        setEffortLevel(toPersistableEffort(getDefaultEffortForModel(nextValue)))
      }
    },
    [focusedValue, effortToggled, appEffortValue],
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
      const finalModel = focusedOptionSupports1m(value)
        ? contextToggle
          ? withContext1m(value)
          : stripContext1m(value)
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
  if (focusedValue !== '' && supportsEffort) {
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
  }

  const effectiveSessionModel = sessionModel ?? sessionModelFromState
  const hasSessionModelOverride =
    effectiveSessionModel !== null &&
    effectiveSessionModel !== undefined &&
    effectiveSessionModel !== ''

  const footerText = exitState.pending
    ? exitChordNoticeText(exitState.keyName)
    : isStandaloneCommand
      ? '↑↓ move · pgup/pgdn page · ↵ confirm · esc exit'
      : '↑↓ move · pgup/pgdn page · ↵ confirm · esc close'

  const content = (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text bold>Select model</Text>
        <Text dimColor>{headerText ?? DEFAULT_HEADER_TEXT}</Text>
        {hasSessionModelOverride ? (
          <Text color={tokens.warning}>
            This session runs{' '}
            <Text bold>
              {getPublicModelDisplayName(effectiveSessionModel) ??
                effectiveSessionModel}
            </Text>{' '}
            (a session override); selecting a{' '}
            model undoes it.
          </Text>
        ) : null}
      </Box>
      <Box flexDirection="column">
        <Select
          options={selectOptions}
          defaultFocusValue={defaultFocusValue}
          visibleOptionCount={VISIBLE_OPTIONS}
          onChange={handleSelect}
          onFocus={handleFocus}
          onVisibleWindowChange={handleVisibleWindowChange}
          onCancel={onCancel}
        />
        {remainingBelow > 0 ? (
          <Text dimColor>{`…and ${remainingBelow} more below`}</Text>
        ) : null}
      </Box>
      {focusedValue !== '' ? (
        <Box flexDirection="column">
          {supportsEffort && effortRow !== null ? (
            <Text color={tokens.info}>{effortRow}</Text>
          ) : (
            <Text dimColor>
              {getPublicModelDisplayName(focusedValue) ?? focusedValue} has no{' '}
              effort control
            </Text>
          )}
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
