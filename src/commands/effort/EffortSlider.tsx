
import * as React from 'react'
import { Box, Text, useAnimationFrame, useInput } from '../../ink.js'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { useFocusedSentEffort, useFocusedServedEffort, useFocusedServedModel } from '../../hooks/useDisplayedSessionModel.js'
import { focusedEffortLabelOf } from '../../components/mercury-ui/EffortChip.js'
import { useAppState } from '../../state/AppState.js'
import type { AppState } from '../../state/AppState.js'
import type { EffortLevel, EffortValue } from '../../utils/effort.js'
import { useOpenEventGate } from '../../components/mercury-ui/useOpenEventGate.js'
import {
  EFFORT_LEVELS,
  effortFamiliesLabel,
  getDisplayedEffortLabel,
  getDisplayedEffortLevel,
  modelSupportsXHighEffort,
  selectableEffortLevels,
} from '../../utils/effort.js'
import {
  AMBER,
  BELLY,
  CLAW,
  FAINT,
  IVORY,
  SECOND,
  TEAL,
  TERRA,
} from '../../components/mercuryPalette.js'
import { displayWidth } from '../../components/mercury-ui/glyphs.js'
import { useSessionAccent } from '../../components/mercury-ui/sessionAccent.js'
import { interpolateColor, toRGBColor } from '../../components/Spinner/utils.js'

const TRACK_WIDTH = 53
const STOP_COLUMNS = [1, 10, 20, 30, 40]
const LABEL_GAPS = [5, 5, 5, 6, 6]
const PREFERRED_SLOT = 3

type Treatment =
  | 'amber'
  | 'teal'
  | 'accent'
  | 'shimmer'
  | 'rainbow'

type SliderLevel = {
  value: EffortValue
  label: string
  treatment: Treatment
  supported: boolean
}

const TREATMENTS: Record<EffortLevel, Treatment> = {
  low: 'amber',
  medium: 'teal',
  high: 'accent',
  xhigh: 'shimmer',
  max: 'rainbow',
}
const BASE_TIERS: Omit<SliderLevel, 'supported'>[] = EFFORT_LEVELS.map(level => ({
  value: level,
  label: level,
  treatment: TREATMENTS[level],
}))

function computeLabelStarts(levels: SliderLevel[], gaps: number[]): number[] {
  return levels.map((_lvl, i) =>
    levels
      .slice(0, i)
      .reduce((acc, l, j) => acc + l.label.length + (gaps[j] ?? 0), 0),
  )
}

type SliderGeometry = {
  levels: SliderLevel[]
  width: number
  trianglePositions: number[]
  labelStarts: number[]
  spacers: number[]
  trackChars: string
}

export function getSliderGeometry(model: string): SliderGeometry {
  const vocabulary = new Set<string>(selectableEffortLevels(model))
  const base: SliderLevel[] = BASE_TIERS.map(tier => ({
    ...tier,
    supported: vocabulary.has(String(tier.value)),
  }))
  return {
    levels: base,
    width: TRACK_WIDTH,
    trianglePositions: STOP_COLUMNS,
    labelStarts: computeLabelStarts(base, LABEL_GAPS),
    spacers: LABEL_GAPS,
    trackChars: '─'.repeat(TRACK_WIDTH),
  }
}

function openingSlot(
  levels: SliderLevel[],
  effortValue: EffortValue | undefined,
): number {
  if (typeof effortValue === 'string') {
    const slot = levels.findIndex(l => l.value === effortValue && l.supported)
    if (slot >= 0) return slot
  }
  const preferred = Math.min(PREFERRED_SLOT, levels.length - 1)
  for (let i = preferred; i >= 0; i--) {
    if (levels[i]?.supported) return i
  }
  for (let i = preferred + 1; i < levels.length; i++) {
    if (levels[i]?.supported) return i
  }
  return preferred
}

export function resolveOpeningStop(
  model: string,
  sessionEffortValue: EffortValue | undefined,
  initialEffortOverride?: EffortValue,
): number {
  const geo = getSliderGeometry(model)
  if (initialEffortOverride !== undefined) {
    return openingSlot(geo.levels, initialEffortOverride)
  }
  return openingSlot(geo.levels, getDisplayedEffortLevel(model, sessionEffortValue))
}


type RGB = { r: number; g: number; b: number }

