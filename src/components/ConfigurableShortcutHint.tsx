import React from 'react'
import type { KeybindingContextName } from '../keybindings/types.js'
import { notBuilt } from '../pi/holes.js'

export function ConfigurableShortcutHint(arg0: {
  action: string
  context: KeybindingContextName
  fallback: string
  description: string
  parens?: boolean
  bold?: boolean
}): React.ReactNode {
  return notBuilt('src/components/ConfigurableShortcutHint.tsx:7')
}

export default ConfigurableShortcutHint
