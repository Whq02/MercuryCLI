import { isTopOverlayNow, useRegisterOverlay } from '../context/overlayContext.js';
import * as React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import type { SuggestionItem } from './PromptInput/PromptInputFooterSuggestions.js'
import TextInput from './TextInput.js'
import { CommandCenter, EmptyState } from './mercury-ui/components.js'
import { displayWidth, GLYPH, truncateToWidth } from './mercury-ui/glyphs.js'
import { CockpitActiveContext } from '../context/cockpitActiveContext.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { applyNavMotion, decodeNavKey } from './mercury-ui/navSemantics.js'
import { cockpitBottomSlotReserve, viewportRows } from './mercury-ui/geometry.js'
import { useOpenEventGate } from './mercury-ui/useOpenEventGate.js'


type FileLoader = (query: string) => Promise<SuggestionItem[]>
const defaultLoadFiles: FileLoader = async query => {
  const { generateFileSuggestions } = await import('../hooks/fileSuggestions.js')
  return generateFileSuggestions(query, true)
}

const PATH_WIDTH = 52
const QUERY_WIDTH = 56
const MAX_ROWS = 12
const HEIGHT_RESERVE = 26
const MIN_ROWS = 4

export function MercuryFileOpen({
  onPick,
  onClose,
  isActive = true,
  loadFiles = defaultLoadFiles,
}: {
  onPick: (insertText: string) => void
  onClose: () => void
  isActive?: boolean
  loadFiles?: FileLoader
}): React.ReactNode {
  const overlayToken = useRegisterOverlay('file-open');
  const tokens = useMercuryTokens()
  const accent = tokens.accent
  const termRows = useTerminalSize().rows
  const cockpitActive = React.useContext(CockpitActiveContext)
  const rowCap = viewportRows(termRows, {
    reserve: cockpitActive ? cockpitBottomSlotReserve(termRows) : HEIGHT_RESERVE,
    min: MIN_ROWS,
    cap: MAX_ROWS,
  })
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const [cursorOffset, setCursorOffset] = useState(0)
  const [results, setResults] = useState<SuggestionItem[] | null>(null)
  const genRef = useRef(0)

  useEffect(() => {
    const gen = ++genRef.current
    let alive = true
    void loadFiles(query)
      .then(items => {
        if (alive && gen === genRef.current) setResults(items)
      })
      .catch(() => {
        if (alive && gen === genRef.current) setResults([])
      })
    return () => {
      alive = false
    }
  }, [query])

  const listRows = (results?.length ?? 0) > rowCap ? Math.max(1, rowCap - 1) : rowCap
  const shown = useMemo(() => (results ?? []).slice(0, listRows), [results, listRows])
  const loading = results === null
  const footer = loading
    ? 'indexing files…'
    : `${results?.length ?? 0} ${(results?.length ?? 0) === 1 ? 'file' : 'files'} · ↑↓ move · ↵ insert @path`

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
    <CommandCenter view="open file" elevated onClose={onClose} captureInput={false} footer={footer}>
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
            if (it) onPick(`@${it.displayText} `)
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
          placeholder="fuzzy-find a file to reference…"
        />
      </Box>

      {loading ? (
        <Box marginTop={1}>
          <Text color={tokens.textMuted}>scanning the working tree…</Text>
        </Box>
      ) : shown.length === 0 ? (
        <Box marginTop={1}>
          <EmptyState
            title="no files"
            hint={query ? `nothing matches "${truncateToWidth(query, 30)}" — backspace to widen` : 'no files in the working tree'}
          />
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          {shown.map((it, i) => {
            const here = i === sel
            const p = truncateToWidth(it.displayText, PATH_WIDTH)
            const pad = ' '.repeat(Math.max(0, PATH_WIDTH - displayWidth(p)))
            return (
              <Text key={it.id}>
                <Text color={here ? accent : tokens.textMuted}>{here ? `${GLYPH.prompt} ` : '  '}</Text>
                <Text color={here ? accent : tokens.textSecondary}>@</Text>
                <Text color={here ? tokens.textPrimary : tokens.textSecondary}>{p}</Text>
                {pad}
                {it.description ? <Text color={tokens.textMuted}>{truncateToWidth(it.description, 16)}</Text> : null}
              </Text>
            )
          })}
          {(results?.length ?? 0) > shown.length ? (
            <Text color={tokens.textMuted}>  +{(results?.length ?? 0) - shown.length} more — keep typing to narrow</Text>
          ) : null}
        </Box>
      )}
    </CommandCenter>
  )
}
