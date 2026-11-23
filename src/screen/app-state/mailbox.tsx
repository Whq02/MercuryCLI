
import React, { createContext, useState } from 'react'
import { Mailbox } from '../../crew/crewmates/mailbox.js'

const MailboxContext = createContext<Mailbox | null>(null)

export function MailboxProvider({
  children,
}: {
  children: React.ReactNode
}): React.ReactNode {
  const [mailbox] = useState(() => new Mailbox())
  return (
    <MailboxContext.Provider value={mailbox}>
      {children}
    </MailboxContext.Provider>
  )
}