function parseHexChannels(hex: string): RGB {
  const h = hex.replace('#', '')
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  }
}
const RGB_TERRA: RGB = parseHexChannels(TERRA)
const RGB_CLAW: RGB = parseHexChannels(CLAW)
const RGB_BELLY: RGB = parseHexChannels(BELLY)
const RGB_AMBER: RGB = parseHexChannels(AMBER)
const RGB_IVORY: RGB = parseHexChannels(IVORY)

function BreathingLabel({
  text,
  active,
  time,
  bold,
}: {
  text: string
  active: boolean
  time: number
  bold?: boolean
}): React.ReactNode {
  if (!active) {
    return (
      <Text color={BELLY} bold={bold}>
        {text}
      </Text>
    )
  }
  const chars = [...text]
  return (
    <Text bold={bold}>
      {chars.map((ch, i) => {
        const phase = (time / 90 - i * 0.6) % (Math.PI * 2)
        const t = (1 + Math.cos(phase)) / 2
        const c = interpolateColor(RGB_BELLY, RGB_IVORY, t)
        return (
          <Text key={i} color={toRGBColor(c)}>
            {ch}
          </Text>
        )
      })}
    </Text>
  )
}

const EMBER_RING: RGB[] = [RGB_CLAW, RGB_TERRA, RGB_BELLY, RGB_AMBER]

function ringAt(ring: RGB[], pos: number): string {
  const n = ring.length
  const f = ((pos % n) + n) % n
  const lo = Math.floor(f)
  const hi = (lo + 1) % n
  return toRGBColor(interpolateColor(ring[lo]!, ring[hi]!, f - lo))
}

function EmberLabel({
  text,
  active,
  time,
  bold,
}: {
  text: string
  active: boolean
  time: number
  bold?: boolean
}): React.ReactNode {
  if (!active) {
    return (
      <Text color={TERRA} bold={bold}>
        {text}
      </Text>
    )
  }
  const drift = time / 140
  return (
    <Text bold={bold}>
      {[...text].map((ch, i) => (
        <Text key={i} color={ringAt(EMBER_RING, drift + i * 0.5)}>
          {ch}
        </Text>
      ))}
    </Text>
  )
}


export function EffortSlider({
  onDone,
  modelOverride,
  initialEffortOverride,
}: {
  onDone: (message: string) => void
  modelOverride?: string
  initialEffortOverride?: EffortValue
}): React.ReactNode {
  const servedModel = useFocusedServedModel()
  const processModel = useMainLoopModel()
  const model = modelOverride ?? servedModel ?? processModel
  const { accent } = useSessionAccent()

  const geo = React.useMemo(() => getSliderGeometry(model), [model])

  const sessionEffortValue = useAppState((s: AppState) => s.effortValue)
  const effortValue = initialEffortOverride ?? sessionEffortValue
  const seatEffort = useFocusedServedEffort()
  const sentEffort = useFocusedSentEffort()
  const standingLabel =
    modelOverride !== undefined || initialEffortOverride !== undefined
      ? getDisplayedEffortLabel(model, effortValue)
      : focusedEffortLabelOf(model, seatEffort, sentEffort, effortValue)

  const [selected, setSelected] = React.useState(() =>
    resolveOpeningStop(model, sessionEffortValue, initialEffortOverride),
  )

  const pastOpenEvent = useOpenEventGate()

  const level = geo.levels[selected]

  const [done, setDone] = React.useState(false)
  const [animRef, time] = useAnimationFrame(done ? null : 33)

  const apply = React.useContext(EffortApplyContext)

  const finish = React.useCallback(
    (msg: string) => {
      setDone(true)
      onDone(msg)
    },
    [onDone],
  )

  const slide = React.useCallback(
    (from: number, dir: -1 | 1): number => {
      let next = from + dir
      while (next >= 0 && next < geo.levels.length && !geo.levels[next]?.supported) {
        next += dir
      }
      return next >= 0 && next < geo.levels.length ? next : from
    },
    [geo.levels],
  )

  useInput(
    (_input, key) => {
      if (done) return
      if (key.escape) {
        finish(`Effort unchanged (${standingLabel})`)
        return
      }
      if (key.leftArrow) {
        setSelected(s => slide(s, -1))
        return
      }
      if (key.rightArrow) {
        setSelected(s => slide(s, 1))
        return
      }
      if (!pastOpenEvent()) return
      if (key.return) {
        const chosen = geo.levels[selected]
        if (!chosen) return
        const applied = apply(chosen.value)
        if (typeof applied === 'string') {
          finish(applied)
          return
        }
        setDone(true)
        void applied.then(onDone)
        return
      }
    },
    { isActive: !done },
  )

  const trackCells: React.ReactNode[] = []
  for (let col = 0; col < geo.width; col++) {
    const stopIdx = geo.trianglePositions.indexOf(col)
    if (stopIdx >= 0 && !geo.levels[stopIdx]?.supported) {
      trackCells.push(
        <Text key={col} color={FAINT} dimColor>
          {geo.trackChars[col] ?? ' '}
        </Text>,
      )
      continue
    }
    if (stopIdx >= 0) {
      const isSel = stopIdx === selected
      trackCells.push(
        <Text key={col} color={isSel ? accent : FAINT} bold={isSel}>
          {isSel ? '▲' : '△'}
        </Text>,
      )
      continue
    }
    const ch = geo.trackChars[col] ?? ' '
    trackCells.push(
      <Text key={col} color={FAINT} dimColor>
        {ch}
      </Text>,
    )
  }

  return (
    <Box flexDirection="column" ref={animRef} marginY={1}>
      {}
      <Box marginBottom={1}>
        <Text color={FAINT}>Faster </Text>
        <Text color={FAINT}>{'← '}</Text>
        <Text color={SECOND}>effort</Text>
        <Text color={FAINT}>{' →'}</Text>
        <Text color={FAINT}> Smarter</Text>
      </Box>

      {}
      <Box>
        <Text>{trackCells}</Text>
      </Box>

      {}
      <Box>
        <TierWords geo={geo} selected={selected} accent={accent} time={time} />
      </Box>

      {}
      <Box marginTop={1}>
        <Text color={SECOND}>{tierSummary(level)}</Text>
      </Box>
      <Box>
        <Text color={FAINT}>←/→ adjust · ↵ apply · esc cancel</Text>
      </Box>
    </Box>
  )
}

