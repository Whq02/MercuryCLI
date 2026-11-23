import React, { useCallback, useRef, useState, useSyncExternalStore } from 'react'
import { useMeasure, usePublish } from '../effects/effects.js'
import { getUsageRecordVersion, subscribeUsageRecord } from '../../models/roads/anthropic/anthropicLimits.js'
import { useSettingsPopupFrameIfAny } from './Settings.js'
import { usagePopupLine } from './usageLine.js'
import { Box, Text, measureElement, useInput, wrapText, type DOMElement } from '../themedRenderer.js'
import { usePopupListPaging } from '../select/popup-list.js'
import { providerFamilyPresences } from '../../models/roads/providerUsage.js'
import { jevSessionFactsStamp, subscribeJevSessionFacts } from '../../models/jev/jevSessionFacts.js'
import { readJevSettings } from '../../models/jev/jevSetting.js'
import { UsageLayoutContext } from './usage/lines.js'
import { type UsageSection, orderUsageSections, liveSessionFamily, liveSignInRecency, usageSectionPlan } from './usage/plan.js'
import { EngineUsageSection } from './usage/sections.js'
import { AnthropicUsageSection } from './usage/anthropicSection.js'
import { usageColumns, usageWindow, jevUsageRowShown, jevUsageRow, usageBodyRows, UsageCompact } from './usage/compact.js'

export { humanizeUsageError, SESSION_SPEND_LABEL, SCHEDULED_SPEND_LABEL, ADVISOR_SPEND_LABEL, SESSION_SPEND_NONE, MODEL_ROW_INDENT, sessionSpendLines, absentSlotLine, INACTIVE_SLOT_LINE, UsageCredits, carryTail, fullWindowLine } from './usage/lines.js'
export { type UsageSection, orderUsageSections, usageSectionPlan } from './usage/plan.js'
export { usageColumns, usageWindow, JEV_USAGE_LABEL, jevUsageRowShown, jevUsageRow, usageBodyRows, type UsageCompactLine, type UsageCompactReads, usageCompactLines } from './usage/compact.js'

export function Usage({ openToken, width = 146, rowBudget = 22, compact = false }: { openToken?: number; width?: number; rowBudget?: number; compact?: boolean }): React.ReactNode {
  const frame = useSettingsPopupFrameIfAny()
  const usageVersion = useSyncExternalStore(subscribeUsageRecord, getUsageRecordVersion, getUsageRecordVersion)
  usePublish(() => {
    frame?.setLine(usagePopupLine())
    frame?.setHint('↑↓ scroll · pgup/pgdn page · esc or click outside closes')
  }, [frame, usageVersion])
  return compact ? <UsageCompact {...(openToken !== undefined ? { openToken } : {})} width={width} rowBudget={rowBudget} /> : <UsageFull {...(openToken !== undefined ? { openToken } : {})} width={width} rowBudget={rowBudget} />
}

