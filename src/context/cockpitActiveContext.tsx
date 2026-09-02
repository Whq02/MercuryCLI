import * as React from 'react'
import { createContext, useContext } from 'react'

export const CockpitActiveContext = createContext<boolean>(false)

export function CockpitBottomStatus({
  children,
}: {
  children: React.ReactNode
}): React.ReactNode {
  const cockpit = useContext(CockpitActiveContext)
  if (cockpit) return null
  return children
}
