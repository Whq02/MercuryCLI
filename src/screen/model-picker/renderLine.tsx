import figures from 'figures'
import * as React from 'react'
import { Box, Text } from '../themedRenderer.js'
import type { useMercuryTokens } from '../widgets/useMercuryTokens.js'
import { displayWidth, padTo, GLYPH, truncateToWidth } from '../theme/glyphs.js'
import { InteractiveRow } from '../widgets/InteractiveRow.js'
import { FAINT, IVORY, SAND } from '../theme/mercuryPalette.js'
import { FOLD_CLOSED_LEAD, FOLD_OPEN_LEAD } from '../widgets/menuFold.js'
import {
  MODEL_PICKER_NO_ALIAS,
  doorWords,
  hasAlias,
  headingWords,
  isModelRow,
  moreLineWords,
  pickerCellColumns,
  pickerIdSpan,
  pickerIdText,
  type PickerColumns,
  type PickerLine,
  type ProviderHeading,
} from '../../models/facts/modelPickerGroups.js'
import { TensorFoldCard, tensorFoldInk } from '../tensorfold/TensorFoldCard.js'
import type { ModelChoice } from './choice.js'
import type { pickerActs, pickerCursor } from './moves.js'

const cell = (text: string, width: number): string => (width <= 2 ? '' : `${padTo(text, width - 2)}  `)
const idAndState = (id: string, state: string, columns: PickerColumns, spare: number, listed: readonly string[]): [string, string] => {
  const widths = pickerIdSpan(columns, displayWidth(id), displayWidth(state), spare)
  return [cell(pickerIdText(id, widths.id - 2, listed), widths.id), state === '' ? ' '.repeat(widths.state) : cell(state, widths.state)]
}

type LineArgs = Pick<ReturnType<typeof pickerCursor>, 'selectRow'> &
  Pick<ReturnType<typeof pickerActs>, 'commitCurrent'> & {
    i: number
    headings: Record<string, ProviderHeading> | undefined
    inner: number
    TERRA: string
    tokens: ReturnType<typeof useMercuryTokens>
    compact: boolean
    narrowId: boolean
    cardWidth: number
    stateWordOf: (m: ModelChoice, key: string) => [string, string]
    focusedSupports1m: boolean
    focusedGptToggle: boolean
    context1m: boolean
    columns: PickerColumns
    listed: readonly string[]
  }

