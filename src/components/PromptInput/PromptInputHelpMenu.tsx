import * as React from 'react'
import { Box, Text } from 'src/ink.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { computeChromeMode } from '../../hooks/useLayoutTier.js'
import { getPlatform } from 'src/utils/platform.js'
import { isKeybindingCustomizationEnabled } from '../../keybindings/loadUserBindings.js'
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/featureGates.js'
import { CockpitActiveContext } from '../../context/cockpitActiveContext.js'
import { isDeckPaneActive } from '../../utils/fullscreen.js'
import { GLYPH, displayWidth } from '../mercury-ui/glyphs.js'
import { stripKeyMapHint } from '../../context/surfaceRoute.js'
import { getNewlineInstructions } from './utils.js'

// NOTE: de-_c-memoized from React-Compiler output (was `_c(99)`) back to the plain
// author original (restored from this file's own inline sourcemap) so Mercury's
// command-palette hint can be added without hand-patching memo-cache slots.

/** Help-menu display form of a chord: spaces around each "+" ("ctrl+o" → "ctrl + o"). */
function formatShortcut(shortcut: string): string {
  return shortcut.replace(/\+/g, ' + ')
}

type Props = {
  dimColor?: boolean
  fixedWidth?: boolean
  gap?: number
  paddingX?: number
  /** The container's inner width when the caller knows it (a bordered
   *  pane's interior); absent, the terminal's own columns. */
  availableColumns?: number
}

