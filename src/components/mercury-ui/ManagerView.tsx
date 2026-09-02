import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { useModalOrTerminalSize } from '../../context/modalContext.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, Text, useInput } from '../../ink.js'
import {
  groupedNormalSurfaces,
  type EffectiveSurface,
} from '../../commands/effectiveCatalogue.js'
import { FAINT, IVORY, SECOND, TERRA } from '../mercuryPalette.js'
import { Sigil } from './assets.js'
import { CommandCenter, EmptyState, SectionHeader } from './components.js'
import { GLYPH, truncateToWidth } from './glyphs.js'
import {
  managerMetaLine,
  emphasisSegments,
  matchesSurfaceQuery,
  surfaceQueryTokens,
} from './managerFilter.js'
import { paneWindow } from './paneWindow.js'
import { useSessionAccent } from './sessionAccent.js'
import { useInteractiveList } from './useInteractiveList.js'
import { useOpenEventGate } from './useOpenEventGate.js'
import { InteractiveRow } from './InteractiveRow.js'

// ============================================================================
//  ManagerView — the /manager surface index.
//
//  A category-grouped, arrow-navigable index of every NORMALLY DISCOVERABLE
//  built-in surface, projected from the ONE effective catalogue
//  (src/commands/effectiveCatalogue.ts — the registry seam). No hand-written
//  surface array, no curated state map, no gallery hops into specimens: rows
//  ARE the enabled normal roster (identical, by construction, to what
//  typeahead//help//palette surface for built-ins), and ↵ LAUNCHES the
//  selected surface by submitting its real slash command through the parent
//  (the /palette pattern) — a real navigation, never a mock.
//
//  Replaces RoomManagerView (hand sections over curated snapshots that routed
// normal discovery into design galleries — the hidden-route leak).
//
//  SEARCH: the header's duplicated title
//  line became a quiet filter row (the PaletteView query idiom). Typing
//  filters the whole roster live on the managerFilter token-AND grammar
//  (name + description); group headers collapse with their surviving rows
//  by the existing consecutive-groupLabel derivation, so empty groups
//  vanish for free. An empty query keeps the ORIGINAL rows array — the
//  resting view stays byte-identical (capture stability). Esc follows the
// filter-surface house law (CoordinatorModelPicker layering): the
//  query handler registers BEFORE the list hook, so the FIRST esc clears a
//  non-empty query and the next one falls through to the list's own cancel.
// ============================================================================

type FlatRow = { surface: EffectiveSurface; groupLabel: string }

const NAME_W = 15

