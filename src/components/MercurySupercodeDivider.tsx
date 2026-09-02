
import * as React from 'react'
import { Divider } from './mercury-ui/components.js'
import { useSessionAccent } from './mercury-ui/sessionAccent.js'

export function MercurySupercodeDivider({
  width = 30,
}: {
  width?: number
}): React.ReactNode {
  return <Divider label="supercode" width={width} color={useSessionAccent().accent} />
}

export default MercurySupercodeDivider
