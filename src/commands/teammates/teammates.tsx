import * as React from 'react'
import { CrewView } from '../../components/mercury-ui/screens/CrewView.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const name = (args ?? '').trim().replace(/^@/, '')
  return (
    <CrewView
      onClose={() => onDone(undefined, { display: 'skip' })}
      {...(name !== '' ? { initialChat: name } : {})}
    />
  )
}
