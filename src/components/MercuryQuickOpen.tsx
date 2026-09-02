import { isTopOverlayNow, useRegisterOverlay } from '../context/overlayContext.js';
import * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import { FAINT, IVORY, SECOND } from './mercuryPalette.js'
import TextInput from './TextInput.js'
import { CommandCenter, EmptyState, SectionHeader, StateBadge } from './mercury-ui/components.js'
import { GLYPH, padTo, truncateToWidth } from './mercury-ui/glyphs.js'
import { useSessionAccent } from './mercury-ui/sessionAccent.js'
import { applyNavMotion, decodeNavKey } from './mercury-ui/navSemantics.js'
import { useOpenEventGate } from './mercury-ui/useOpenEventGate.js'


export type QuickOpenItem = { label: string; detail?: string }

const LABEL_WIDTH = 40
const DETAIL_WIDTH = 24
const QUERY_WIDTH = 56
const MAX_ROWS = 12

function matches(item: QuickOpenItem, q: string): boolean {
  if (!q) return true
  const hay = `${item.label} ${item.detail ?? ''}`.toLowerCase()
  return hay.includes(q.toLowerCase())
}

export function MercuryQuickOpen({
  items,
  placeholder = 'type to filter…',
  onSelect,
  onClose,
  isActive = true,
}: {
  items?: QuickOpenItem[]
  placeholder?: string
  onSelect?: (item: QuickOpenItem) => void
  onClose: () => void
  isActive?: boolean
}): React.ReactNode {
  const overlayToken = useRegisterOverlay('quick-open');
  const accent = useSessionAccent().accent
  const all = Array.isArray(items) ? items : []
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const [cursorOffset, setCursorOffset] = useState(0)

  const filtered = useMemo(() => all.filter(it => matches(it, query)), [all, query])
  const shown = useMemo(() => filtered.slice(0, MAX_ROWS), [filtered])

  const pastOpenEvent = useOpenEventGate()

  useEffect(() => {
    setSel(s => Math.min(s, Math.max(0, shown.length - 1)))
  }, [shown.length])

  useInput(
    (input, key, event) => {
      if (!isActive) return
      const action = decodeNavKey(input, key, { orientation: 'vertical' })
      if (action === 'cancel') {
        if (overlayToken !== null && !isTopOverlayNow(overlayToken)) return
        event.stopImmediatePropagation()
        onClose()
        return
      }
      if (action === 'movePrevious' || action === 'moveNext') {
        event.stopImmediatePropagation()
        const target = applyNavMotion(action, sel, shown.length, { orientation: 'vertical' })
        if (target !== null) setSel(target)
        return
      }
    },
    { isActive },
  )

  return (
    <CommandCenter
      view="quick-open"
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
            const it = shown[Math.min(sel, Math.max(0, shown.length - 1))]
            if (it) onSelect?.(it)
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
          <EmptyState title="nothing to open" hint="no items were provided to the quick-open palette" />
        </Box>
      ) : filtered.length === 0 ? (
        <Box marginTop={1}>
          <EmptyState title="no matches" hint={`nothing matches "${truncateToWidth(query, 30)}" — backspace to widen`} />
        </Box>
      ) : (
        <>
          <SectionHeader count={filtered.length}>Results</SectionHeader>
          {shown.map((it, i) => {
            const here = i === sel
            return (
              <Text key={`${it.label}-${i}`}>
                <Text color={here ? accent : FAINT}>{here ? `${GLYPH.prompt} ` : '  '}</Text>
                <Text color={here ? IVORY : SECOND}>{padTo(truncateToWidth(it.label, LABEL_WIDTH), LABEL_WIDTH)}</Text>
                {it.detail ? <Text color={FAINT}>{truncateToWidth(it.detail, DETAIL_WIDTH)}</Text> : null}
              </Text>
            )
          })}
          {filtered.length > shown.length ? (
            <Text color={FAINT}>  +{filtered.length - shown.length} more — keep typing to narrow</Text>
          ) : null}
        </>
      )}
    </CommandCenter>
  )
}
