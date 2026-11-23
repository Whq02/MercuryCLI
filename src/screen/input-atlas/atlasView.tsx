import * as React from 'react'
import { Box, Text } from '../themedRenderer.js'
import type { AtlasRow, LookupReport } from '../keys/atlas.js'
import type { useKeybindingContext } from '../keys/KeybindingContext.js'
import type { KeybindingContextName, ParsedBinding, ParsedKeystroke } from '../keys/types.js'
import TextInput from '../composer/text-input/TextInput.js'
import { CommandCenter, EmptyState } from '../widgets/components.js'
import { GLYPH, padTo, truncateToWidth } from '../theme/glyphs.js'
import { InteractiveRow } from '../widgets/InteractiveRow.js'
import type { useMercuryTokens } from '../widgets/useMercuryTokens.js'

type Tokens = ReturnType<typeof useMercuryTokens>

export function atlasViewOf({
  t,
  kb,
  query,
  setQuery,
  cursorOffset,
  setCursorOffset,
  sel,
  setSel,
  mode,
  report,
  pending,
  notice,
  inspected,
  filtered,
  winStart,
  shown,
  current,
  liveContexts,
  footer,
  onClose,
  stateTone,
  LookupView,
  RowDetail,
  CHORD_WIDTH,
  ACTION_WIDTH,
  QUERY_WIDTH,
}: {
  t: Tokens
  kb: ReturnType<typeof useKeybindingContext>
  query: string
  setQuery: React.Dispatch<React.SetStateAction<string>>
  cursorOffset: number
  setCursorOffset: React.Dispatch<React.SetStateAction<number>>
  sel: number
  setSel: React.Dispatch<React.SetStateAction<number>>
  mode: 'browse' | 'lookup' | 'rebind'
  report: LookupReport | null
  pending: ParsedKeystroke[] | null
  notice: string | null
  inspected: KeybindingContextName
  filtered: AtlasRow[]
  winStart: number
  shown: AtlasRow[]
  current: AtlasRow | undefined
  liveContexts: KeybindingContextName[]
  footer: string
  onClose: () => void
  stateTone: (row: AtlasRow, t: Tokens) => string
  LookupView: (props: { report: LookupReport | null; pending: ParsedKeystroke[] | null; live: boolean }) => React.ReactNode
  RowDetail: (props: { row: AtlasRow; bindings: readonly ParsedBinding[] }) => React.ReactNode
  CHORD_WIDTH: number
  ACTION_WIDTH: number
  QUERY_WIDTH: number
}): React.ReactNode {
  return (
    <CommandCenter
      view="input atlas"
      subtitle={`${inspected}${inspected === 'Global' ? '' : ' + Global'}`}
      elevated
      onClose={onClose}
      captureInput={false}
      footer={footer}
    >
      <>
          <Box marginTop={1}>
            <Text color={t.accent}>{GLYPH.prompt} </Text>
            <TextInput
              value={query}
              onChange={q => {
                setQuery(q.replace(/[\r\n\t]+/g, ' '))
                setSel(0)
              }}
              focus={mode === 'browse'}
              showCursor={mode === 'browse'}
              multiline={false}
              disableCursorMovementForUpDownKeys={true}
              disableEscapeDoublePress={true}
              disablePageKeyCursorMovement={true}
              columns={QUERY_WIDTH}
              cursorOffset={cursorOffset}
              onChangeCursorOffset={setCursorOffset}
              placeholder="find an action by name or by what it does…"
            />
          </Box>

          <Text color={t.textMuted}>
            {`  focus now: ${liveContexts.length > 0 ? liveContexts.join(', ') : 'Global'}`}
          </Text>

          {mode === 'lookup' || report ? (
            <LookupView report={report} pending={pending} live={mode === 'lookup'} />
          ) : null}

          {filtered.length === 0 ? (
            <Box marginTop={1}>
              <EmptyState
                title="no actions match"
                hint={`nothing in ${inspected} matches "${truncateToWidth(query, 24)}" — backspace to widen, tab for another context`}
              />
            </Box>
          ) : (
            <Box marginTop={1} flexDirection="column">
              {shown.map((row, i) => {
                const abs = winStart + i
                const here = abs === sel
                return (
                  <InteractiveRow
                    key={`${row.context}:${row.action}:${row.chord}:${abs}`}
                    id={`atlas:row:${row.action}`}
                    width="100%"
                    selected={here}
                    onSelect={() => setSel(abs)}
                  >
                    <Text wrap="truncate-end">
                      <Text color={here ? t.accent : t.textMuted}>
                        {here ? `${GLYPH.cursor} ` : '  '}
                      </Text>
                      <Text color={stateTone(row, t)}>
                        {padTo(row.chord === '' ? '—' : row.chord, CHORD_WIDTH)}
                      </Text>
                      <Text color={here ? t.textPrimary : t.textSecondary}>
                        {padTo(truncateToWidth(String(row.action ?? '(unbind)'), ACTION_WIDTH - 1), ACTION_WIDTH)}
                      </Text>
                      <Text color={t.textMuted}>{row.description}</Text>
                    </Text>
                  </InteractiveRow>
                )
              })}
            </Box>
          )}

          {current ? <RowDetail row={current} bindings={kb.bindings} /> : null}
          {notice ? (
            <Text color={t.info}>{`  ${GLYPH.spark} ${notice}`}</Text>
          ) : null}
        </>
    </CommandCenter>
  )
}
