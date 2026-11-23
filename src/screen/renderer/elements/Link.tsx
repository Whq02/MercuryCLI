import React from 'react'
import { supportsHyperlinks } from '../terminal-session/capabilities.js'
import Text from './Text.js'

export type Props = {
  readonly url: string
  readonly children?: React.ReactNode
  readonly fallback?: React.ReactNode
}

export default function Link({ url, children, fallback }: Props): React.ReactNode {
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
