import * as React from 'react'
import { CrewView } from '../../components/mercury-ui/screens/CrewView.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

// /teammates — the Crew view: the focused session's sub-agents live, and
// the named agents' chats. `/teammates <name>` opens that named agent's
// chat straight away (the cockpit rail's door).
export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const name = (args ?? '').trim().replace(/^@/, '')
  return (
    <CrewView
      onClose={() => onDone(undefined, { display: 'skip' })}
      {...(name !== '' ? { initialChat: name } : {})}
    />
  )
}
