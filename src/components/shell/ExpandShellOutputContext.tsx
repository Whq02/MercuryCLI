// Boolean context marking a subtree as "render output in full".
// The transcript wraps the newest operator-run shell command in the
// provider so that command's output opens fully without a keypress.

import React, { createContext, useContext } from 'react'

const ExpandShellOutputContext = createContext<boolean>(false)

export function ExpandShellOutputProvider({
  children,
}: {
  children: React.ReactNode
}): React.ReactNode {
  return (
    <ExpandShellOutputContext.Provider value={true}>
      {children}
    </ExpandShellOutputContext.Provider>
  )
}

export function useExpandShellOutput(): boolean {
  return useContext(ExpandShellOutputContext)
}
