import React from 'react'
import { Box, Text } from '../themedRenderer.js'
import { stringWidth } from '../renderer/stringWidth.js'
import type { AppState } from '../app-state/AppState.js'
import type { InputMode } from './input-core/textInput.js'
import { isDefaultMode } from '../../permissions/rules/permissionMode.js'
import type { Theme } from '../theme/theme.js'
import type { useTypeahead } from './typeahead/useTypeahead.js'
import { composerBorderRole, composerBorderStyle } from '../widgets/composerFloor.js'
import type { CompactFrameBudget } from '../widgets/geometry.js'
import { truncateToWidth } from '../theme/glyphs.js'
import { AMBER } from '../theme/mercuryPalette.js'
import { IssueFlagBanner } from './IssueFlagBanner.js'
import type { useComposerModelDoors } from './useComposerModelDoors.js'
import type { useCrewBanner } from './useCrewBanner.js'

export function composerGeometry({
  isCompact,
  compactBudget,
  rows,
  columns,
  toolPermissionContext,
  mode,
  input,
  typeahead,
  fullscreen,
}: {
  isCompact: boolean
  compactBudget: CompactFrameBudget | null
  rows: number
  columns: number
  toolPermissionContext: AppState['toolPermissionContext']
  mode: InputMode
  input: string
  typeahead: ReturnType<typeof useTypeahead>
  fullscreen: boolean
}) {
  const borderStyle = isCompact ? compactBudget?.composerBorderRows === 2 ? 'round' : undefined : composerBorderStyle(rows)
  const nonDefaultModeColor = !isDefaultMode(toolPermissionContext.mode)
    ? ('permission' as keyof Theme)
    : undefined
  const borderColor: keyof Theme =
    mode === 'bash'
      ? 'bashBorder'
      : (nonDefaultModeColor ?? composerBorderRole(input === ''))

  const compactPool = compactBudget?.editorPoolRows ?? rows
  const compactTransientRows = isCompact ? Math.min(2, Math.max(0, compactPool - 1)) : 0
  const compactSuggestionRows = isCompact && typeahead.suggestions.length > 0 ? Math.min(5, Math.max(0, compactPool - compactTransientRows - 1)) : 0
  const maxVisibleLines = isCompact
    ? Math.max(1, Math.min(Math.max(1, Math.floor(rows / 2) - 5), compactPool - compactTransientRows - compactSuggestionRows))
    : fullscreen ? Math.max(3, Math.floor(rows / 2) - 5) : undefined

  const textColumns = isCompact ? Math.max(1, compactBudget?.inputColumns ?? columns) : columns - 3
  return { borderStyle, borderColor, compactTransientRows, compactSuggestionRows, maxVisibleLines, textColumns }
}

export function composerFrame({
  banner,
  columns,
  isCompact,
  inputBody,
  borderStyle,
  theme,
  borderColor,
  input,
}: {
  banner: ReturnType<typeof useCrewBanner>
  columns: number
  isCompact: boolean
  inputBody: React.ReactNode
  borderStyle: 'round' | undefined
  theme: Theme
  borderColor: keyof Theme
  input: string
}): React.ReactNode {
  const bannerLabel = banner !== null ? truncateToWidth(banner.text, Math.max(0, columns - 6)) : null
  const frame =
    !isCompact && banner !== null && bannerLabel !== null ? (
      <Box flexDirection="column">
        <Text color={banner.bgColor}>
          {'-'.repeat(Math.max(0, columns - stringWidth(bannerLabel) - 4))}
          <Text backgroundColor={banner.bgColor}> {bannerLabel} </Text>
          {'--'}
        </Text>
        {inputBody}
        <Text color={banner.bgColor}>{'-'.repeat(Math.max(1, columns))}</Text>
      </Box>
    ) : (
      <Box
        flexDirection="column"
        borderStyle={borderStyle}
        borderColor={theme[borderColor] as string}
        borderDimColor={input === ''}
      >
        {inputBody}
      </Box>
    )
  return frame
}

export function composerNotices({
  isCompact,
  compactTransientRows,
  capLaneLine,
  capLaneCut,
  hasSuppressedDialogs,
}: {
  isCompact: boolean
  compactTransientRows: number
  capLaneLine: ReturnType<typeof useComposerModelDoors>['capLaneLine']
  capLaneCut: ReturnType<typeof useComposerModelDoors>['capLaneCut']
  hasSuppressedDialogs: boolean
}): React.ReactNode {
  return (
    <Box flexDirection="column" maxHeight={isCompact ? Math.ceil(compactTransientRows / 2) : undefined} overflow="hidden">
    <IssueFlagBanner />
    {capLaneLine !== null ? (
      capLaneCut !== null ? (
        <Box paddingLeft={1}>
          <Box width={capLaneCut.bodyColumns} flexShrink={0} minWidth={0}>
            <Text color={AMBER} wrap="truncate-end">{capLaneCut.body}</Text>
          </Box>
          <Box flexShrink={0}>
            <Text color={AMBER}>{capLaneCut.tail}</Text>
          </Box>
        </Box>
      ) : (
        <Box paddingLeft={1}>
          <Text color={AMBER}>{capLaneLine}</Text>
        </Box>
      )
    ) : null}
    {hasSuppressedDialogs ? (
      <Box marginTop={isCompact ? 0 : 1} marginLeft={isCompact ? 0 : 2}>
        <Text dimColor wrap="truncate-end">Waiting for permission…</Text>
      </Box>
    ) : null}
    </Box>
  )
}