export function pickerLineRenderer({ i, headings, inner, selectRow, commitCurrent, TERRA, tokens, compact, narrowId, cardWidth, stateWordOf, focusedSupports1m, focusedGptToggle, context1m, columns, listed }: LineArgs) {
  const spareOf = (cells: PickerColumns): number => Math.max(0, cells.tail - (compact ? 1 : 0))
  const renderLine = (line: PickerLine<ModelChoice>, idx: number): React.ReactNode => {
    if (line.kind === 'heading') {
      const on = idx === i
      const heading = headings?.[line.group]
      const words = headingWords(heading, line.group, { live: line.live, ...(line.matched !== undefined ? { matched: line.matched, total: line.total ?? 0 } : {}) }, inner - 2)
      const cut = words.indexOf(' · ')
      const name = cut < 0 ? words : words.slice(0, cut)
      const rest = cut < 0 ? '' : words.slice(cut)
      return (
        <InteractiveRow key={`heading:${line.group}`} id={`model:group:${line.group}`} selected={on} onSelect={() => selectRow(idx)} onActivate={commitCurrent} width={inner} height={1} selectionBand={true}>
          <Text wrap="truncate-end">
            <Text color={on ? TERRA : FAINT}>{on ? `${GLYPH.prompt} ` : line.fold === 'folded' ? FOLD_CLOSED_LEAD : FOLD_OPEN_LEAD}</Text>
            <Text bold color={tokens.info}>{name}</Text>
            <Text color={FAINT}>{rest}</Text>
          </Text>
        </InteractiveRow>
      )
    }
    if (line.kind === 'door') {
      const door = headings?.[line.group]?.doors.find(candidate => candidate.door === line.door)
      const words = doorWords(door ?? { door: line.door }, { live: line.live, ...(line.matched !== undefined ? { matched: line.matched, total: line.total ?? 0 } : {}) }, inner - 2)
      return (
        <Box key={`door:${line.group}:${line.door}`} height={1}>
          <Text color={tokens.textSecondary} wrap="truncate-end">{`  ${words}`}</Text>
        </Box>
      )
    }
    if (line.kind === 'more') {
      const on = idx === i
      return (
        <InteractiveRow key={`more:${line.group}`} id={`model:more:${line.group}`} selected={on} onSelect={() => selectRow(idx)} onActivate={commitCurrent} width={inner} height={1} selectionBand={true}>
          <Text wrap="truncate-end">
            <Text color={on ? TERRA : FAINT}>{on ? `${GLYPH.prompt} ` : '  '}</Text>
            <Text color={FAINT}>{moreLineWords(line.hidden, line.reach)}</Text>
          </Text>
        </InteractiveRow>
      )
    }
    const m = line.row
    const on = idx === i
    if (m.tensorfold !== undefined) {
      const choice = m.tensorfold
      const cells = pickerCellColumns(inner - 4)
      if (compact && narrowId) cells.id = Math.max(0, cells.id - 1)
      const ink = (tone: Parameters<typeof tensorFoldInk>[0]): string => tensorFoldInk(tone, tokens, TERRA)
      const memory = truncateToWidth(choice.memory?.text ?? '', cells.tail)
      const [idText, stateText] = idAndState(m.id, choice.state?.text ?? '', cells, memory === '' ? spareOf(cells) : 0, listed)
      return (
        <InteractiveRow key={line.key} id={`model:row:${line.key}`} selected={on} onSelect={() => selectRow(idx)} onActivate={commitCurrent} flexDirection="column" selectionBand={compact}>
          <Box borderStyle={on && !compact ? 'round' : undefined} borderColor={on && !compact ? TERRA : undefined} paddingLeft={on && !compact ? 1 : 2} paddingRight={1} flexDirection="column">
            <Text wrap="truncate-end">
              {compact ? <Text color={on ? TERRA : FAINT}>{on ? `${figures.pointer} ` : '  '}</Text> : null}
              {m.action === true ? (
                <>
                  <Text bold color={IVORY}>{m.name}</Text>
                  {choice.words !== undefined ? <Text color={FAINT}>{` — ${choice.words}`}</Text> : null}
                  {choice.state !== undefined ? <Text color={ink(choice.state.tone)}>{`  ${choice.state.text}`}</Text> : null}
                </>
              ) : (
                <>
                  <Text bold color={IVORY}>{cell(m.name, cells.alias)}</Text>
                  <Text color={FAINT}>{idText}</Text>
                  <Text color={ink(choice.state?.tone ?? 'faint')}>{stateText}</Text>
                  <Text color={FAINT}>{cell(m.ctx, cells.ctx)}</Text>
                  <Text color={ink(choice.memory?.tone ?? 'faint')}>{memory}</Text>
                </>
              )}
            </Text>
            {on && !compact ? <TensorFoldCard lines={choice.card(cardWidth)} tokens={tokens} accent={TERRA} /> : null}
          </Box>
        </InteractiveRow>
      )
    }
    const [stateWord, stateColor] = stateWordOf(m, line.key)
    const model = isModelRow(m)
    const alias = model ? (hasAlias(m) ? m.name : '—') : m.name
    const ctxText = on && (focusedSupports1m || focusedGptToggle) ? (context1m ? (m.ctx1m ?? m.ctx) : (m.ctxBase ?? m.ctx)) : m.ctx
    const tail = model && !hasAlias(m) ? truncateToWidth(MODEL_PICKER_NO_ALIAS, columns.tail) : ''
    const [idText, stateText] = idAndState(m.id, stateWord, columns, tail === '' ? spareOf(columns) : 0, listed)
    return (
      <InteractiveRow
        key={line.key}
        id={`model:row:${line.key}`}
        selected={on}
        unavailable={m.gated}
        onSelect={() => selectRow(idx)}
        onActivate={commitCurrent}
        flexDirection="column"
        selectionBand={compact}
      >
        <Box borderStyle={on && !compact ? 'round' : undefined} borderColor={on && !compact ? TERRA : undefined} paddingLeft={on && !compact ? 1 : 2} paddingRight={1} flexDirection="column">
          <Text wrap="truncate-end">
            {compact ? <Text color={on ? TERRA : FAINT}>{on ? `${figures.pointer} ` : '  '}</Text> : null}
            {model ? (
              <>
                <Text bold color={m.gated ? SAND : hasAlias(m) ? IVORY : FAINT}>{cell(alias, columns.alias)}</Text>
                <Text color={FAINT}>{idText}</Text>
              </>
            ) : (
              <Text bold color={m.gated ? SAND : IVORY}>{m.name}</Text>
            )}
            {model ? <>
              <Text color={stateColor}>{stateText}</Text>
              <Text color={FAINT}>{cell(ctxText, columns.ctx)}</Text>
              <Text color={tokens.info}>{tail}</Text>
            </> : null}
          </Text>
          {on && !compact && m.tag !== '' ? <Text color={SAND}>{m.tag}</Text> : null}
        </Box>
      </InteractiveRow>
    )
  }
  return renderLine
}
