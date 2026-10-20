import * as React from 'react'
import { useState } from 'react'
import { isTopOverlayNow, useRegisterOverlay } from '../../context/overlayContext.js'
import { useModalOrTerminalSize } from '../../context/modalContext.js'
import { Box, Text, useInput } from '../../ink.js'
import { useEngineModel } from '../../hooks/useEngineModel.js'
import { useFocusedSentEffort, useFocusedServedEffort, useFocusedServedModel } from '../../hooks/useDisplayedSessionModel.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { focusedEffortLabelOf } from '../../components/mercury-ui/EffortChip.js'
import { InteractiveRow } from '../../components/mercury-ui/InteractiveRow.js'
import { ProductLockup } from '../../components/mercury-ui/components.js'
import { paneWindow, panelWidth } from '../../components/mercury-ui/geometry.js'
import { displayWidth, padTo, truncateToWidth } from '../../components/mercury-ui/glyphs.js'
import { cutToWidth } from '../../components/mercury-ui/menuFold.js'
import { decodeNavKey } from '../../components/mercury-ui/navSemantics.js'
import { useElevatedSurface } from '../../components/mercury-ui/useElevatedSurface.js'
import { useOpenEventGate } from '../../components/mercury-ui/useOpenEventGate.js'
import { useSessionAccent } from '../../components/mercury-ui/sessionAccent.js'
import { useMercuryTokens } from '../../components/mercury-ui/useMercuryTokens.js'
import { PopupFrameContext } from '../../components/PopupGutter.js'
import { TEAL } from '../../components/mercuryPalette.js'
import { useAppState } from '../../state/AppState.js'
import type { AppState } from '../../state/AppState.js'
import type { CommandPopupShape } from '../../utils/cockpit/commandPopup.js'
import { estateGroundBg } from '../../utils/mercuryTokens.js'
import { renderModelName } from '../../utils/model/model.js'
import { MODEL_PICKER_CURRENT, MODEL_PICKER_PANEL } from '../../utils/model/modelPickerGroups.js'
import {
  convertEffortValueToLevel,
  describeEffortEnvOverride,
  getDisplayedEffortLabel,
  getDisplayedEffortLevel,
  getEffortLevelDescription,
  isEffortLevel,
  modelSupportsEffort,
  parseEffortValue,
  resolveStampedEffortTruth,
  selectableEffortLevels,
  type EffortLevel,
  type EffortValue,
} from '../../utils/effort.js'

const EFFORT_POPUP_VIEW = 'effort'
export const EFFORT_POPUP_HINT = '↑↓ move · ↵ apply · esc or click outside closes'
const EFFORT_POPUP_AUTO = 'auto'
const EFFORT_POPUP_ENV_VAR = 'MERCURY_EFFORT_LEVEL'
const WORD_COLUMN = 8
const STATE_COLUMN = displayWidth(MODEL_PICKER_CURRENT) + 1
const LEAD_COLUMN = 2

type EffortPopupRow = { value: EffortLevel | typeof EFFORT_POPUP_AUTO; word: string; description: string }

export function effortPopupRows(model: string): EffortPopupRow[] {
  const tiers: EffortPopupRow[] = selectableEffortLevels(model).map(level => ({ value: level, word: level, description: model.startsWith('compat/') ? getEffortLevelDescription(level).split(' · ')[0]! : getEffortLevelDescription(level) }))
  return [{ value: EFFORT_POPUP_AUTO, word: EFFORT_POPUP_AUTO, description: `The model's own default — currently ${getDisplayedEffortLabel(model, undefined)}` }, ...tiers]
}

function effortPopupEnvLine(env: NodeJS.ProcessEnv = process.env): string | null {
  const view = describeEffortEnvOverride(env)
  if (view.state !== 'level' && view.state !== 'deferred') return null
  return `${EFFORT_POPUP_ENV_VAR}=${view.raw} controls this session`
}

function focusedOpeningEffort(model: string, seatEffort: string | null, sentEffort: string | null | undefined, sessionEffortValue: EffortValue | undefined): EffortLevel {
  const sent = typeof sentEffort === 'string' ? parseEffortValue(sentEffort) : undefined
  if (typeof sent === 'string' && isEffortLevel(sent)) return sent
  const stamped = seatEffort !== null ? parseEffortValue(seatEffort) : undefined
  if (stamped !== undefined) {
    const applied = resolveStampedEffortTruth(model, stamped).appliedValue
    return convertEffortValueToLevel(applied ?? stamped)
  }
  return getDisplayedEffortLevel(model, sessionEffortValue)
}