function UsageFull({ openToken, width, rowBudget }: { openToken?: number; width: number; rowBudget: number }): React.ReactNode {
  const plan = orderUsageSections(usageSectionPlan(providerFamilyPresences()), liveSignInRecency(), liveSessionFamily())
  const { perRow, colW, meterW, gap } = usageColumns(width, plan.length)
  const bands: UsageSection[][] = []
  for (let start = 0; start < plan.length; start += perRow) bands.push(plan.slice(start, start + perRow))
  const contentRef = useRef<DOMElement>(null)
  const [heights, setHeights] = useState<number[]>([])
  const [cardHeights, setCardHeights] = useState<number[][]>([])
  const [position, setPosition] = useState(0)
  const measure = useCallback(() => {
    const rows = contentRef.current?.childNodes ?? []
    const next = rows.map(node => node.nodeName === '#text' ? 0 : Math.ceil(measureElement(node).height))
    const cards = rows.map(node => node.nodeName === '#text' ? [] : node.childNodes.map(column => {
      if (column.nodeName === '#text') return 0
      const card = column.childNodes[0]
      return Math.ceil(measureElement(card !== undefined && card.nodeName !== '#text' ? card : column).height)
    }))
    setHeights(previous => previous.length === next.length && previous.every((height, index) => height === next[index]) ? previous : next)
    setCardHeights(previous => previous.length === cards.length && previous.every((band, index) => band.length === cards[index]!.length && band.every((height, card) => height === cards[index]![card])) ? previous : cards)
  }, [])
  useMeasure(measure)
  const budget = Math.max(0, Math.floor(rowBudget))
  useSyncExternalStore(subscribeJevSessionFacts, jevSessionFactsStamp, jevSessionFactsStamp)
  const jevLine = jevUsageRowShown() ? jevUsageRow() : undefined
  const routerRoad = readJevSettings().road === 'openrouter'
  const requestedJevRows = jevLine === undefined ? 0 : routerRoad ? wrapText(jevLine, Math.max(1, Math.floor(width)), 'wrap').split('\n').length : 1
  const { footerRows, jevRows, capacity } = usageBodyRows(budget, requestedJevRows)
  const view = usageWindow(bands.map((band, index) => ({ height: heights[index] ?? 1, count: band.length })), capacity, position)
  const totalRows = bands.reduce((sum, _, index) => sum + (heights[index] ?? 1) + 1, 0) - 1
  usePopupListPaging(view.offset, Math.max(1, totalRows - capacity + 1), capacity, setPosition)
  useInput((_input, key, event) => {
    if (!key.upArrow && !key.downArrow) return
    event.stopImmediatePropagation()
    if (key.wheelUp || key.wheelDown) return
    setPosition(key.upArrow ? view.previous : view.next)
  })
  let bandTop = 0
  const above: UsageSection[] = []
  bands.forEach((band, bandIndex) => {
    band.forEach((section, index) => {
      if (bandTop + Math.max(1, cardHeights[bandIndex]?.[index] ?? heights[bandIndex] ?? 1) <= view.offset) above.push(section)
    })
    bandTop += Math.max(1, heights[bandIndex] ?? 1) + 1
  })
  const below = bands.slice(view.endBand).flat()
  const more = [above.length ? `↑ ${above.length} more` : '', below.length ? `↓ ${below.length} more · ${below.map(section => section.title.replace(/ usage$/, '')).join(' · ')}` : ''].filter(Boolean).join(' · ')
  return (
    <UsageLayoutContext.Provider value={measure}>
      <Box flexDirection="column" width={Math.max(1, Math.floor(width))} height={budget} flexShrink={0} overflow="hidden">
        <Box flexDirection="column" height={capacity} flexShrink={0} overflow="hidden">
          <Box flexDirection="column" height={view.height} flexShrink={0} overflow="hidden">
            <Box ref={contentRef} flexDirection="column" flexShrink={0} marginTop={-view.offset}>
              {bands.map((band, bandIndex) => (
                <Box key={band.map(section => section.id).join('|')} flexDirection="row" flexShrink={0} marginTop={bandIndex > 0 ? 1 : 0}>
                  {band.map((section, index) => (
                    <Box key={section.id} flexDirection="column" width={colW} flexShrink={0} marginRight={index < band.length - 1 ? gap : 0}>
                      {section.kind === 'anthropic' ? (
                        <AnthropicUsageSection width={meterW} openToken={openToken} />
                      ) : (
                        <EngineUsageSection section={section} width={meterW} />
                      )}
                    </Box>
                  ))}
                </Box>
              ))}
            </Box>
          </Box>
        </Box>
        {jevRows > 0 ? <Box height={jevRows} flexShrink={0} overflow="hidden"><Text wrap={routerRoad ? 'wrap' : 'truncate-end'}>{jevLine}</Text></Box> : null}
        {footerRows > 0 ? <Box height={1} flexShrink={0}><Text dimColor wrap="truncate-end">{more}</Text></Box> : null}
      </Box>
    </UsageLayoutContext.Provider>
  )
}
