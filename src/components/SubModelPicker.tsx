import * as React from 'react'
import { useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { GLYPH, padTo, truncateToWidth } from './mercury-ui/glyphs.js'
import { InteractiveRow } from './mercury-ui/InteractiveRow.js'
import { useInteractiveList } from './mercury-ui/useInteractiveList.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { useSessionAccent } from './mercury-ui/sessionAccent.js'
import { resolveEffortTruth } from '../utils/effort.js'
import { providerFrontierLine } from '../utils/model/providerFrontier.js'
import { getMainLoopModel, renderModelName } from '../utils/model/model.js'
import {
  canonicalSubModelId,
  composeSubModelRegistry,
  resolveSubModel,
  setSubModel,
  subModelEnvVar,
  SUB_MODEL_UNSET_HINT,
  type SubModelContainer,
  type SubModelEntry,
  type SubModelFamily,
  type SubModelRegistry,
} from '../utils/model/subModelSlots.js'


type PickerRow =
  | { kind: 'unset' }
  | { kind: 'header'; family: SubModelFamily }
  | { kind: 'entry'; entry: SubModelEntry }

const CONTAINER_META: Record<
  SubModelContainer,
  { label: string; blurb: string }
> = {
  minerva: { label: 'MINERVA', blurb: 'notepad curator' },
  console: { label: 'CONSOLE', blurb: 'side questions' },
}

function rowId(row: PickerRow): string {
  return row.kind === 'unset'
    ? 'unset'
    : row.kind === 'header'
      ? `header:${row.family.source}`
      : `entry:${row.entry.modelId}`
}

function buildRows(registry: SubModelRegistry): PickerRow[] {
  const rows: PickerRow[] = [{ kind: 'unset' }]
  for (const family of registry.families) {
    rows.push({ kind: 'header', family })
    for (const entry of registry.entries) {
      if (entry.source === family.source) rows.push({ kind: 'entry', entry })
    }
  }
  return rows
}

export interface SubModelRoutePick {
  container: SubModelContainer
  modelId: string
  command: string
}

function ContainerList({
  container,
  active,
  width,
  listRows,
  initialNote,
  initialModelId,
  onRoute,
  onClose,
  compact,
}: {
  container: SubModelContainer
  active: boolean
  width: number
  listRows: number
  initialNote?: string
  initialModelId?: string
  onRoute: (pick: SubModelRoutePick, note: string) => void
  onClose: () => void
  compact: boolean
}): React.ReactNode {
  const t = useMercuryTokens()
  const accent = useSessionAccent().accent
  const [epoch, setEpoch] = useState(0)
  const registry = React.useMemo(() => composeSubModelRegistry(), [epoch])
  const resolved = resolveSubModel(container)
  const rows = React.useMemo(() => buildRows(registry), [registry])
  const [seedNote, setSeedNote] = useState<string | undefined>(initialNote)

  const list = useInteractiveList<PickerRow>({
    rows,
    rowId,
    active,
    onClose,
    idNamespace: `submodels:${container}`,
    initialId:
      initialModelId !== undefined
        ? `entry:${initialModelId}`
        : resolved.origin === 'unset'
          ? 'unset'
          : `entry:${resolved.model}`,
    unavailable: row =>
      row.kind === 'header' ||
      (row.kind === 'entry' && row.entry.state === 'refused'),
    reasonUnavailable: row =>
      row.kind === 'entry' ? (row.entry.reason ?? 'unavailable') : '',
    actions: [
      {
        key: 'return',
        hint: 'select · sign in',
        run: (row): string | null => {
          if (!row) return null
          setSeedNote(undefined)
          if (row.kind === 'unset') {
            const result = setSubModel(container, null)
            setEpoch(n => n + 1)
            return result.ok ? result.receipt : result.reason
          }
          if (row.kind !== 'entry') return null
          const entry = row.entry
          if (entry.state === 'selectable') {
            const result = setSubModel(container, entry.modelId)
            setEpoch(n => n + 1)
            return result.ok ? result.receipt : result.reason
          }
          if (entry.state === 'signed-out') {
            if (entry.connect?.command !== undefined) {
              onRoute(
                {
                  container,
                  modelId: entry.kind === 'model' ? entry.modelId : '',
                  command: entry.connect.command,
                },
                `${entry.displayName} — ${entry.connect.note}`,
              )
              return null
            }
            return entry.connect?.note ?? entry.reason ?? 'not signed in'
          }
          return null
        },
      },
    ],
  })

  const selIdx = Math.max(
    0,
    rows.findIndex(row => list.selectedRow !== null && rowId(row) === rowId(list.selectedRow)),
  )
  const span = Math.max(3, listRows)
  const from =
    rows.length <= span
      ? 0
      : Math.min(Math.max(0, selIdx - Math.floor(span / 2)), rows.length - span)
  const visible = rows.slice(from, from + span).map((row, offset): [PickerRow, number] => [row, from + offset])
  const shedAbove = from
  const shedBelow = Math.max(0, rows.length - (from + span))

  const meta = CONTAINER_META[container]
  const nameW = compact ? Math.max(14, Math.min(24, width - 14)) : 28
  const originWords =
    resolved.origin === 'env'
      ? `pinned by ${resolved.envVar ?? subModelEnvVar(container)} — LOCKED`
      : resolved.origin === 'saved'
        ? 'saved pick'
        : 'no model pinned'
  const mainModel = canonicalSubModelId(getMainLoopModel())
  const cacheWords =
    container === 'console' && resolved.origin !== 'unset'
      ? resolved.model === mainModel
        ? ' · shares the main prompt cache'
        : ' · ≠ main — re-reads uncached'
      : ''
  const headerModel = resolved.origin === 'unset' ? 'unset' : renderModelName(resolved.model)
  const effortRange = (modelId: string): string => {
    const truth = resolveEffortTruth(modelId, undefined)
    if (!truth.supportsEffort) return 'no effort control'
    return `effort ${truth.selectable.join(' · ')} — runs ${truth.label} (the model default; the container carries no dial)`
  }
  const headerEffort = ((): string => {
    if (resolved.origin === 'unset') return ''
    const truth = resolveEffortTruth(resolved.model, undefined)
    return truth.supportsEffort ? ` · @${truth.label}` : ' · no effort control'
  })()

  const current = (row: PickerRow): boolean =>
    row.kind === 'entry'
      ? resolved.origin !== 'unset' && row.entry.kind === 'model' && row.entry.modelId === resolved.model
      : row.kind === 'unset'
        ? resolved.origin === 'unset'
        : false

  const detail = ((): string => {
    const row = list.selectedRow
    if (!row) return ''
    if (row.kind === 'unset')
      return `answers "${SUB_MODEL_UNSET_HINT}" — spends nothing`
    if (row.kind !== 'entry') return ''
    const entry = row.entry
    const parts: string[] = []
    if (entry.description !== undefined) parts.push(entry.description)
    if (entry.kind === 'model') parts.push(effortRange(entry.modelId))
    if (entry.state === 'signed-out' && entry.connect !== undefined) parts.push(`↵ ${entry.connect.note} — the pick lands when you return`)
    if (entry.state === 'refused' && entry.reason !== undefined) parts.push(entry.reason)
    if (entry.state === 'selectable') parts.push(`↵ sets the ${meta.label.toLowerCase()} model — live on the next call, no restart`)
    return parts.join(' · ')
  })()

  return (
    <Box flexDirection="column" width={width}>
      <Box width={width}>
        <Text wrap="truncate-end">
          <Text bold color={active ? accent : t.textMuted}>
            {meta.label}
          </Text>
          <Text color={t.textMuted}> — {meta.blurb} · </Text>
          <Text color={t.textPrimary}>{headerModel}</Text>
          <Text color={resolved.origin === 'env' ? t.warning : t.textMuted}>
            {`${headerEffort} · ${originWords}${cacheWords}`}
          </Text>
        </Text>
      </Box>
      {shedAbove > 0 ? (
        <Box height={1} overflow="hidden">
          <Text color={t.textMuted}>{`  ↑ +${shedAbove} more`}</Text>
        </Box>
      ) : null}
      {visible.map(([row, index]) => {
        const props = list.rowProps(row, index)
        if (row.kind === 'header') {
          const frontier = providerFrontierLine(row.family.source as never)
          const signedIn = row.family.credentialed
            ? (row.family.credentialLabel ?? 'signed in')
            : 'not signed in'
          return (
            <InteractiveRow key={props.id} {...props} width="100%" height={1}>
              {() => (
                <Text wrap="truncate-end">
                  <Text bold color={t.info}>
                    {row.family.label}
                  </Text>
                  <Text color={row.family.credentialed ? t.textMuted : t.warning}>{`  ${signedIn}`}</Text>
                  {frontier !== undefined ? <Text color={t.textMuted}>{`  ${frontier}`}</Text> : null}
                </Text>
              )}
            </InteractiveRow>
          )
        }
        const isUnset = row.kind === 'unset'
        const cur = current(row)
        const marker = cur ? GLYPH.ok : ' '
        const name = isUnset
          ? 'Unset — no model pinned'
          : (row as { entry: SubModelEntry }).entry.displayName
        const entry = isUnset ? undefined : (row as { entry: SubModelEntry }).entry
        const signedOut = entry?.state === 'signed-out'
        return (
          <InteractiveRow key={props.id} {...props} width="100%" height={1}>
            <Box flexShrink={0}>
              <Text>
                <Text color={cur ? t.success : t.textMuted}>{marker} </Text>
                <Text color={entry?.state === 'refused' ? t.textMuted : t.textPrimary}>
                  {padTo(truncateToWidth(name, nameW), nameW)}
                </Text>
              </Text>
            </Box>
            {isUnset ? (
              <Box flexGrow={1} flexShrink={1} overflow="hidden">
                <Text color={t.textMuted} wrap="truncate-end">
                  {' ↵ clears a saved pick'}
                </Text>
              </Box>
            ) : signedOut && entry?.connect !== undefined ? (
              <Box flexGrow={1} flexShrink={1} overflow="hidden">
                <Text color={t.warning} wrap="truncate-end">
                  {` ${entry.connect.note}`}
                </Text>
              </Box>
            ) : entry !== undefined && entry.state === 'selectable' && entry.description !== undefined && !compact ? (
              <Box flexGrow={1} flexShrink={1} overflow="hidden">
                <Text color={t.textMuted} wrap="truncate-end">
                  {` ${entry.description}`}
                </Text>
              </Box>
            ) : null}
          </InteractiveRow>
        )
      })}
      {shedBelow > 0 ? (
        <Box height={1} overflow="hidden">
          <Text color={t.textMuted}>{`  ↓ +${shedBelow} more`}</Text>
        </Box>
      ) : null}
      <Box height={1} overflow="hidden" marginTop={1}>
        <Text color={t.textMuted} wrap="truncate-end">
          {detail}
        </Text>
      </Box>
      <Box height={1} overflow="hidden">
        <Text
          color={(list.note ?? seedNote)?.includes('refused') || (list.note ?? seedNote)?.includes('not signed in') ? t.warning : t.textSecondary}
          wrap="truncate-end"
        >
          {list.note ?? seedNote ?? ''}
        </Text>
      </Box>
    </Box>
  )
}

export function SubModelPicker({
  onClose,
  onRoute,
  initialContainer = 'minerva',
  initialNote,
  initialModelId,
}: {
  onClose: () => void
  onRoute: (pick: SubModelRoutePick, note: string) => void
  initialContainer?: SubModelContainer
  initialNote?: string
  initialModelId?: string
}): React.ReactNode {
  const t = useMercuryTokens()
  const accent = useSessionAccent().accent
  const { columns, rows: termRows } = useTerminalSize()
  const [container, setContainer] = useState<SubModelContainer>(initialContainer)

  useInput((_input, key, event) => {
    if (key.tab || key.leftArrow || key.rightArrow) {
      event.stopImmediatePropagation()
      setContainer(prev => (prev === 'minerva' ? 'console' : 'minerva'))
    }
  })

  const width = Math.max(56, Math.min(100, columns - 6))
  const listRows = Math.max(4, termRows - 12)
  const mainModel = renderModelName(getMainLoopModel())

  return (
    <Box flexDirection="column" width={width}>
      {
}
      <Box width={width}>
        <Text wrap="truncate-end">
          {(['minerva', 'console'] as const).map(candidate => (
            <React.Fragment key={candidate}>
              <Text
                bold={candidate === container}
                color={candidate === container ? accent : t.textMuted}
              >
                {candidate === container ? `[${CONTAINER_META[candidate].label}]` : ` ${CONTAINER_META[candidate].label} `}
              </Text>
              <Text> </Text>
            </React.Fragment>
          ))}
          <Text color={t.textMuted}>{`· main: ${mainModel} — context only; /model changes it`}</Text>
        </Text>
      </Box>
      <ContainerList
        key={container}
        container={container}
        active
        width={width}
        listRows={listRows}
        onRoute={onRoute}
        onClose={onClose}
        compact={false}
        {...(container === initialContainer && initialNote !== undefined ? { initialNote } : {})}
        {...(container === initialContainer && initialModelId !== undefined ? { initialModelId } : {})}
      />
    </Box>
  )
}
