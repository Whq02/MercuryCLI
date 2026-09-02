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
  const overlayToken = useRegisterOverlay('search', true, { ownsPageKeys: true })
  const accent = useSessionAccent().accent
  const all = Array.isArray(results) ? results : []
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const [cursorOffset, setCursorOffset] = useState(0)

  const filtered = useMemo(
    () => (prefiltered ? all : all.filter(h => matches(h, query))),
    [all, query, prefiltered],
  )
  const winStart = Math.max(0, Math.min(sel - Math.floor(MAX_ROWS / 2), filtered.length - MAX_ROWS))
  const shown = useMemo(() => filtered.slice(winStart, winStart + MAX_ROWS), [filtered, winStart])

  const pastOpenEvent = useOpenEventGate()

  useEffect(() => {
    setSel(s => Math.min(s, Math.max(0, filtered.length - 1)))
  }, [filtered.length])

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
      footer={filtered.length > 0 ? 'type · ↑↓ move · ↵ open' : 'type — backspace to widen'}
    >
      <Box marginTop={1}>
        <Text color={accent}>{GLYPH.prompt} </Text>
        {
}
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
