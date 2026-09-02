import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { chatOnlyBoot } from '../../context/surfaceRoute.js'
import { getKeybindingsPath } from '../../keybindings/loadUserBindings.js'
import type { KeybindingContextName } from '../../keybindings/types.js'
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js'
import { toTildePath } from '../../utils/path.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { padTo } from '../mercury-ui/glyphs.js'

/**
 * The /help SHORTCUTS tab — registry-SOURCED via
 * useShortcutDisplay, so every key shown reflects defaultBindings PLUS the
 * operator's ~/.claude/keybindings.json rebinds. This is the single full
 * reference the nav audit found missing ("no one place to see what my
 * bindings are now"); the '?' quick menu stays the terse in-flow card.
 * Curated ids only — each verified against the registry (a typo'd id would
 * silently show its fallback, which is exactly the drift this tab exists to
 * kill).
 *
 * P6: split EVERYDAY (the first-hour set, led by the
 * universal launcher) from ADVANCED (power controls) so the tab scans instead
 * of reading as one dim wall; keys wear the info channel (semantic color,
 * small signal), labels stay calm secondary ink, and the whole tab consumes
 * adaptive tokens so light/daltonized families render their own palette.
 */
/** `plainLabel`: the row's words in THE PLAIN WORLD (a `--chat` boot, the
 *  concourse switched off) where the chord opens something else — the
 *  action · context · fallback triple is the same in both worlds. */
type Row = { action: string; context: KeybindingContextName; fallback: string; label: string; plainLabel?: string }
type Section = { head: string; rows: Row[] }

// Exported for the registry-derived-hints equality proof: the help
// rows ARE the action objects (id + context + fallback) — a prover compares
// them against the Action Graph and the default-binding registry, so a
// copied hint string can never drift silently.
export const EVERYDAY: Section = {
  head: 'everyday',
  rows: [
    { action: 'app:commandPalette', context: 'Global', fallback: 'ctrl+x p', label: 'command palette — every command, fuzzy-searched' },
    {
      action: 'app:openSurfaceSwitcher',
      context: 'Global',
      fallback: 'ctrl+x c',
      label: 'session concourse — every surface, one board',
      plainLabel: 'live view of your sessions — the concourse is off in this boot',
    },
    { action: 'app:interrupt', context: 'Global', fallback: 'ctrl+c', label: 'interrupt the turn' },
    { action: 'history:search', context: 'Global', fallback: 'ctrl+r', label: 'search prompt history' },
    { action: 'app:toggleTranscript', context: 'Global', fallback: 'ctrl+o', label: 'transcript pager (/ search · g/G · q)' },
    { action: 'chat:cycleMode', context: 'Chat', fallback: 'shift+tab', label: 'cycle permission mode' },
    { action: 'app:exit', context: 'Global', fallback: 'ctrl+d', label: 'exit' },
  ],
}

export const ADVANCED: Section[] = [
  {
    head: 'quick-open (the ctrl+x suite)',
    rows: [
      { action: 'app:fileOpen', context: 'Global', fallback: 'ctrl+x f', label: 'file open (@path)' },
      { action: 'app:contentSearch', context: 'Global', fallback: 'ctrl+x g', label: 'content search (@file#L)' },
      { action: 'command:sessions', context: 'Global', fallback: 'ctrl+x s', label: 'session switcher' },
      { action: 'command:surfaces', context: 'Global', fallback: 'ctrl+x m', label: 'surface index' },
    ],
  },
  {
    head: 'advanced',
    rows: [
      // catch: this row said ctrl+t (the todos toggle) while the
      // registry binds task:background to ctrl+b in the Task context — the
      // equality proof now pins help to the registry's own chord.
      { action: 'task:background', context: 'Task', fallback: 'ctrl+b', label: 'background the running task' },
      { action: 'app:toggleTeammatePreview', context: 'Global', fallback: 'ctrl+shift+o', label: 'teammate preview' },
    ],
  },
]

function ShortcutRow({ row }: { row: Row }): React.ReactNode {
  const key = useShortcutDisplay(row.action, row.context, row.fallback)
  const t = useMercuryTokens()
  const label = row.plainLabel !== undefined && chatOnlyBoot() ? row.plainLabel : row.label
  return (
    <Text>
      <Text color={t.info}>{padTo(key, 14)}</Text>
      <Text color={t.textSecondary}>{label}</Text>
    </Text>
  )
}

function ShortcutSection({ section }: { section: Section }): React.ReactNode {
  const t = useMercuryTokens()
  return (
    <Box flexDirection="column" paddingBottom={1}>
      <Text bold color={t.textPrimary}>
        {section.head}
      </Text>
      {section.rows.map(r => (
        <ShortcutRow key={r.action} row={r} />
      ))}
    </Box>
  )
}

export function ShortcutsTab(): React.ReactNode {
  const t = useMercuryTokens()
  return (
    <Box flexDirection="column" paddingTop={1}>
      <ShortcutSection section={EVERYDAY} />
      {ADVANCED.map(s => (
        <ShortcutSection key={s.head} section={s} />
      ))}
      {/* This tab is the curated first-hour set. /keys is the COMPLETE
          effective table — every action, live-resolved, with chord lookup and
          in-panel rebinding — so the curation here never has to pretend to be
          exhaustive. */}
      <Text color={t.textMuted}>cockpit: tab focuses the rails (empty prompt)</Text>
      <Text color={t.textMuted}>/keys — every binding, live · rebind in {toTildePath(getKeybindingsPath())}</Text>
    </Box>
  )
}
