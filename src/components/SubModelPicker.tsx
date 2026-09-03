import * as React from 'react'
import { useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { GLYPH, padTo, truncateToWidth } from './mercury-ui/glyphs.js'
import { InteractiveRow } from './mercury-ui/InteractiveRow.js'
import { useInteractiveList } from './mercury-ui/useInteractiveList.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { useSessionAccent } from './mercury-ui/sessionAccent.js'
import { EffortStrip } from './mercury-ui/EffortStrip.js'
import { applyNavMotion, decodeNavKey } from './mercury-ui/navSemantics.js'
import { isTopOverlayNow, useRegisterOverlay } from '../context/overlayContext.js'
import type { EffortLevel } from '../utils/effort.js'
import { providerFrontierLine } from '../utils/model/providerFrontier.js'
import { getMainLoopModel, renderModelName } from '../utils/model/model.js'
import {
  canonicalSubModelId,
  composeSubModelRegistry,
  resolveSubModel,
  setSubModel,
  setSubModelEffort,
  subModelEffortClause,
  subModelEffortStrip,
  subModelEnvVar,
  SUB_MODEL_UNSET_HINT,
  type SubModelContainer,
  type SubModelEntry,
  type SubModelFamily,
  type SubModelRegistry,
} from '../utils/model/subModelSlots.js'

// ============================================================================
//  SubModelPicker — the /submodels surface: the two SUB-model containers
//  (MINERVA — the notepad curator · CONSOLE — the Helm side-question fork),
//  each offering the FULL catalogue the main /model picker offers — every
//  family, carriers included — with the per-family signed-in state. ONE
//  derivation feeds both containers' rows (composeSubModelRegistry — the
//  registry first-appearance family order, providerDisplayName labels, the
//  owning catalogue's refusal words verbatim); the sign-in facts are the
//  same ones /accounts renders. Availability recomposes at open and after
//  every action — never cached across them. A container is UNSET until the
//  operator pins a row (the choice is theirs); the Unset row clears a saved
//  pick, and an unset container answers the /submodels hint at zero cost.
//
//  Row grammar:
//    · selectable — ↵ persists the pick through the one validated writer
//      (setSubModel) and the receipt paints on the note line;
//    · signed-out — ↵ ROUTES to the family's attach home (/logins with the
//      family pre-focused, or the key-entry surface) with the pick armed;
//      the caller lands it on return — never a dead end;
//    · refused — inert on every channel, the typed reason painted inline
//      (the kit's one availability policy);
//    · e on a model row — the EFFORT STRIP (the main picker's strip, one
//      look): only the levels the one effort owner says that model offers
//      under this container's call context; ←→ choose, ↵ persists the
//      level PER CONTAINER (subModels.effort), esc keeps it; a model no
//      level can apply to answers a one-line receipt and opens nothing.
//  Esc closes one level. The main model is context here, never a row.
// ============================================================================

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

/** One container's list — the full catalogue under the family headers, the
 *  current resolution marked, availability recomposed after every action. */
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
  /** Row budget for the windowed list body. */
  listRows: number
  /** A landing note seeded by the caller (the returned-from-login apply). */
  initialNote?: string
  /** Open with the cursor on THIS row (the returned pick — applied or still
   *  honestly refused, the operator lands where they left). */
  initialModelId?: string
  onRoute: (pick: SubModelRoutePick, note: string) => void
  /** Esc on the (active) list closes the whole surface — one level. */
  onClose: () => void
  /** Narrow-pane rendering (the side-by-side shape): name column shrinks. */
  compact: boolean
}): React.ReactNode {
  const t = useMercuryTokens()
  const accent = useSessionAccent().accent
  const [epoch, setEpoch] = useState(0)
  // Availability is computed at READ: the registry recomposes on every
  // epoch bump (a set landed, a route returned) — never cached across them.
  // ONE row set serves both containers (the derivation takes no container).
  const registry = React.useMemo(() => composeSubModelRegistry(), [epoch])
  const resolved = resolveSubModel(container)
  const rows = React.useMemo(() => buildRows(registry), [registry])
  const [seedNote, setSeedNote] = useState<string | undefined>(initialNote)
  // THE EFFORT STRIP: open over one model row — its levels from the one
  // owner (subModelEffortStrip), the bracket on the level this container
  // would run. While it is up the list yields whole and the strip owns
  // every key (a modal layer on the overlay stack: esc closes it alone).
  const [strip, setStrip] = useState<{
    modelId: string
    displayName: string
    levels: readonly EffortLevel[]
    index: number
  } | null>(null)
  const stripOverlay = useRegisterOverlay('effort-strip', active && strip !== null)
  useInput(
    (input, key, event) => {
      if (strip === null) return
      const action = decodeNavKey(input, key, { orientation: 'horizontal' })
      if (action === 'cancel') {
        if (stripOverlay !== null && !isTopOverlayNow(stripOverlay)) return
        event.stopImmediatePropagation()
        setStrip(null)
        setSeedNote(
          `${CONTAINER_META[container].label.toLowerCase()} effort kept — ${strip.displayName} ${subModelEffortClause(container, strip.modelId)}`,
        )
        return
      }
      if (action === 'activate') {
        event.stopImmediatePropagation()
        const level = strip.levels[strip.index] as EffortLevel
        const result = setSubModelEffort(container, level)
        setStrip(null)
        setEpoch(n => n + 1)
        setSeedNote(result.ok ? result.receipt : result.reason)
        return
      }
      // Every other key is the strip's while it is up: a motion moves the
      // bracket (clamp, never wrap); the rest is swallowed so the list and
      // the container tab never act under an open strip.
      event.stopImmediatePropagation()
      if (action === null) return
      const target = applyNavMotion(action, strip.index, strip.levels.length, { orientation: 'horizontal' })
      if (target !== null) setStrip({ ...strip, index: target })
    },
    { isActive: active && strip !== null },
  )

  const list = useInteractiveList<PickerRow>({
    rows,
    rowId,
    active: active && strip === null,
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
            // No interactive attach surface exists for this family — the
            // press still answers with the honest route (configuration).
            return entry.connect?.note ?? entry.reason ?? 'not signed in'
          }
          return null
        },
      },
      {
        key: 'e',
        hint: 'effort',
        when: row => row.kind === 'entry' && row.entry.kind === 'model',
        run: (row): string | null => {
          if (!row || row.kind !== 'entry' || row.entry.kind !== 'model') return null
          setSeedNote(undefined)
          const offered = subModelEffortStrip(container, row.entry.modelId)
          // No level can apply to this model here: the receipt IS the
          // answer, and nothing opens (never a strip of levels the wire
          // would not carry).
          if (offered.kind === 'none') return offered.receipt
          setStrip({
            modelId: row.entry.modelId,
            displayName: row.entry.displayName,
            levels: offered.levels,
            index: Math.max(0, offered.levels.indexOf(offered.current)),
          })
          return null
        },
      },
    ],
  })

  // The cursor-following window (whole rows shed as ±N — never clipped).
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
  // The console's economy fact, stated where it is decided (an identical
  // model shares the main turn's prompt cache; a different one re-reads).
  // An unset console dispatches nothing, so no economy fact applies.
  const mainModel = canonicalSubModelId(getMainLoopModel())
  const cacheWords =
    container === 'console' && resolved.origin !== 'unset'
      ? resolved.model === mainModel
        ? ' · shares the main prompt cache'
        : ' · ≠ main — re-reads uncached'
      : ''
  const headerModel = resolved.origin === 'unset' ? 'unset' : renderModelName(resolved.model)
  // The effort truth per row, from the one owner through the container's
  // composers: the levels this model offers under THIS container's call
  // context, and the level it RUNS — the container's own dial where the
  // model offers it, else the model default with the fallback said aloud —
  // never a borrowed word. The header carries the short form for the
  // pinned model; the detail line spells the offered range.
  const effortRange = (modelId: string): string => {
    const offered = subModelEffortStrip(container, modelId)
    if (offered.kind === 'none') return offered.receipt
    return `effort ${offered.levels.join(' · ')} — ${subModelEffortClause(container, modelId)} · e sets it`
  }
  const headerEffort = ((): string => {
    if (resolved.origin === 'unset') return ''
    return ` · ${subModelEffortClause(container, resolved.model).replace(/^runs /, '')}`
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
    // The detail row is one truncate-end line at ≤100 cols: the hint (the
    // words an ask will answer with) leads, the cost fact trails.
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
        {strip !== null ? (
          // The strip paints on the detail line: the main picker's strip
          // grammar (one look), over ONLY this model's levels.
          <EffortStrip levels={strip.levels} current={strip.levels[strip.index]} accent={accent} faint={t.textMuted} />
        ) : (
          <Text color={t.textMuted} wrap="truncate-end">
            {detail}
          </Text>
        )}
      </Box>
      <Box height={1} overflow="hidden">
        {strip !== null ? (
          <Text color={t.textSecondary} wrap="truncate-end">
            {`${strip.displayName} · ←→ choose · ↵ sets the ${meta.label.toLowerCase()} effort · esc keeps it`}
          </Text>
        ) : (
          <Text
            color={(list.note ?? seedNote)?.includes('refused') || (list.note ?? seedNote)?.includes('not signed in') ? t.warning : t.textSecondary}
            wrap="truncate-end"
          >
            {list.note ?? seedNote ?? ''}
          </Text>
        )}
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
  /** A signed-out pick routes OUT: the caller closes this surface, arms the
   *  pick, and submits the attach command with the return chained. */
  onRoute: (pick: SubModelRoutePick, note: string) => void
  initialContainer?: SubModelContainer
  /** Landing note (the returned-from-login apply receipt). */
  initialNote?: string
  /** The returned pick's row — where the cursor opens. */
  initialModelId?: string
}): React.ReactNode {
  const t = useMercuryTokens()
  const accent = useSessionAccent().accent
  const { columns, rows: termRows } = useTerminalSize()
  const [container, setContainer] = useState<SubModelContainer>(initialContainer)

  // The container axis — tab (and ←→, which the vertical list declines)
  // switches; registered in the parent so both layouts share one grammar.
  useInput((_input, key, event) => {
    if (key.tab || key.leftArrow || key.rightArrow) {
      event.stopImmediatePropagation()
      setContainer(prev => (prev === 'minerva' ? 'console' : 'minerva'))
    }
  })

  const width = Math.max(56, Math.min(100, columns - 6))
  // Body budget: the shell (lockup + footer) and this surface's own chrome
  // (tab strip 1 + container header 1 + detail 1 + note 1 + margins) are
  // reserved; the windowed list gets the rest and sheds whole rows.
  const listRows = Math.max(4, termRows - 12)
  const mainModel = renderModelName(getMainLoopModel())

  return (
    <Box flexDirection="column" width={width}>
      {/* The container tab strip — ONE full-width list below. The ruled-out
          side-by-side shape clipped model names, sign-in routes, and dated
          frontier facts at 80 columns (and still clipped the dates at 120);
          a clipped date is no date, so the toggle shape is the surface. */}
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