export function effortPopupOpeningLevel(
  model: string,
  sessionEffortValue: EffortValue | undefined,
  initialEffortOverride?: EffortValue,
  seatEffort: string | null = null,
  sentEffort: string | null | undefined = undefined,
): EffortLevel {
  if (initialEffortOverride !== undefined) return convertEffortValueToLevel(initialEffortOverride)
  return focusedOpeningEffort(model, seatEffort, sentEffort, sessionEffortValue)
}

export function effortPopupOpeningRow(
  model: string,
  sessionEffortValue: EffortValue | undefined,
  initialEffortOverride?: EffortValue,
  seatEffort: string | null = null,
  sentEffort: string | null | undefined = undefined,
): number {
  const rows = effortPopupRows(model)
  const level = effortPopupOpeningLevel(model, sessionEffortValue, initialEffortOverride, seatEffort, sentEffort)
  const at = rows.findIndex(row => row.value === level)
  return at >= 0 ? at : 0
}

const EFFORT_POPUP_FIXED_ROWS = 5

function effortPopupLayout(frameRows: number, rowCount: number, envLine: boolean): { blanks: boolean; modelLine: boolean; envLine: boolean; listRows: number } {
  const fixed = EFFORT_POPUP_FIXED_ROWS + (envLine ? 1 : 0)
  if (fixed + 2 + rowCount <= frameRows) return { blanks: true, modelLine: true, envLine, listRows: rowCount }
  if (fixed + rowCount <= frameRows) return { blanks: false, modelLine: true, envLine, listRows: rowCount }
  if (fixed + 1 <= frameRows) return { blanks: false, modelLine: true, envLine, listRows: Math.max(1, frameRows - fixed) }
  const bare = EFFORT_POPUP_FIXED_ROWS - 1
  return { blanks: false, modelLine: false, envLine: false, listRows: Math.max(1, frameRows - bare) }
}

export function effortPopupShape(model: string): CommandPopupShape {
  const rowCount = effortPopupRows(model).length
  const envLine = effortPopupEnvLine() !== null
  return {
    view: EFFORT_POPUP_VIEW,
    width: columns => panelWidth(columns, MODEL_PICKER_PANEL),
    rows: () => EFFORT_POPUP_FIXED_ROWS + (envLine ? 1 : 0) + 2 + rowCount,
  }
}

type EffortApplier = (value: EffortValue | typeof EFFORT_POPUP_AUTO) => string | Promise<string>
export const EffortApplyContext = React.createContext<EffortApplier>(() => '')