export function PromptInputHelpMenu(props: Props): React.ReactNode {
  const { dimColor, fixedWidth, gap, paddingX, availableColumns } = props
  // the 'tab — focus cockpit rails' hint is only true
  // when the cockpit rails are actually present (CockpitActiveContext) — at <100
  // cols, non-fullscreen, MERCURY_HELM_HOME=0, or under an open command surface
  // the Tab binding is inert, so the line must not render.
  const cockpitActive = React.useContext(CockpitActiveContext)

  // Get configured shortcuts from keybinding system
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
  // Mercury-only: the warm-ink command palette (ctrl+x p). Hook called unconditionally
  // (Rules of Hooks); the LINE always renders (the binding is
  // registered unconditionally).
  const paletteShortcut = formatShortcut(
    useShortcutDisplay('app:commandPalette', 'Global', 'ctrl+x p'),
  )
  const fileOpenShortcut = formatShortcut(
    useShortcutDisplay('app:fileOpen', 'Global', 'ctrl+x f'),
  )
  const contentSearchShortcut = formatShortcut(
    useShortcutDisplay('app:contentSearch', 'Global', 'ctrl+x g'),
  )
  // Same quick-open chord family (interaction audit: these two were
  // live bindings with NO help row — the only undocumented members of ctrl+x).
  const sessionsShortcut = formatShortcut(
    useShortcutDisplay('command:sessions', 'Global', 'ctrl+x s'),
  )
  const managerShortcut = formatShortcut(
    useShortcutDisplay('command:surfaces', 'Global', 'ctrl+x m'),
  )
  // Responsive column count (product-study r3): at 80 cols yoga shrank all
  // three columns and every longer row wrapped MID-PHRASE — orphan lines
  // ('file', 'session') read as separate shortcuts and one binding lost its
  // noun to the wrap. The floors DERIVE from the rows themselves: three
  // columns need the fixed prefix/chat widths (or their widest rows) plus
  // the widest global row plus the gaps, two columns the widest of the
  // merged pair plus the widest global row — a constant floor (96) let a
  // 100-column pane pick three columns and clip its longest row to "$EDI".
  // Below the floors the grid reflows to 2 columns, then 1; every row is
  // ATOMIC (truncate-end, never intra-phrase wrap).
  const { columns, rows: termRows } = useTerminalSize()
  const availCols = (availableColumns ?? columns) - 2 * (paddingX ?? 0)

  // One atomic help row — a Box'd truncate-end Text (a row may clip its tail
  // on absurdly narrow terminals, but can never shed an orphan line).
  // flexShrink=0: ATOMIC vertically too — inside the height-
  // capped bottom area yoga's shrink pass floored SOME unit rows to height 0
  // while their Text still painted, so a crushed row's longer tail bled into
  // its successor ("ctrl + z to suspendo redo", 120×40 receipt) and which
  // rows died varied with rounding. A row either renders whole or clips
  // whole at the container edge — never merges.
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
    // No '& for background' / '/btw' rows: no '&' prefix handler exists in
    // the product, and /btw was removed (the Helm console owns
    // side questions) — an advertised key must reach a handler.
  ]
  const groupChat: HelpRow[] = [
    { key: 'esc', text: 'double tap esc to clear input' },
    // The upstream build-variant branch ("external" === 'ant') folded to a
    // constant in the React-Compiler output we restored from; the hint names
    // the first station shift+tab reaches from default (Implement Mode).
    // Inlined as the literal so strict tsc doesn't flag the no-overlap
    // comparison (TS2367).
    { key: 'mode', text: `${cycleModeShortcut} for implement mode` },
    { key: 'tsc', text: `${transcriptShortcut} for verbose output` },
    { key: 'todos', text: `${todosShortcut} to toggle tasks` },
    { key: 'nl', text: getNewlineInstructions() },
  ]
  // The three-screen model's one teaching row (first-contact law): the
  // strip resolver names ONLY the stops that exist right now, so this row
  // can never advertise a screen that is not there — and it vanishes whole
  // when nothing moves (a chat-only world). Before this row, shift+←/→ was
  // taught nowhere the operator could reach outside the fullscreen footer.
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

  // Vertical honesty (the completion list's windowing idiom): the bottom
  // area's overflowY=hidden clips overflowing rows SILENTLY — at ≤63
  // columns the single-column grid runs ~21 rows and a 24-row terminal
  // shed eight entries with no trace. Cap every column to the rows the
  // terminal can afford and SAY what was cut; /help carries the full list.
  const chrome = computeChromeMode(columns, termRows)
  const availableRows = Math.max(3, termRows - (chrome === 'deck-strip' ? 14 : 6))
  let hiddenRows = 0
  const shownGroups = columnGroups.map(group => {
    if (group.length <= availableRows) return group
    hiddenRows += group.length - (availableRows - 1)
    return group.slice(0, availableRows - 1)
  })

  return (
    <Box paddingX={paddingX} flexDirection="column">
      {/* The shortcut columns. gap floors at 2 — the `?` overlay mounted with
          no gap at all, so a squeezed column BUTTED into its neighbor
          (`…for commanddeck chips`, 120-col capture). */}
      {/* flexShrink=0 down the whole grid: any level left
          shrinkable lets yoga crush unit rows to height 0 inside the
          height-capped bottom area — the crushed row's Text still paints
          (overflow is visible by default) and merges into its successor.
          Unshrinkable, the outer overflowY=hidden clips WHOLE rows at the
          block's bottom edge instead — visible truth, never corruption. */}
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
      {/* Fork: the chip/glyph legend — one screen defining the deck-strip vocabulary
          (uniqueness-program P5: "dense, cryptic, with no legend anywhere"). Pulls
          from the GLYPH map so the legend can never drift from the chips. A
          full-width WRAPPING strip below the columns, not a 4th column — the
          column form overflowed 120 cols and squeezed its neighbor mid-word.
          CONTEXTUAL — the legend explains chips the
          DECK renders, so it appears only while the deck pane is actually up;
          a solo `?` in the cockpit/inline keeps the everyday hints scannable
          (the internal-vocabulary wall was the shortcut-help density finding). */}
      {isDeckPaneActive() ? (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text dimColor={dimColor} bold>
              deck chips
            </Text>
          </Box>
          {/* Atomic legend chips on a wrapping flex row: the single wrapped
              Text kept its break spaces, so continuation lines opened with a
              stray indent and terms split mid-phrase. A chip either fits on
              the line or moves whole to the next — the wrap can never break
              inside a term. */}
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
