import figures from 'figures'
import * as React from 'react'
import { useContext } from 'react'
import { Text } from '../themedRenderer.js'
import { useSessionAccent } from '../widgets/sessionAccent.js'
import { useMercuryTokens } from '../widgets/useMercuryTokens.js'
import { MessageActionsSelectedContext } from './messageActions.js'
import { TranscriptNameplate } from './TranscriptNameplate.js'

type Props = {
  text: string
}

function userPointerColor(isSelected: boolean, accent: string): string {
  if (isSelected) return 'suggestion'
  return accent
}


export function HighlightedThinkingText({ text }: Props): React.ReactNode {
  const isSelected = useContext(MessageActionsSelectedContext)
  const { accent } = useSessionAccent()
  const pointerColor = userPointerColor(isSelected, accent)
  const textColor = useMercuryTokens().accentSoft
  return (
    <Text>
      <TranscriptNameplate />
      <Text color={pointerColor}>{figures.pointer} </Text>
      <Text color={textColor}>{text}</Text>
    </Text>
  )
}
