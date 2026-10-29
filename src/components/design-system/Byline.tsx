
import React from 'react'
import { Text } from '../../ink.js'

export function Byline({
  children,
}: {
  children?: React.ReactNode
}): React.ReactNode {
  const surviving = React.Children.toArray(children).filter(
    child => child !== null && child !== undefined && typeof child !== 'boolean',
  )
  if (surviving.length === 0) return null
  const parts: React.ReactNode[] = []
  surviving.forEach((child, position) => {
    if (position > 0) {
      parts.push(
        <Text key={`separator-${position}`} dimColor>
          {' · '}
        </Text>,
      )
    }
    const key = React.isValidElement(child) && child.key != null ? child.key : position
    const wrapped = React.isValidElement(child) ? child : <Text>{child}</Text>
    parts.push(<React.Fragment key={`child-${key}`}>{wrapped}</React.Fragment>)
  })
  return <>{parts}</>
}

export default Byline
