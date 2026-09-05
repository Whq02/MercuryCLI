import * as React from 'react'
import { Box, Text, elementScreenTop } from 'src/ink.js'
import type { DOMElement } from '../../ink/dom.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { getPlatform } from 'src/utils/platform.js'
import { isKeybindingCustomizationEnabled } from '../../keybindings/loadUserBindings.js'
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/featureGates.js'
import { CockpitActiveContext } from '../../context/cockpitActiveContext.js'
import { isDeckPaneActive } from '../../utils/fullscreen.js'
import { GLYPH, displayWidth } from '../mercury-ui/glyphs.js'
import { stripKeyMapHint } from '../../context/surfaceRoute.js'
import { getNewlineInstructions } from './utils.js'


function formatShortcut(shortcut: string): string {
  return shortcut.replace(/\+/g, ' + ')
}

type Props = {
  dimColor?: boolean
  fixedWidth?: boolean
  gap?: number
  paddingX?: number
  availableColumns?: number
}

export function PromptInputHelpMenu(props: Props): React.ReactNode {
  const { dimColor, fixedWidth, gap, paddingX, availableColumns } = props
  const cockpitActive = React.useContext(CockpitActiveContext)

  const transcriptShortcut = formatShortcut(
    useShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o'),
  )
  const todosShortcut = formatShortcut(
    useShortcutDisplay('app:toggleTodos', 'Global', 'ctrl+t'),
  )
  const undoShortcut = formatShortcut(
    useShortcutDisplay('chat:undo', 'Chat', 'ctrl+_'),
  )
  const redoShortcut = formatShortcut(
    useShortcutDisplay('chat:redo', 'Chat', 'ctrl+x ctrl+r'),
  )
  const stashShortcut = formatShortcut(
    useShortcutDisplay('chat:stash', 'Chat', 'ctrl+s'),
  )
  const cycleModeShortcut = formatShortcut(
    useShortcutDisplay('chat:cycleMode', 'Chat', 'shift+tab'),
  )
  const modelPickerShortcut = formatShortcut(
    useShortcutDisplay('chat:modelPicker', 'Chat', 'alt+p'),
  )
  const externalEditorShortcut = formatShortcut(
    useShortcutDisplay('chat:externalEditor', 'Chat', 'ctrl+g'),
  )
  const terminalShortcut = formatShortcut(
    useShortcutDisplay('app:toggleTerminal', 'Global', 'meta+j'),
  )
  const imagePasteShortcut = formatShortcut(
    useShortcutDisplay('chat:imagePaste', 'Chat', 'ctrl+v'),
  )
  const paletteShortcut = formatShortcut(
    useShortcutDisplay('app:commandPalette', 'Global', 'ctrl+x p'),
  )
  const fileOpenShortcut = formatShortcut(
    useShortcutDisplay('app:fileOpen', 'Global', 'ctrl+x f'),
  )
  const contentSearchShortcut = formatShortcut(
    useShortcutDisplay('app:contentSearch', 'Global', 'ctrl+x g'),
  )
  const sessionsShortcut = formatShortcut(
    useShortcutDisplay('command:sessions', 'Global', 'ctrl+x s'),
  )
  const managerShortcut = formatShortcut(
    useShortcutDisplay('command:surfaces', 'Global', 'ctrl+x m'),
  )
  const { columns, rows: termRows } = useTerminalSize()
  const availCols = (availableColumns ?? columns) - 2 * (paddingX ?? 0)

  type HelpRow = { key: string; text: string }
  const row = ({ key, text }: HelpRow): React.ReactNode => (
    <Box key={key} flexShrink={0}>
      <Text dimColor={dimColor} wrap="truncate-end">
        {text}
      </Text>
    </Box>
  )

  const groupPrefixes: HelpRow[] = [
    { key: 'bash', text: '! for bash mode' },
    { key: 'cmds', text: '/ for commands' },
    { key: 'at', text: '@ for file paths' },
  ]
  const groupChat: HelpRow[] = [
    { key: 'esc', text: 'double tap esc to clear input' },
    { key: 'mode', text: `${cycleModeShortcut} for implement mode` },
    { key: 'tsc', text: `${transcriptShortcut} for the transcript` },
    { key: 'todos', text: `${todosShortcut} to toggle tasks` },
    { key: 'nl', text: getNewlineInstructions() },
  ]
  const stripRow = stripKeyMapHint()
  const groupGlobal: HelpRow[] = [
    ...(stripRow !== '' ? [{ key: 'strip', text: stripRow }] : []),
    { key: 'palette', text: `${paletteShortcut} for command palette` },
    { key: 'file', text: `${fileOpenShortcut} to open a file` },
    { key: 'search', text: `${contentSearchShortcut} to search contents` },
    { key: 'sessions', text: `${sessionsShortcut} to switch session` },
    { key: 'surfaces', text: `${managerShortcut} for the surface index` },
    { key: 'undo', text: `${undoShortcut} to undo` },
    { key: 'redo', text: `${redoShortcut} to redo` },
    ...(getPlatform() !== 'windows' ? [{ key: 'susp', text: 'ctrl + z to suspend' }] : []),
    { key: 'img', text: `${imagePasteShortcut} to paste images` },
    { key: 'model', text: `${modelPickerShortcut} to switch model` },
    { key: 'stash', text: `${stashShortcut} to stash prompt` },
    { key: 'editor', text: `${externalEditorShortcut} to edit in $EDITOR` },
    ...(isKeybindingCustomizationEnabled()
      ? [{ key: 'keys', text: '/keybindings to customize' }]
      : []),
  ]
  const colGap = gap ?? 2
  const widest = (rows: HelpRow[]): number => Math.max(0, ...rows.map(r => displayWidth(r.text)))
  const need3 =
    (fixedWidth ? 24 : widest(groupPrefixes)) +
    colGap +
    (fixedWidth ? 35 : widest(groupChat)) +
    colGap +
    widest(groupGlobal)
  const need2 = Math.max(widest(groupPrefixes), widest(groupChat)) + colGap + widest(groupGlobal)
  const colCount = availCols >= need3 ? 3 : availCols >= need2 ? 2 : 1
  const columnGroups: React.ReactNode[][] = (
    colCount === 3
      ? [groupPrefixes, groupChat, groupGlobal]
      : colCount === 2
        ? [[...groupPrefixes, ...groupChat], groupGlobal]
        : [[...groupPrefixes, ...groupChat, ...groupGlobal]]
  ).map(group => group.map(row))

  const gridRef = React.useRef<DOMElement | null>(null)
  const totalRows = columnGroups.reduce((most, group) => Math.max(most, group.length), 0)
  const geometryKey = `${termRows}:${columns}:${totalRows}`
  const [measured, setMeasured] = React.useState<{ key: string; rows: number } | null>(null)
  React.useEffect(() => {
    if (measured !== null && measured.key === geometryKey) return
    const element = gridRef.current
    if (!element) return
    const top = elementScreenTop(element)
    setMeasured({ key: geometryKey, rows: Math.max(3, termRows - top) })
  })
  const availableRows = measured !== null && measured.key === geometryKey ? measured.rows : Number.MAX_SAFE_INTEGER
  let hiddenRows = 0
  const shownGroups = columnGroups.map(group => {
    if (group.length <= availableRows) return group
    hiddenRows += group.length - (availableRows - 1)
    return group.slice(0, availableRows - 1)
  })

  return (
    <Box paddingX={paddingX} flexDirection="column" ref={gridRef}>
      {
}
      {
}
      <Box flexDirection="row" gap={gap ?? 2} flexShrink={0}>
        {shownGroups.map((rows, i) => (
          <Box
            key={i}
            flexDirection="column"
            flexShrink={0}
            width={
              colCount === 3 && fixedWidth
                ? [24, 35, undefined][i]
                : undefined
            }
          >
            {rows}
          </Box>
        ))}
      </Box>
      {hiddenRows > 0 ? (
        <Box flexShrink={0}>
          <Text dimColor={dimColor} wrap="truncate-end">
            … +{hiddenRows} more · /help lists every shortcut
          </Text>
        </Box>
      ) : null}
      {
}
      {isDeckPaneActive() ? (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text dimColor={dimColor} bold>
              deck chips
            </Text>
          </Box>
          {
}
          <Box flexDirection="row" flexWrap="wrap" columnGap={3} rowGap={0}>
            {[
              'subs N/M caps on/total',
              'trace N',
              'repo — repo-wide tool calls',
              `${GLYPH.fail}N = killed by a gate`,
              'mcp ≤X risk ceiling',
              'saturn — scheduler pulse',
              `${GLYPH.done} on`,
              `${GLYPH.pending} off`,
              `${GLYPH.busy} busy`,
              `${GLYPH.warn} warn`,
              `${GLYPH.fail} killed`,
              ...(cockpitActive ? ['tab — focus cockpit rails'] : []),
            ].map(chip => (
              <Box key={chip} flexShrink={0}>
                <Text dimColor={dimColor}>{chip}</Text>
              </Box>
            ))}
          </Box>
        </Box>
      ) : cockpitActive ? (
        <Box marginTop={1}>
          <Text dimColor={dimColor}>tab — focus cockpit rails · /help — all commands + shortcuts</Text>
        </Box>
      ) : null}
    </Box>
  )
}
