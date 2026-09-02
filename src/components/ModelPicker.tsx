// The model picker: catalogue options, a
// "no preference" sentinel reporting null, an effort row cycling only the
// focused model's own selectable stops, and the extended-context toggle.
// Selection persistence: an explicit effort toggle unpins every
// launch default, the persistable value is resolved from the toggle, the
// selected option's default and the stored setting, and user settings are
// written only when that resolution is persistable while app state mirrors
// it unconditionally.

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
  initial: string | null
  sessionModel?: string | null
  onSelect: (model: string | null, effort: EffortLevel | undefined) => void
  onCancel?: () => void
  isStandaloneCommand?: boolean
  headerText?: string
  skipSettingsWrite?: boolean
}

/** The toggle's per-focus baseline: an extended-context variant starts on,
 *  a plain option starts off. */
function initialContextToggle(value: string | null): boolean {
  if (value === null) return false
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
    // Visible-but-unavailable lineup rows are a
    // /model catalogue-surface feature; this inline quick-switcher lists only
    // selectable rows — listing a row ↵ would refuse breaks the never-
    // selectable law here (this select has no disabled-row state).
    // The catalogue doors live on the /model surface (they expand a group
    // in place with a filter line); this popover keeps its bounded view.
    const catalogue = getModelOptions().filter(o => o.unavailable === undefined && !(typeof o.value === 'string' && isCatalogueDoorRow(o.value)))
    if (
      initial !== null &&
      !resolvesToExistingOption(catalogue, initial) &&
      !catalogue.some(option => option.value === initial)
    ) {
      // The configured model is off-catalogue: appended so it stays pickable.
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
    : (options[0]?.value ?? null)

  const [focusedValue, setFocusedValue] = useState<string | null>(focusDefault)

  // Effort: seeded from app state when set, else the focused option's own
  // default. The shown default FOLLOWS focus only while the operator has not
  // toggled and app state carries no explicit value.
  const [effortToggled, setEffortToggled] = useState(false)
  const [effortLevel, setEffortLevel] = useState<EffortLevel | undefined>(
    () =>
      toPersistableEffort(appStateEffort) ??
      (focusDefault !== null
        ? toPersistableEffort(getDefaultEffortForModel(focusDefault))
        : undefined),
  )
  const [contextToggle, setContextToggle] = useState(() =>
    initialContextToggle(focusDefault),
  )

  const focusedModel =
    focusedValue !== null ? stripContext1m(focusedValue) : null
  const focusedSupportsEffort =
    focusedModel !== null && modelSupportsEffort(focusedModel)
  const focusedSupports1m = focusedOptionSupports1m(focusedValue)

  const onFocusOption = useCallback(
    (value: string | null) => {
      setFocusedValue(value)
      setContextToggle(initialContextToggle(value))
      if (!effortToggled && toPersistableEffort(appStateEffort) === undefined) {
        setEffortLevel(
          value !== null
            ? toPersistableEffort(
                getDefaultEffortForModel(stripContext1m(value)),
              )
            : undefined,
        )
      }
    },
    [effortToggled, appStateEffort],
  )

  const cycleEffort = useCallback(
    (direction: 'left' | 'right') => {
      if (focusedModel === null || !focusedSupportsEffort) return
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
      // !key.ctrl: the decoder hands ctrl+c through
      // with input==='c', so the bare-letter toggle ate the interrupt
      // chord — ctrl+c inside the picker flipped the context window
      // instead of reaching the exit grammar. A modifier chord is never a
      // letter-verb (the board's own s/x/m discipline).
      setContextToggle(previous => !previous)
    }
  })

  const handleSelect = useCallback(
    (value_0: string | null) => {
      const chosen =
        value_0 !== null &&
        contextToggle &&
        focusedOptionSupports1m(value_0)
          ? withContext1m(value_0)
          : value_0
      const chosenModel = chosen !== null ? stripContext1m(chosen) : null
      const supportsEffort =
        chosenModel !== null && modelSupportsEffort(chosenModel)
      const toggledLevel = effortToggled ? effortLevel : undefined

      if (!skipSettingsWrite) {
        if (effortToggled) {
          // The operator's pick wins over every launch default.
          unpinAllLaunchEffort()
        }
        const persisted = resolvePickerEffortPersistence(
          toggledLevel,
          chosenModel !== null
            ? toPersistableEffort(getDefaultEffortForModel(chosenModel))
            : undefined,
          getInitialEffortSetting(),
          effortToggled,
        )
        if (persisted !== undefined) {
          updateSettingsForSource('userSettings', { effortLevel: persisted })
        }
        // App state mirrors the resolution unconditionally — possibly to
        // "no explicit level".
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

  // The effort row: the label is what the focused model would ACTUALLY run
  // at, per the effort owner (which can adjust an unsupported request).
  const effortRow = ((): React.ReactNode => {
    if (focusedModel === null) return null
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

  // PD-5: the tail count follows the SCROLL — the Select
  // reports its painted window (a render-state notification) and the
  // "…and N more below" row counts what is actually below it, reaching 0
  // (and disappearing) at the bottom. Seeded at the mount window so the
  // first frame is what it always was.
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
          value: option.value as string | null,
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

  // PD-9: the INLINE mount advertised no keys at all — its esc
  // (close, back to the composer) and enter were unspoken while the
  // standalone mount printed its guide. The inline picker now prints the
  // same family line with the truth-word for where esc lands; the ctrl+C/D
  // press-again notice outranks it exactly as in the standalone.
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
