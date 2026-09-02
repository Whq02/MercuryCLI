// Hyperlink text: an OSC 8 link element inside text where the terminal
// supports hyperlinks, ordinary text (the fallback, else the content)
// otherwise.

import React from 'react'
import { supportsHyperlinks } from '../session/capabilities.js'
import Text from './Text.js'

export type Props = {
  readonly children?: React.ReactNode
  readonly url: string
  readonly fallback?: React.ReactNode
}

export default function Link({ children, url, fallback }: Props): React.ReactNode {
  const content = children ?? url
  if (supportsHyperlinks()) {
    return (
      <Text>
        <ink-link href={url}>{content}</ink-link>
      </Text>
    )
  }
  return <Text>{fallback ?? content}</Text>
}
