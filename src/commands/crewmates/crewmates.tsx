import * as React from 'react'
import { CrewView } from '../../components/mercury-ui/screens/CrewView.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { openCrewView } from '../../utils/cockpit/crewView.js'

export const CREW_SPAWN_ARG = '+new'

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const name = (args ?? '').trim().replace(/^@/, '')
  if (name === '') {
    openCrewView()
    onDone(undefined, { display: 'skip' })
    return null
  }
  return (
    <CrewView
      onClose={() => onDone(undefined, { display: 'skip' })}
      {...(name === CREW_SPAWN_ARG ? { initialSpawn: true } : { initialChat: name })}
    />
  )
}
