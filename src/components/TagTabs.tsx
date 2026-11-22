import React from 'react'
import { Box, Text } from '../ink.js'
import { stringWidth } from '../ink/stringWidth.js'
import { truncateToWidth } from '../utils/truncate.js'
import { notBuilt } from '../pi/holes.js'

type TagTab = {
  label: string
  isAll?: boolean
}

function tabCost(tab: TagTab, cap: number): number {
  if (tab.isAll) return stringWidth(tab.label) + 2
  return Math.min(stringWidth(tab.label), cap - 3) + 3
}

function displayText(tab: TagTab, cap: number): string {
  if (tab.isAll) return tab.label
  const renderBudget = cap - 2 - 3
  if (renderBudget < 1) return `#${[...tab.label].slice(0, 1).join('')}`
  return `#${truncateToWidth(tab.label, renderBudget)}`
}

export function TagTabs(arg0: {
  tabs: TagTab[]
  selectedIndex: number
  availableWidth: number
  showAllProjects?: boolean
}): React.ReactNode {
  return notBuilt('src/components/TagTabs.tsx:24')
}

export default TagTabs
