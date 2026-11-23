import React from 'react'
import { useShortcutDisplay } from './useShortcutDisplay.js'
import type { KeybindingContextName } from './types.js'
import { KeyboardShortcutHint } from '../theme/KeyboardShortcutHint.js'

export function ConfigurableShortcutHint({
  action,
  context,
  fallback,
  description,
  parens = false,
  bold = false,
}: {
  action: string
  context: KeybindingContextName
  fallback: string
  description: string
  parens?: boolean
  bold?: boolean
}): React.ReactNode {
  const shortcut = useShortcutDisplay(action, context, fallback)
  return (
    <KeyboardShortcutHint
      shortcut={shortcut}
      action={description}
      parens={parens}
      bold={bold}
    />
  )
}

export default ConfigurableShortcutHint
