import * as React from 'react'
import { exitChordNoticeText } from '../../PromptInput/ExitChordNotice.js'
import { useCallback, useRef, useState } from 'react'
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

const TAB_SUBTITLE: Record<'allow' | 'ask' | 'deny', string> = {
  allow: "Mercury won't ask before using allowed tools.",
  ask: 'Mercury will always ask for confirmation before using these tools.',
  deny: 'Mercury will always reject requests to use denied tools.',
}

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

function RuleDetailDialog({
  rule,
  onDelete,
  onCancel,
}: {
  rule: PermissionRule
  onDelete: () => void
  onCancel: () => void
}): React.ReactNode {
  const exitState = useExitOnCtrlCDWithKeybindings()
  const isManaged = rule.source === 'policySettings'
  const ruleStr = permissionRuleValueToString(rule.ruleValue)
  const sourceDisplay = permissionRuleSourceDisplayString(rule.source)

  useKeybinding('confirm:no', onCancel, { context: 'Settings', isActive: isManaged })

  if (isManaged) {
    return (
      <Box flexDirection="column">
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="permission"
          paddingX={1}
          marginTop={1}
          gap={1}
        >
          <Text bold color="permission">
            Rule details
          </Text>
          <Box flexDirection="column">
            <Text bold>{ruleStr}</Text>
            <PermissionRuleDescription ruleValue={rule.ruleValue} />
            <Text dimColor>From {sourceDisplay}</Text>
          </Box>
          <Text italic>
            This rule is configured by managed settings and cannot be modified. Contact your
            administrator to change it.
          </Text>
        </Box>
        <Box marginLeft={2}>
          <Text dimColor>
            {exitState.pending ? exitChordNoticeText(exitState.keyName) : 'esc back'}
          </Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="error"
        paddingX={1}
        marginTop={1}
        gap={1}
      >
        <Text bold color="error">
          Delete {BEHAVIOR_ADJECTIVE[rule.ruleBehavior]} rule?
        </Text>
        <Box flexDirection="column">
          <Text bold>{ruleStr}</Text>
          <PermissionRuleDescription ruleValue={rule.ruleValue} />
          <Text dimColor>From {sourceDisplay}</Text>
        </Box>
        <Select
          options={[
            { label: 'Yes', value: 'yes' },
            { label: 'No', value: 'no' },
          ]}
          onChange={value => {
            if (value === 'yes') {
              onDelete()
            } else {
              onCancel()
            }
          }}
          onCancel={onCancel}
        />
      </Box>
      <Box marginLeft={2}>
        <Text dimColor>
          {exitState.pending ? exitChordNoticeText(exitState.keyName) : 'esc back'}
        </Text>
      </Box>
    </Box>
  )
}

export function PermissionRuleList({
  onExit,
  initialTab = 'allow',
}: PermissionRuleListProps): React.ReactNode {
  const toolPermissionContext = useAppState(s => s.toolPermissionContext)
  const setAppState = useSetAppState()
  const isTerminalFocused = useTerminalFocus()
  const [activeTab, setActiveTab] = useState<TabId>(initialTab)
  const [subDialog, setSubDialog] = useState<SubDialog | null>(null)
  const [searchMode, setSearchMode] = useState(false)
  const [headerFocused, setHeaderFocused] = useState(true)
  const [changeLog, setChangeLog] = useState<string[]>([])
  const focusHeaderRef = useRef<() => void>(() => {})
  const queryRef = useRef('')
  const exitedRef = useRef(false)

  const exitState = useExitOnCtrlCDWithKeybindings(undefined, undefined, subDialog === null)

  const setToolPermissionContext = useCallback(
    (next: ToolPermissionContext) => {
      setAppState(prev => ({ ...prev, toolPermissionContext: next }))
    },
    [setAppState],
  )

  const handleExit = useCallback(() => {
    if (exitedRef.current) return
    exitedRef.current = true
    if (changeLog.length > 0) {
      onExit(changeLog.join('\n'))
    } else {
      onExit('Permissions dialog dismissed.', { display: 'system' })
    }
  }, [changeLog, onExit])

  const { query, setQuery, cursorOffset } = useSearchInput({
    isActive: subDialog === null && searchMode,
    onExit: () => setSearchMode(false),
    onExitUp: () => {
      setSearchMode(false)
      focusHeaderRef.current()
    },
    onCancel: () => {
      queryRef.current = ''
      setQuery('')
      setSearchMode(false)
    },
  })
  queryRef.current = query

  useInput(
    (input, key) => {
      if (
        key.ctrl ||
        key.meta ||
        key.return ||
        key.escape ||
        key.tab ||
        key.backspace ||
        key.delete ||
        key.upArrow ||
        key.downArrow ||
        key.leftArrow ||
        key.rightArrow ||
        key.pageUp ||
        key.pageDown
      ) {
        return
      }
      if (input.length === 0 || input < ' ') return
      queryRef.current = queryRef.current + input
      setQuery(queryRef.current)
      setSearchMode(true)
    },
    { isActive: subDialog === null && !searchMode },
  )

  useKeybinding('confirm:no', handleExit, {
    context: 'Settings',
    isActive: subDialog === null && !searchMode,
  })

  const handleHeaderFocusChange = useCallback((focused: boolean, focus: () => void) => {
    setHeaderFocused(focused)
    focusHeaderRef.current = focus
  }, [])

  const handleDeleteRule = useCallback(
    (rule: PermissionRule) => {
      const adj = BEHAVIOR_ADJECTIVE[rule.ruleBehavior]
      const ruleStr = permissionRuleValueToString(rule.ruleValue)
      void deletePermissionRule({
        rule,
        initialContext: toolPermissionContext,
        setToolPermissionContext,
      })
        .then(() => {
          setChangeLog(prev => [...prev, `Deleted ${adj} rule ${chalk.bold(ruleStr)}`])
          setSubDialog(null)
        })
        .catch(err => {
          logError(err)
          setChangeLog(prev => [
            ...prev,
            `Could not delete ${adj} rule ${chalk.bold(ruleStr)}: ${errorMessage(err)}`,
          ])
          setSubDialog(null)
        })
    },
    [toolPermissionContext, setToolPermissionContext],
  )

  const handleAddRulesComplete = useCallback(
    (rules: PermissionRule[], unreachable?: UnreachableRule[]) => {
      const entries: string[] = []
      for (const rule of rules) {
        const adj = BEHAVIOR_ADJECTIVE[rule.ruleBehavior]
        const ruleStr = permissionRuleValueToString(rule.ruleValue)
        entries.push(`Added ${adj} rule ${chalk.bold(ruleStr)}`)
      }
      if (unreachable) {
        for (const item of unreachable) {
          const ruleStr = permissionRuleValueToString(item.rule.ruleValue)
          const kind = item.shadowType === 'deny' ? 'blocked' : 'shadowed'
          entries.push(
            `Warning: rule ${ruleStr} is ${kind}\n${chalk.dim(item.reason)}\n${chalk.dim(`Fix: ${item.fix}`)}`,
          )
        }
      }
      if (entries.length > 0) {
        setChangeLog(prev => [...prev, ...entries])
      }
      setSubDialog(null)
    },
    [],
  )

  if (subDialog?.kind === 'detail') {
    return (
      <RuleDetailDialog
        rule={subDialog.rule}
        onDelete={() => handleDeleteRule(subDialog.rule)}
        onCancel={() => setSubDialog(null)}
      />
    )
  }

  if (subDialog?.kind === 'add-input') {
    return (
      <PermissionRuleInput
        ruleBehavior={subDialog.behavior}
        onCancel={() => setSubDialog(null)}
        onSubmit={(ruleValue: PermissionRuleValue) =>
          setSubDialog({
            kind: 'add-destination',
            ruleValues: [ruleValue],
            behavior: subDialog.behavior,
          })
        }
      />
    )
  }

  if (subDialog?.kind === 'add-destination') {
    return (
      <AddPermissionRules
        ruleValues={subDialog.ruleValues}
        ruleBehavior={subDialog.behavior}
        initialContext={toolPermissionContext}
        setToolPermissionContext={setToolPermissionContext}
        onCancel={() => setSubDialog(null)}
        onAddRules={handleAddRulesComplete}
      />
    )
  }

  const footer = exitState.pending
    ? exitChordNoticeText(exitState.keyName)
    : searchMode
      ? 'type to filter · ↵/↓ select · ↑ tabs · esc clear'
      : headerFocused
        ? '←→ switch tabs · ↓ content · esc cancel'
        : '↑↓ navigate · pgup/pgdn page · ↵ select · type to search · ←→ switch · esc cancel'

  const tabs: ReadonlyArray<{ id: TabId; title: string }> = [
    { id: 'allow', title: 'Allow' },
    { id: 'ask', title: 'Ask' },
    { id: 'deny', title: 'Deny' },
  ]

  return (
    <Box flexDirection="column">
      <Pane color="permission">
        <Tabs
          title="Permissions:"
          color="permission"
          selectedTab={activeTab}
          onTabChange={(id: string) => {
            if (id === 'allow' || id === 'ask' || id === 'deny') {
              setActiveTab(id)
            }
          }}
          disableNavigation={searchMode}
          banner={
            <SearchBox
              query={query}
              isFocused={searchMode}
              isTerminalFocused={isTerminalFocused}
              cursorOffset={cursorOffset}
            />
          }
        >
          {tabs.map(({ id, title }) => (
            <Tab key={id} id={id} title={title}>
              <RulesTabContent
                behavior={RULE_TABS[id]}
                context={toolPermissionContext}
                query={query}
                searchMode={searchMode}
                onSelectRule={(rule, nextFocus) =>
                  setSubDialog({ kind: 'detail', rule, nextFocus })
                }
                onAddRule={() =>
                  setSubDialog({ kind: 'add-input', behavior: RULE_TABS[id] })
                }
                onCancel={handleExit}
                onHeaderFocusChange={handleHeaderFocusChange}
              />
            </Tab>
          ))}
        </Tabs>
      </Pane>
      <Box marginLeft={2}>
        <Text dimColor>{footer}</Text>
      </Box>
    </Box>
  )
}
