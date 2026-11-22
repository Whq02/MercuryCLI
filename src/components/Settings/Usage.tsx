import React, { useCallback, useRef, useState, useSyncExternalStore } from 'react'
import { useMeasure, usePublish } from '../../hooks/effects.js'
import { getUsageRecordVersion, subscribeUsageRecord } from '../../services/anthropicLimits.js'
import { useSettingsPopupFrameIfAny } from './Settings.js'
import { usagePopupLine } from './usageLine.js'
import { Box, Text, measureElement, useInput, wrapText, type DOMElement } from '../../ink.js'
import { usePopupListPaging } from '../CustomSelect/popup-list.js'
import { providerFamilyPresences } from '../../services/providers/providerUsage.js'
import { jevSessionFactsStamp, subscribeJevSessionFacts } from '../../services/jev/jevSessionFacts.js'
import { readJevSettings } from '../../services/jev/jevSetting.js'
import { UsageLayoutContext } from './usage/lines.js'
import { type UsageSection, orderUsageSections, liveSessionFamily, liveSignInRecency, usageSectionPlan } from './usage/plan.js'
import { EngineUsageSection } from './usage/sections.js'
import { AnthropicUsageSection } from './usage/anthropicSection.js'
import { usageColumns, usageWindow, jevUsageRowShown, jevUsageRow, usageBodyRows, UsageCompact } from './usage/compact.js'
import { notBuilt } from '../../pi/holes.js'

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

function UsageFull(arg0: { openToken?: number; width: number; rowBudget: number }): React.ReactNode {
  return notBuilt('src/components/Settings/Usage.tsx:31')
}
