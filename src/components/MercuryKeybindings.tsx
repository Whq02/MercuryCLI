import * as React from 'react'
import { Box, Text } from '../ink.js'
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js'
import { FAINT, SAND, TERRA } from './mercuryPalette.js'
import { Crab } from './mercury-ui/assets.js'
import { padTo } from './mercury-ui/glyphs.js'

/** One registry-sourced row — the hook resolves the LIVE binding (defaults +
 *  ~/.claude/keybindings.json rebinds), so this panel can never drift from
 *  reality again (the audit found it hardcoded AND wrong; the
 *  pass made it a live surface). */
function ShortcutRow({
  action,
  context,
  fallback,
  label,
}: {
  action: string
  context: import('../keybindings/types.js').KeybindingContextName
  fallback: string
  label: string
}): React.ReactNode {
  const key = useShortcutDisplay(action, context, fallback)
  return (
    <Text>
      <Text color={SAND}>{padTo(key, 8)}</Text>
      <Text color={FAINT}>{label}</Text>
    </Text>
  )
}

const ROWS: Array<{ action: string; context: import('../keybindings/types.js').KeybindingContextName; fallback: string; label: string }> = [
  { action: 'select:previous', context: 'Select', fallback: '↑', label: 'select' },
  { action: 'select:accept', context: 'Select', fallback: '↵', label: 'confirm' },
  { action: 'select:cancel', context: 'Select', fallback: 'esc', label: 'cancel' },
  { action: 'app:interrupt', context: 'Global', fallback: 'ctrl+c', label: 'interrupt' },
  { action: 'app:exit', context: 'Global', fallback: 'ctrl+d', label: 'exit' },
  { action: 'history:search', context: 'Chat', fallback: 'ctrl+r', label: 'history search' },
  { action: 'task:background', context: 'Global', fallback: 'ctrl+t', label: 'tasks' },
  { action: 'app:toggleTranscript', context: 'Global', fallback: 'ctrl+o', label: 'transcript' },
]

export function MercuryKeybindings(): React.ReactNode {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={TERRA} paddingX={1}>
      <Text bold color={TERRA}>
        <Crab /> keybindings
      </Text>
      {ROWS.map(r => (
        <ShortcutRow key={r.action} {...r} />
      ))}
      <Text color={FAINT}>esc close</Text>
    </Box>
  )
}
