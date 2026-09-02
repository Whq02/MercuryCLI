// Provides the per-session in-process mailbox instance. Reading it
// outside the provider throws, naming the required provider. The instance
// is created per provider mount.

import React, { createContext, useContext, useState } from 'react'
import { Mailbox } from '../utils/mailbox.js'

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

export function useMailbox(): Mailbox {
  const mailbox = useContext(MailboxContext)
  if (mailbox === null) {
    throw new Error('useMailbox must be used within a MailboxProvider')
  }
  return mailbox
}
