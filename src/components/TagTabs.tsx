// Horizontal tag-tab strip with a fitted window and hidden-count hints.
// The selected tab is always kept visible: the window starts as just the
// selected tab and expands left first, then right, while the budget holds.
// The render-time truncation budget is deliberately two columns tighter
// than the fitting budget: it under-fills
// rather than overflowing.

import React from 'react'
import { Box, Text } from '../ink.js'
import { stringWidth } from '../ink/stringWidth.js'
import { truncateToWidth } from '../utils/truncate.js'

export type TagTab = {
  label: string
  isAll?: boolean
}

/** Fitting cost of one tab cell (` text ` plus the # prefix for tags). */
function tabCost(tab: TagTab, cap: number): number {
  if (tab.isAll) return stringWidth(tab.label) + 2
  // The 3 covers a leading # and the two padding spaces.
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
  const label = showAllProjects ? 'tags across projects' : 'tags'
  const labelWidth = stringWidth(label)

  // Worst-case right hint assumes a two-digit hidden count; the budget
  // takes the larger of the with-count and no-count hint forms.
  const cycleHint = '(tab to switch)'
  const noCountHintWidth = stringWidth(cycleHint)
  const withCountHintWidth = stringWidth(`→ 99 ${cycleHint}`)
  const worstHintWidth = Math.max(noCountHintWidth, withCountHintWidth)
  const budget = availableWidth - (labelWidth + 1) - worstHintWidth - 2
  const cap = Math.max(20, Math.floor(budget / 2))
  const leftArrowAllowance = stringWidth('← 99 ')

  const selected = Math.min(Math.max(0, selectedIndex), Math.max(0, tabs.length - 1))

  // All tabs plus their gaps fit → show everything.
  const totalCost = tabs.reduce(
    (sum, tab, index) => sum + tabCost(tab, cap) + (index > 0 ? 1 : 0),
    0,
  )
  let from = selected
  let to = selected + 1
  if (totalCost <= budget) {
    from = 0
    to = tabs.length
  } else {
    // Expand left first, then right, one tab at a time, against the budget
    // reduced by the left-arrow allowance.
    const windowBudget = budget - leftArrowAllowance
    let used = tabs[selected] ? tabCost(tabs[selected]!, cap) : 0
    let expanded = true
    while (expanded) {
      expanded = false
      if (from > 0) {
        const cost = tabCost(tabs[from - 1]!, cap) + 1
        if (used + cost <= windowBudget) {
          from -= 1
          used += cost
          expanded = true
        }
      }
      if (to < tabs.length) {
        const cost = tabCost(tabs[to]!, cap) + 1
        if (used + cost <= windowBudget) {
          to += 1
          used += cost
          expanded = true
        }
      }
    }
  }

  const hiddenLeft = from
  const hiddenRight = tabs.length - to

  return (
    <Box gap={1}>
      <Text color="suggestion">{label}</Text>
      {hiddenLeft > 0 ? <Text dimColor>← {hiddenLeft}</Text> : null}
      <Box>
        {tabs.slice(from, to).map((tab, offset) => {
          const index = from + offset
          const isSelected = index === selected
          return (
            <React.Fragment key={`${tab.label}-${index}`}>
              {offset > 0 ? <Text> </Text> : null}
              <Text
                bold={isSelected}
                backgroundColor={isSelected ? 'suggestion' : undefined}
                color={isSelected ? 'inverseText' : undefined}
              >
                {` ${displayText(tab, cap)} `}
              </Text>
            </React.Fragment>
          )
        })}
      </Box>
      {hiddenRight > 0 ? (
        <Text dimColor>
          → {hiddenRight} {cycleHint}
        </Text>
      ) : (
        <Text dimColor>{cycleHint}</Text>
      )}
    </Box>
  )
}

export default TagTabs
