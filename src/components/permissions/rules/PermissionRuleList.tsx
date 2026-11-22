import * as React from 'react'
import { exitChordNoticeText } from '../../PromptInput/ExitChordNotice.js'
import { useCallback, useState } from 'react'
import chalk from 'chalk'
import { Box, Text, useInput } from '../../../ink.js'
import { usePopupListNavigation } from '../../CustomSelect/popup-list.js'
import { Pane } from '../../design-system/Pane.js'
import { SearchBox } from '../../SearchBox.js'
import { Select } from '../../CustomSelect/select.js'
import { Tab, Tabs, useTabHeaderFocus } from '../../design-system/Tabs.js'
import { useKeybinding } from '../../../keybindings/useKeybinding.js'
import { usePublish } from '../../../hooks/effects.js'
import { useExitOnCtrlCDWithKeybindings } from '../../../hooks/useExitOnCtrlCDWithKeybindings.js'
import { useSearchInput } from '../../../hooks/useSearchInput.js'
import { useTerminalFocus } from '../../../ink.js'
import { useAppState, useSetAppState } from '../../../state/AppState.js'
import {
  getAllowRules,
  getAskRules,
  getDenyRules,
  permissionRuleSourceDisplayString,
} from '../../../utils/permissions/decision/rules.js'
import { deletePermissionRule } from '../../../utils/permissions/permissions.js'
import { permissionRuleValueToString } from '../../../utils/permissions/permissionRuleParser.js'
import { errorMessage } from '../../../utils/errors.js'
import { logError } from '../../../utils/log.js'
import type { ToolPermissionContext } from '../../../Tool.js'
import type { LocalJSXCommandOnDone } from '../../../types/command.js'
import type {
  PermissionBehavior,
  PermissionRule,
  PermissionRuleValue,
} from '../../../types/permissions.js'
import type { UnreachableRule } from '../../../utils/permissions/shadowedRuleDetection.js'
import { AddPermissionRules } from './AddPermissionRules.js'
import { PermissionRuleDescription } from './PermissionRuleDescription.js'
import { PermissionRuleInput } from './PermissionRuleInput.js'
import { notBuilt, unbuilt } from '../../../pi/holes.js'

type TabId = 'allow' | 'ask' | 'deny'
const RULE_TABS: Record<'allow' | 'ask' | 'deny', PermissionBehavior> = {
  allow: 'allow',
  ask: 'ask',
  deny: 'deny',
}
const ADD_VALUE = '__add-rule__'

type SubDialog =
  | { kind: 'detail'; rule: PermissionRule; nextFocus: string | null }
  | { kind: 'add-input'; behavior: PermissionBehavior }
  | { kind: 'add-destination'; ruleValues: PermissionRuleValue[]; behavior: PermissionBehavior }

type PermissionRuleListProps = {
  onExit: LocalJSXCommandOnDone
  initialTab?: TabId
}

const BEHAVIOR_ADJECTIVE: Record<PermissionBehavior, string> = {
  allow: 'allowed',
  deny: 'denied',
  ask: 'ask',
}

const TAB_SUBTITLE: Record<'allow' | 'ask' | 'deny', string> = unbuilt('src/components/permissions/rules/PermissionRuleList.tsx:63')

function ruleKey(rule: PermissionRule): string {
  return JSON.stringify([
    permissionRuleValueToString(rule.ruleValue),
    rule.source,
    rule.ruleBehavior,
  ])
}

function sortedRulesFor(
  context: ToolPermissionContext,
  behavior: PermissionBehavior,
): PermissionRule[] {
  const rules =
    behavior === 'allow'
      ? getAllowRules(context)
      : behavior === 'deny'
        ? getDenyRules(context)
        : getAskRules(context)
  return [...rules].sort((a, b) =>
    permissionRuleValueToString(a.ruleValue)
      .toLowerCase()
      .localeCompare(permissionRuleValueToString(b.ruleValue).toLowerCase()),
  )
}

function RulesTabContent({
  behavior,
  context,
  query,
  searchMode,
  onSelectRule,
  onAddRule,
  onCancel,
  onHeaderFocusChange,
}: {
  behavior: PermissionBehavior
  context: ToolPermissionContext
  query: string
  searchMode: boolean
  onSelectRule: (rule: PermissionRule, nextFocus: string | null) => void
  onAddRule: () => void
  onCancel: () => void
  onHeaderFocusChange: (focused: boolean, focus: () => void) => void
}): React.ReactNode {
  const { headerFocused, focusHeader, blurHeader } = useTabHeaderFocus()
  const [entryFocus, setEntryFocus] = useState<string | undefined>()
  usePublish(() => onHeaderFocusChange(headerFocused, focusHeader), [headerFocused, focusHeader, onHeaderFocusChange])
  const sorted = sortedRulesFor(context, behavior)
  const filtered =
    query === ''
      ? sorted
      : sorted.filter(rule =>
          permissionRuleValueToString(rule.ruleValue)
            .toLowerCase()
            .includes(query.toLowerCase()),
        )

  const options = [
    ...(query === '' ? [{ label: 'Add a new rule…', value: ADD_VALUE }] : []),
    ...filtered.map(rule => ({
      label: permissionRuleValueToString(rule.ruleValue),
      value: ruleKey(rule),
    })),
  ]

  const visibleCount = Math.min(10, Math.max(1, options.length))
  usePopupListNavigation(-1, options.length, visibleCount, target => {
    setEntryFocus(options[target]?.value)
    blurHeader()
  }, headerFocused)

  function handleChange(value: string): void {
    if (value === ADD_VALUE) {
      onAddRule()
      return
    }
    const index = filtered.findIndex(rule => ruleKey(rule) === value)
    const rule = filtered[index]
    if (!rule) return
    const next =
      filtered.length <= 1
        ? null
        : index < filtered.length - 1
          ? ruleKey(filtered[index + 1] as PermissionRule)
          : ruleKey(filtered[index - 1] as PermissionRule)
    onSelectRule(rule, next)
  }

  return (
    <Box flexDirection="column">
      <Text dimColor>{TAB_SUBTITLE[behavior as 'allow' | 'ask' | 'deny']}</Text>
      <Select
        options={options}
        visibleOptionCount={visibleCount}
        defaultFocusValue={entryFocus}
        isDisabled={searchMode || headerFocused}
        onChange={handleChange}
        onCancel={onCancel}
        onUpFromFirstItem={focusHeader}
      />
    </Box>
  )
}

export function PermissionRuleList(arg0: PermissionRuleListProps): React.ReactNode {
  return notBuilt('src/components/permissions/rules/PermissionRuleList.tsx:226')
}
