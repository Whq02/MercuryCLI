import * as React from 'react'
import { createContext, useContext } from 'react'
import { CompactFrameBudgetContext } from './layoutChromeContext.js'

export const CockpitActiveContext = createContext<boolean>(false)

export function CockpitBottomStatus({
  children,
}: {
  children: React.ReactNode
}): React.ReactNode {
  const cockpit = useContext(CockpitActiveContext)
  const budget = useContext(CompactFrameBudgetContext)
  if (cockpit) return null
  if (budget?.activityRows === 0) return null
  return children
}
