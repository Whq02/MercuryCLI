import * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import { FAINT, IVORY, SECOND } from './mercuryPalette.js'
import TextInput from './TextInput.js'
import { CommandCenter, EmptyState, SectionHeader } from './mercury-ui/components.js'
import { GLYPH, padTo, truncateToWidth } from './mercury-ui/glyphs.js'
import { isTopOverlayNow, useRegisterOverlay } from '../context/overlayContext.js'
import { useSessionAccent } from './mercury-ui/sessionAccent.js'
import { applyNavMotion, decodeNavKey } from './mercury-ui/navSemantics.js'
import { useOpenEventGate } from './mercury-ui/useOpenEventGate.js'

// ============================================================================
//  MercurySearch — the warm-ink search surface (history / global search). A
//  filtered list over the results passed in: ONE useInput owns BOTH the query
//  buffer (typed chars append, backspace deletes) AND row nav (↑↓ clamp, never
//  wrap), ↵ picks the highlighted hit, esc closes. isActive-gated so it never
//  fights the REPL, 150ms enter-buffer so the launching Enter can't pick the
//  first hit. The result list is bounded with a `+N more`; each hit's title +
//  snippet truncate to the column width; honest states for loading, "no items",
//  and "no match". When `results` are pre-filtered upstream, pass `prefiltered`
//  so this surface shows them as-is instead of re-filtering by the local query.
// ============================================================================

export type SearchHit = { title: string; snippet?: string; meta?: string }

const TITLE_WIDTH = 38
const SNIPPET_WIDTH = 30
const QUERY_WIDTH = 56
const MAX_ROWS = 12

function matches(hit: SearchHit, q: string): boolean {
  if (!q) return true
  const hay = `${hit.title} ${hit.snippet ?? ''} ${hit.meta ?? ''}`.toLowerCase()
  return hay.includes(q.toLowerCase())
}

