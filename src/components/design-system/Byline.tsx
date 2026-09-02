// Joins metadata children with a dimmed middot separator, dropping
// null/undefined/boolean children entirely — separators appear only BETWEEN
// surviving children, and no valid child means nothing renders at all.

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
    // TOTAL over ReactNode (operator sighting, the Skill tool-result crash):
    // a bare string/number child reaching a Box trips Ink's text invariant
    // at the APP ROOT and ends the session. Wrapping non-elements here
    // closes the class for every caller — the signature accepts ReactNode,
    // so the component, not each call site, owns making that true.
    const wrapped = React.isValidElement(child) ? child : <Text>{child}</Text>
    parts.push(<React.Fragment key={`child-${key}`}>{wrapped}</React.Fragment>)
  })
  return <>{parts}</>
}

export default Byline
