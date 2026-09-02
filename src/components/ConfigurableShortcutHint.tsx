// Resolves the operator's configured chord for an action in a context
// (falling back to the supplied default) and renders the standard hint.

import React from 'react'
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js'
import type { KeybindingContextName } from '../keybindings/types.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'

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
  const chord = useShortcutDisplay(action, context, fallback)
  return (
    <KeyboardShortcutHint
      shortcut={chord}
      action={description}
      parens={parens}
      bold={bold}
    />
  )
}

export default ConfigurableShortcutHint