export function MercurySearch({
  results,
  loading = false,
  prefiltered = false,
  placeholder = 'type to search…',
  onSelect,
  onClose,
  isActive = true,
}: {
  results?: SearchHit[]
  loading?: boolean
  prefiltered?: boolean
  placeholder?: string
  onSelect?: (hit: SearchHit) => void
  onClose: () => void
  isActive?: boolean
}): React.ReactNode {
  // ownsPageKeys: this surface windows over the FULL result set (winStart),
  // so PageUp/PageDown are a real pager while it is top (MINI-TEMPER item 2).
  const overlayToken = useRegisterOverlay('search', true, { ownsPageKeys: true })
  // LIVE accent subscription — a /critter re-tint repaints the open search.
  const accent = useSessionAccent().accent
  const all = Array.isArray(results) ? results : []
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  // Grapheme cursor for the REAL query editor (MINI-TEMPER item 2).
  const [cursorOffset, setCursorOffset] = useState(0)

  const filtered = useMemo(
    () => (prefiltered ? all : all.filter(h => matches(h, query))),
    [all, query, prefiltered],
  )
  // Cursor-following window over the FULL result set.
  const winStart = Math.max(0, Math.min(sel - Math.floor(MAX_ROWS / 2), filtered.length - MAX_ROWS))
  const shown = useMemo(() => filtered.slice(winStart, winStart + MAX_ROWS), [filtered, winStart])

  // Swallow the launching chord's trailing key so it can't seed the query — as
  // a open-event seq gate (event identity, not wall-clock), not the old setTimeout→setState flag whose
  // parked commit could swallow the first keypress for seconds (the
  // §STALE-PAINT idle-parked-commits; swept). esc/arrows
  // respond ungated per the doctrine; only the keys that ACT (↵ · backspace ·
  // typing) wait out the buffer.
  const pastOpenEvent = useOpenEventGate()

  useEffect(() => {
    setSel(s => Math.min(s, Math.max(0, filtered.length - 1)))
  }, [filtered.length])

  // List nav through the ONE semantic vocabulary; handled keys consumed
  // (MINI-TEMPER item 2). This surface windows over the FULL result set, so
  // PageUp/PageDown page by the real viewport. Typing/editing belongs to the
  // query editor below.
  useInput(
    (input, key, event) => {
      if (!isActive) return
      const action = decodeNavKey(input, key, { orientation: 'vertical', pageKeys: true })
      if (action === 'cancel') {
        if (overlayToken !== null && !isTopOverlayNow(overlayToken)) return
        event.stopImmediatePropagation()
        onClose()
        return
      }
      if (
        action === 'movePrevious' ||
        action === 'moveNext' ||
        action === 'pagePrevious' ||
        action === 'pageNext'
      ) {
        event.stopImmediatePropagation()
        const target = applyNavMotion(action, sel, filtered.length, {
          orientation: 'vertical',
          pageSize: MAX_ROWS,
        })
        if (target !== null) setSel(target)
        return
      }
    },
    { isActive },
  )

  if (loading) {
    return (
      <CommandCenter view="search" onClose={onClose}>
        <Box marginTop={1}>
          <Text color={FAINT}>searching…</Text>
        </Box>
      </CommandCenter>
    )
  }

  return (
    <CommandCenter
      view="search"
      onClose={onClose}
      captureInput={false}
      // move/open verbs only when rows exist.
      footer={filtered.length > 0 ? 'type · ↑↓ move · ↵ open' : 'type — backspace to widen'}
    >
      <Box marginTop={1}>
        <Text color={accent}>{GLYPH.prompt} </Text>
        {/* The query is Mercury's ONE editor machinery (MINI-TEMPER item 2) —
            same contract as the command palette's field. */}
        <TextInput
          value={query}
          onChange={q => {
            setQuery(q.replace(/[\r\n\t]+/g, ' '))
            setSel(0)
          }}
          onSubmit={() => {
            if (!pastOpenEvent()) return
            const h = filtered[Math.min(sel, Math.max(0, filtered.length - 1))]
            if (h) onSelect?.(h)
          }}
          focus={isActive}
          showCursor={true}
          multiline={false}
          disableCursorMovementForUpDownKeys={true}
          disableEscapeDoublePress={true}
          disablePageKeyCursorMovement={true}
          inputFilter={input => (pastOpenEvent() ? input : '')}
          columns={QUERY_WIDTH}
          cursorOffset={cursorOffset}
          onChangeCursorOffset={setCursorOffset}
          placeholder={placeholder}
        />
      </Box>

      {all.length === 0 ? (
        <Box marginTop={1}>
          <EmptyState title="nothing to search" hint="no results were provided to the search surface" />
        </Box>
      ) : filtered.length === 0 ? (
        <Box marginTop={1}>
          <EmptyState title="no matches" hint={`nothing matches "${truncateToWidth(query, 30)}" — backspace to widen`} />
        </Box>
      ) : (
        <>
          <SectionHeader count={filtered.length}>Results</SectionHeader>
          {shown.map((h, i) => {
            const here = winStart + i === sel
            return (
              <Box key={`${h.title}-${i}`} flexDirection="column">
                <Text>
                  <Text color={here ? accent : FAINT}>{here ? `${GLYPH.prompt} ` : '  '}</Text>
                  <Text color={here ? IVORY : SECOND}>{padTo(truncateToWidth(h.title, TITLE_WIDTH), TITLE_WIDTH)}</Text>
                  {h.snippet ? <Text color={FAINT}>{truncateToWidth(h.snippet, SNIPPET_WIDTH)}</Text> : null}
                </Text>
                {here && h.meta ? <Text color={FAINT}>    {truncateToWidth(h.meta, 60)}</Text> : null}
              </Box>
            )
          })}
          {filtered.length > MAX_ROWS ? (
            <Text color={FAINT}>  {sel + 1}/{filtered.length} · ↑↓ walks the full list</Text>
          ) : null}
        </>
      )}
    </CommandCenter>
  )
}
