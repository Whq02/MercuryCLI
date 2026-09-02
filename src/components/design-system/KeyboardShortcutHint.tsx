import React from 'react'
import Text from '../../ink/components/Text.js'

type Props = {
  shortcut: string
  action: string
  parens?: boolean
  bold?: boolean
}

const KIT_KEY: Record<string, string> = {
  Enter: '↵',
  Return: '↵',
  Esc: 'esc',
  Escape: 'esc',
  Space: 'space',
  Tab: 'tab',
  Backspace: 'backspace',
  Delete: 'del',
  PageUp: 'pgup',
  PageDown: 'pgdn',
  Home: 'home',
  End: 'end',
}

function kitToken(tok: string): string {
  if (KIT_KEY[tok]) return KIT_KEY[tok]
  return /^[A-Za-z]{2,}$/.test(tok) ? tok.toLowerCase() : tok
}

export function kitShortcut(s: string): string {
  return s
    .split(' ')
    .map(word =>
      word
        .split('/')
        .map(alt => alt.split('+').map(kitToken).join('+'))
        .join('/'),
    )
    .join(' ')
}

export function KeyboardShortcutHint({
  shortcut,
  action,
  parens = false,
  bold = false,
}: Props): React.ReactNode {  const display = kitShortcut(shortcut)
  const shortcutText = bold ? <Text bold>{display}</Text> : display
  const joiner = ' '
  if (parens) {
    return (
      <Text>
        ({shortcutText}
        {joiner}
        {action})
      </Text>
    )
  }
  return (
    <Text>
      {shortcutText}
      {joiner}
      {action}
    </Text>
  )
}