export function ManagerView({
  onClose,
  onPick,
}: {
  onClose: () => void
  /** Launch the picked surface: the parent submits `/<name>` for real. */
  onPick: (name: string) => void
}): React.ReactNode {
  const accent = useSessionAccent().accent
  const { columns, rows: termRows } = useTerminalSize()
  // Built once per mount: the enabled normal roster, category-grouped. A
  // stable list keeps selection identity simple; reopening re-reads env/auth.
  const [flat] = useState<FlatRow[]>(() =>
    groupedNormalSurfaces().flatMap(g =>
      g.surfaces
        // Launching /surfaces from /surfaces is a no-op loop — skip self.
        .filter(s => s.name !== 'surfaces')
        .map(surface => ({ surface, groupLabel: g.label })),
    ),
  )

  const [query, setQuery] = useState('')
  // Batch-safe query mirror (the liveIndexRef idiom): a burst of keys in ONE
  // input batch must each build on the previous press, not the pre-batch
  // render state.
  const liveQueryRef = useRef(query)
  liveQueryRef.current = query
  // The focused row as of the last commit — read by applyQuery to decide
  // whether a filter change evicted the focus (declared before the input
  // handler, assigned after the list hook below).
  const selectedRowRef = useRef<FlatRow | null>(null)
  const focusFirstRef = useRef(false)
  const pastOpenEvent = useOpenEventGate()

  const applyQuery = (next: string): void => {
    liveQueryRef.current = next
    setQuery(next)
    // First-match focus law: a filter change that evicts the focused row
    // re-anchors the cursor on the first surviving match (the effect below
    // runs after the commit; useStableSelection's positional heal alone
    // would strand it mid-list). A widened filter never evicts, so the
    // stable-id cursor keeps the focus through backspace and clear.
    const nextTokens = surfaceQueryTokens(next)
    const focused = selectedRowRef.current
    if (
      nextTokens.length > 0 &&
      focused !== null &&
      !matchesSurfaceQuery(focused.surface, nextTokens)
    ) {
      focusFirstRef.current = true
    }
  }

  // The search row's input, layered BEFORE the list hook (the
  // CoordinatorModelPicker idiom): printables/backspace feed the query,
  // the FIRST esc clears it — each consumed with stopImmediatePropagation so
  // the list never sees them — and an empty-query esc falls through to the
  // list's own cancel path (the second esc closes).
  useInput((input, key, event) => {
    if (key.escape && liveQueryRef.current.length > 0) {
      event.stopImmediatePropagation()
      applyQuery('')
      return
    }
    // Text entry waits out the launch gate (useOpenEventGate doctrine): the
    // opening chord's tail (ctrl+x m) must never seed the query.
    if (!pastOpenEvent()) return
    if ((key.backspace || key.delete) && liveQueryRef.current.length > 0) {
      event.stopImmediatePropagation()
      applyQuery(liveQueryRef.current.slice(0, -1))
      return
    }
    if (
      input.length > 0 &&
      !key.ctrl &&
      !key.meta &&
      !key.tab &&
      !key.return &&
      !key.escape &&
      !key.upArrow &&
      !key.downArrow &&
      !key.leftArrow &&
      !key.rightArrow &&
      !key.pageUp &&
      !key.pageDown
    ) {
      event.stopImmediatePropagation()
      applyQuery(liveQueryRef.current + input)
    }
  })

  const tokens = surfaceQueryTokens(query)
  // No tokens ⇒ the ORIGINAL array (never a copy): the resting view renders
  // byte-identically through the exact pre-search path.
  const filtered =
    tokens.length === 0 ? flat : flat.filter(f => matchesSurfaceQuery(f.surface, tokens))

  const { selectedIndex: sel, selectedRow, note, hints, moveTo, rowProps } = useInteractiveList({
    rows: filtered,
    rowId: f => f.surface.name,
    idNamespace: 'manager',
    onClose,
    actions: [
      {
        key: 'return',
        hint: 'open',
        run: f => {
          if (!f)
            return tokens.length > 0
              ? 'no surfaces match — esc clears the filter'
              : 'no surfaces to open'
          onPick(f.surface.name)
          return null
        },
      },
    ],
  })
  selectedRowRef.current = selectedRow

  // The deferred half of the first-match focus law: armed by applyQuery,
  // lands after the commit that carries the new filtered rows.
  useEffect(() => {
    if (!focusFirstRef.current) return
    focusFirstRef.current = false
    moveTo(0)
  })

  const showDesc = columns >= 96
  const descW = Math.max(16, columns - NAME_W - 14)

  // Cursor-following window: budget the
  // PAINTED non-list lines — CommandCenter border 2 + header 1 + intro 4 +
  // note/hint 2 + footer 2 = 11, + 2 budgeted overflow counters (the LUSTRE
  // L4 lesson: an unbudgeted counter squeezes a mid-list row) + 8 for the ≤4
  // SectionHeaders a realistic window spans (marginTop + rule each).
  // Conservative on purpose — the modal pane clips at the BOTTOM, so
  // under-showing beats losing the footer. Inside the modal the context
  // reports the pane's true rows; outside it falls back to the terminal.
  // (The search row occupies the exact line the removed title held, so the
  // intro count is unchanged.)
  const availRows = useModalOrTerminalSize({ rows: termRows, columns }).rows
  const rowCap = Math.max(4, availRows - 21)
  const win = paneWindow(filtered.length, sel, rowCap)

  return (
    <CommandCenter
      view="surfaces"
      onClose={onClose}
      captureInput={false}
      footer={query === '' ? hints : `${hints ?? '↵ open'} · esc clears the filter`}
    >
      <Box marginTop={1} flexDirection="row">
        <Sigil size="small" />
        <Box flexDirection="column" marginLeft={2}>
          <Box>
            <Text color={TERRA}>{GLYPH.prompt} </Text>
            <Text color={IVORY}>{truncateToWidth(query, 48)}</Text>
            <Text color={FAINT}>{query === '' ? 'type to filter…' : GLYPH.caretBlock}</Text>
          </Box>
          <Text color={FAINT}>
            {managerMetaLine(filtered.length, flat.length, tokens.length > 0)}
          </Text>
        </Box>
      </Box>

      {tokens.length > 0 && filtered.length === 0 ? (
        <Box marginTop={1}>
          <EmptyState
            title="No surfaces match"
            hint="backspace widens · esc clears the filter"
            tone="gated"
          />
        </Box>
      ) : null}

      {win.above > 0 ? <Text color={FAINT}>{'  '}↑ {win.above} more</Text> : null}
      {filtered.map((f, i) => {
        // Window at RENDER over the full array — absolute `i` keeps
        // selection/pointer identity in the full-list index space (slicing
        // with local indices would resurrect the hidden-index class).
        if (i < win.start || i >= win.end) return null
        const here = i === sel
        // The first visible row always re-paints its group label, so a
        // mid-group window start still names its section.
        const head = i === win.start || filtered[i - 1]!.groupLabel !== f.groupLabel
        return (
          <React.Fragment key={f.surface.name}>
            {head ? <SectionHeader>{f.groupLabel}</SectionHeader> : null}
            <InteractiveRow {...rowProps(f, i)}>
              <Text>
                <Text color={here ? accent : FAINT}>{here ? '▸ ' : '  '}</Text>
                <Text color={here ? IVORY : SECOND}>
                  {emphasisSegments(`/${f.surface.name}`.padEnd(NAME_W), tokens).map((seg, k) => (
                    <Text key={k} bold={seg.hit}>{seg.text}</Text>
                  ))}
                </Text>
                {showDesc ? (
                  <Text color={FAINT}>
                    {' '}
                    {emphasisSegments(truncateToWidth(f.surface.description, descW), tokens).map((seg, k) => (
                      <Text key={k} bold={seg.hit}>{seg.text}</Text>
                    ))}
                  </Text>
                ) : null}
              </Text>
            </InteractiveRow>
          </React.Fragment>
        )
      })}
      {win.below > 0 ? <Text color={FAINT}>{'  '}↓ {win.below} more</Text> : null}

      {note ? (
        <Box marginTop={1}>
          <Text color={FAINT}>{note}</Text>
        </Box>
      ) : query !== '' ? (
        <Box marginTop={1}>
          <Text color={FAINT}>↵ opens the surface · esc clears the filter</Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text color={FAINT}>
            ↵ opens the surface · esc returns · open from anywhere with{' '}
            <Text color={IVORY}>ctrl+x m</Text>
          </Text>
        </Box>
      )}
    </CommandCenter>
  )
}