export function EffortPopup({ onDone }: { onDone: (message: string) => void }): React.ReactNode {
  const servedModel = useFocusedServedModel()
  const processModel = useEngineModel()
  const model = servedModel ?? processModel
  const tok = useMercuryTokens()
  const { accent } = useSessionAccent()
  const elevatedRef = useElevatedSurface()
  const { columns: termColumns, rows: termRows } = useTerminalSize()
  const slot = useModalOrTerminalSize({ rows: termRows, columns: termColumns })
  const frame = React.useContext(PopupFrameContext)
  const width = Math.min(frame?.width ?? slot.columns, panelWidth(slot.columns, MODEL_PICKER_PANEL))
  const frameRows = frame?.rows ?? slot.rows
  const inner = Math.max(8, width - 4)

  const sessionEffortValue = useAppState((s: AppState) => s.effortValue)
  const seatEffort = useFocusedServedEffort()
  const sentEffort = useFocusedSentEffort()
  const standingLabel = focusedEffortLabelOf(model, seatEffort, sentEffort, sessionEffortValue)
  const rows = React.useMemo(() => effortPopupRows(model), [model])
  const currentLevel = model.startsWith('compat/') && (standingLabel === 'default' || !modelSupportsEffort(model)) ? EFFORT_POPUP_AUTO : effortPopupOpeningLevel(model, sessionEffortValue, undefined, seatEffort, sentEffort)
  const [cursor, setCursor] = useState(() => currentLevel === EFFORT_POPUP_AUTO ? 0 : effortPopupOpeningRow(model, sessionEffortValue, undefined, seatEffort, sentEffort))
  const cursorIndex = Math.min(cursor, Math.max(0, rows.length - 1))
  const envLine = effortPopupEnvLine()
  const layout = effortPopupLayout(frameRows, rows.length, envLine !== null)
  const win = paneWindow(rows.length, cursorIndex, layout.listRows)
  const ground = estateGroundBg(tok)

  const pastOpenEvent = useOpenEventGate()
  const token = useRegisterOverlay('effort-popup')
  const apply = React.useContext(EffortApplyContext)
  const [done, setDone] = useState(false)
  const finish = (message: string): void => {
    setDone(true)
    onDone(message)
  }
  const activate = (index: number): void => {
    const row = rows[index]
    if (!row || done) return
    const applied = apply(row.value)
    if (typeof applied === 'string') {
      finish(applied)
      return
    }
    setDone(true)
    void applied.then(onDone)
  }

  useInput((input, key, event) => {
    if (done) return
    const consume = (): void => event.stopImmediatePropagation()
    const action = decodeNavKey(input, key, { orientation: 'vertical' })
    if (action === 'cancel') {
      if (token !== null && !isTopOverlayNow(token)) return
      consume()
      finish(`Effort unchanged (${standingLabel})`)
      return
    }
    if (action === 'movePrevious' || action === 'moveNext') {
      consume()
      const step = action === 'moveNext' ? 1 : -1
      setCursor(Math.max(0, Math.min(rows.length - 1, cursorIndex + step)))
      return
    }
    if (action === 'first') {
      consume()
      setCursor(0)
      return
    }
    if (action === 'last') {
      consume()
      setCursor(Math.max(0, rows.length - 1))
      return
    }
    if (action === 'activate') {
      consume()
      if (!pastOpenEvent()) return
      activate(cursorIndex)
    }
  }, { isActive: !done })

  const supported = modelSupportsEffort(model) && rows.length > 1
  const ladder = supported ? `effort ${rows[1]!.word}…${rows[rows.length - 1]!.word}` : model.startsWith('compat/') ? 'this server has no effort dial' : 'takes no effort setting'
  const modelLine = supported ? `${renderModelName(model)} · ${ladder} · running ${standingLabel}` : model.startsWith('compat/') ? `${ladder} · ${renderModelName(model)}` : `${renderModelName(model)} · ${ladder}`
  const descriptionWidth = Math.max(1, inner - LEAD_COLUMN - WORD_COLUMN - STATE_COLUMN)
  const renderRow = (row: EffortPopupRow, index: number): React.ReactNode => {
    const selected = index === cursorIndex
    const current = row.value === currentLevel
    const description = truncateToWidth(row.description, descriptionWidth)
    const pad = ' '.repeat(Math.max(0, descriptionWidth - displayWidth(description)))
    return (
      <InteractiveRow key={row.word} id={`effort:row:${row.word}`} selected={selected} onSelect={() => setCursor(index)} onActivate={() => activate(index)} width={inner} height={1}>
        <Text wrap="truncate-end">
          <Text color={selected ? accent : tok.textMuted}>{selected ? '❯ ' : '  '}</Text>
          <Text bold color={selected || current ? tok.textPrimary : tok.textSecondary}>{padTo(row.word, WORD_COLUMN)}</Text>
          <Text color={selected ? tok.textPrimary : tok.textMuted}>{description}</Text>
          <Text>{pad}</Text>
          <Text color={TEAL}>{current ? ` ${MODEL_PICKER_CURRENT}` : ' '.repeat(STATE_COLUMN)}</Text>
        </Text>
      </InteractiveRow>
    )
  }

  return (
    <Box ref={elevatedRef} flexDirection="column" width={width} flexShrink={0} borderStyle="round" borderColor={tok.borderStrong} paddingX={1} opaque={true} {...(ground !== undefined ? { backgroundColor: ground } : {})}>
      <ProductLockup view={EFFORT_POPUP_VIEW} separator=" · " />
      {layout.modelLine ? (
        <Box height={1}>
          <Text color={tok.textMuted} wrap="truncate-end">{modelLine}</Text>
        </Box>
      ) : null}
      {layout.envLine && envLine !== null ? (
        <Box height={1}>
          <Text color={tok.warning} wrap="truncate-end">{envLine}</Text>
        </Box>
      ) : null}
      {layout.blanks ? <Box height={1} /> : null}
      {rows.slice(win.start, win.end).map((row, i) => renderRow(row, win.start + i))}
      {layout.blanks ? <Box height={1} /> : null}
      <Box height={1} width={inner + 1} marginRight={-1}>
        <Text color={tok.textMuted}>{cutToWidth(EFFORT_POPUP_HINT, inner + 1)}</Text>
      </Box>
    </Box>
  )
}
