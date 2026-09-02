// A repeated newline; must be used inside text.

import React from 'react'

export type Props = {
  readonly count?: number
}

export default function Newline({ count = 1 }: Props): React.ReactNode {
  return <ink-text>{'\n'.repeat(count)}</ink-text>
}
