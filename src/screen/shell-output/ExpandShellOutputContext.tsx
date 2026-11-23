
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
