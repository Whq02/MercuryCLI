
import React from 'react'
import { Text } from '../themedRenderer.js'

export const EXIT_CHORD_HINT = 'press ctrl+c twice to close Mercury'

export function exitChordNoticeText(keyName: string | null): string {
  return `press ${keyName === 'Ctrl-D' ? 'ctrl+d' : 'ctrl+c'} again to close Mercury`
}

export function ExitChordNotice({ keyName }: { keyName: string | null }): React.ReactNode {
  return <Text dimColor>{exitChordNoticeText(keyName)}</Text>
}
