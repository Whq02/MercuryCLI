import React from 'react'
import { Box, Text } from '../ink.js'
import { stringWidth } from '../ink/stringWidth.js'
import { truncateToWidth } from '../utils/truncate.js'

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

export function TagTabs({
  tabs,
  selectedIndex,
  availableWidth,
  showAllProjects = false,
}: {
  tabs: TagTab[]
  selectedIndex: number
  availableWidth: number
  showAllProjects?: boolean
}): React.ReactNode {
  if (tabs.length === 0) return null

  const label = showAllProjects ? 'tags across projects' : 'tags'
  const labelWidth = stringWidth(label)
  const rightReserve = Math.max(
    stringWidth('(tab to switch)'),
    stringWidth('→ 99 (tab to switch)'),
  )
  const budget = availableWidth - (labelWidth + 1) - rightReserve - 2
  const cap = Math.max(20, Math.floor(budget / 2))

  const costs = tabs.map(tab => tabCost(tab, cap))
  const totalCost =
    costs.reduce((sum, cost) => sum + cost, 0) + Math.max(0, tabs.length - 1)
  const clamped = Math.max(0, Math.min(selectedIndex, tabs.length - 1))

  let from = 0
  let to = tabs.length
  if (totalCost > budget) {
    const windowBudget = budget - stringWidth('← 99 ')
    from = clamped
    to = clamped + 1
    let used = costs[clamped] ?? 0
    while (from > 0 || to < tabs.length) {
      let grew = false
      if (from > 0 && used + (costs[from - 1] ?? 0) + 1 <= windowBudget) {
        from--
        used += (costs[from] ?? 0) + 1
        grew = true
      }
      if (to < tabs.length && used + (costs[to] ?? 0) + 1 <= windowBudget) {
        used += (costs[to] ?? 0) + 1
        to++
        grew = true
      }
      if (!grew) break
    }
  }

  const hiddenLeft = from
  const hiddenRight = tabs.length - to

  return (
    <Box flexDirection="row" gap={1}>
      <Text color="suggestion">{label}</Text>
      {hiddenLeft > 0 && <Text dimColor>{`← ${hiddenLeft}`}</Text>}
      <Box flexDirection="row" gap={1}>
        {tabs.slice(from, to).map((tab, offset) => {
          const index = from + offset
          const isSelected = index === clamped
          const text = ` ${displayText(tab, cap)} `
          return isSelected ? (
            <Text
              key={`${index}-${tab.label}`}
              bold
              backgroundColor="suggestion"
              color="inverseText"
            >
              {text}
            </Text>
          ) : (
            <Text key={`${index}-${tab.label}`}>{text}</Text>
          )
        })}
      </Box>
      <Text dimColor>
        {hiddenRight > 0 ? `→ ${hiddenRight} (tab to switch)` : '(tab to switch)'}
      </Text>
    </Box>
  )
}

export default TagTabs