function TierWords({
  geo,
  selected,
  accent,
  time,
}: {
  geo: SliderGeometry
  selected: number
  accent: string
  time: number
}): React.ReactNode {
  const cells: React.ReactNode[] = []
  let col = 0
  geo.levels.forEach((tier, i) => {
    const start = geo.labelStarts[i] ?? 0
    if (start > col) {
      cells.push(<Text key={`gap-${i}`}>{' '.repeat(start - col)}</Text>)
      col = start
    }
    if (!tier.supported) {
      cells.push(
        <Text key={`lbl-${i}`}>{' '.repeat(displayWidth(tier.label))}</Text>,
      )
      col += displayWidth(tier.label)
      return
    }
    cells.push(
      <TierWord
        key={`lbl-${i}`}
        tier={tier}
        selected={i === selected}
        accent={accent}
        time={time}
      />,
    )
    col += displayWidth(tier.label)
  })
  return <Text>{cells}</Text>
}

function TierWord({
  tier,
  selected,
  accent,
  time,
}: {
  tier: SliderLevel
  selected: boolean
  accent: string
  time: number
}): React.ReactNode {
  const bold = selected
  switch (tier.treatment) {
    case 'amber':
      return (
        <Text color={selected ? AMBER : FAINT} bold={bold} dimColor={!selected}>
          {tier.label}
        </Text>
      )
    case 'teal':
      return (
        <Text color={selected ? TEAL : FAINT} bold={bold} dimColor={!selected}>
          {tier.label}
        </Text>
      )
    case 'accent':
      return (
        <Text color={selected ? accent : FAINT} bold={bold} dimColor={!selected}>
          {tier.label}
        </Text>
      )
    case 'shimmer':
      return (
        <BreathingLabel text={tier.label} active={selected} time={time} bold={bold} />
      )
    case 'rainbow':
      return <EmberLabel text={tier.label} active={selected} time={time} bold={bold} />
    default:
      return <Text dimColor>{tier.label}</Text>
  }
}

function tierSummary(level: SliderLevel | undefined): string {
  switch (level?.value) {
    case 'low':
      return 'low — quick, straightforward implementation'
    case 'medium':
      return 'medium — balanced approach with standard testing'
    case 'high':
      return 'high — comprehensive implementation with extensive testing'
    case 'xhigh': {
      const families = effortFamiliesLabel(modelSupportsXHighEffort)
      return `xhigh — extra-high reasoning depth${families ? ` (${families})` : ''}`
    }
    case 'max':
      return 'max — maximum capability with the deepest reasoning'
    default:
      return ''
  }
}

export type EffortApplier = (value: EffortValue) => string | Promise<string>
export const EffortApplyContext = React.createContext<EffortApplier>(() => '')
