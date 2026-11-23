
import * as React from 'react'
import { Text } from '../themedRenderer.js'
import { BLACK_CIRCLE } from '../theme/rowGlyphs.js'


export function toolCardCountColor(): string | undefined {
  return 'text'
}


export function ToolCardMarker(): React.ReactNode {
  return <Text color="success">{BLACK_CIRCLE} </Text>
}

export function ToolCardMeta({ text }: { text?: string | null }): React.ReactNode {
  if (!text) return null
  return (
    <Text color="inactive">
      {' · '}
      {text}
    </Text>
  )
}
