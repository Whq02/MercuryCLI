import * as React from 'react'
import { exitChordNoticeText } from '../../PromptInput/ExitChordNotice.js'
import { useCallback, useMemo, useState } from 'react'
import chalk from 'chalk'
import { Box, Text } from '../../../ink.js'
import { Pane } from '../../design-system/Pane.js'
import { SearchBox } from '../../SearchBox.js'
import { Select } from '../../CustomSelect/select.js'
import { Tab, Tabs, useTabHeaderFocus } from '../../design-system/Tabs.js'
import { useKeybinding } from '../../../keybindings/useKeybinding.js'
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

export type PermissionRuleListProps = {
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
}: {
  behavior: PermissionBehavior
  context: ToolPermissionContext
  query: string
  searchMode: boolean
  onSelectRule: (rule: PermissionRule, nextFocus: string | null) => void
  onAddRule: () => void
  onCancel: () => void
}): React.ReactNode {
  const { headerFocused, focusHeader } = useTabHeaderFocus()
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
        visibleOptionCount={Math.min(10, Math.max(1, options.length))}
        isDisabled={searchMode || headerFocused}
        onChange={handleChange}
        onCancel={onCancel}
        onUpFromFirstItem={focusHeader}
      />
    </Box>
  )
}

function RuleDetail({
  rule,
  onDelete,
  onBack,
}: {
  rule: PermissionRule
  onDelete: () => void
  onBack: () => void
}): React.ReactNode {
  const pendingExit = useExitOnCtrlCDWithKeybindings()
  useKeybinding('confirm:no', () => onBack(), { context: 'Confirmation' })
  const ruleString = permissionRuleValueToString(rule.ruleValue)
  const managed = rule.source === 'policySettings'

  if (managed) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="permission" paddingX={1}>
        <Text bold>Rule details</Text>
        <Text bold>{ruleString}</Text>
        <PermissionRuleDescription ruleValue={rule.ruleValue} />
        <Text>From {permissionRuleSourceDisplayString(rule.source)}</Text>
        <Text italic>
          This rule is configured by managed settings and cannot be modified. Contact your
          administrator to change it.
        </Text>
        <Text color="subtle">
          {pendingExit.pending ? exitChordNoticeText(pendingExit.keyName) : 'esc back'}
        </Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="error" paddingX={1}>
      <Text bold>Delete {BEHAVIOR_ADJECTIVE[rule.ruleBehavior]} rule?</Text>
      <Text bold>{ruleString}</Text>
      <PermissionRuleDescription ruleValue={rule.ruleValue} />
      <Text>From {permissionRuleSourceDisplayString(rule.source)}</Text>
      <Select
        options={[
          { label: 'Yes', value: 'yes' },
          { label: 'No', value: 'no' },
        ]}
        onChange={value => (value === 'yes' ? onDelete() : onBack())}
        onCancel={onBack}
      />
      <Text color="subtle">
        {pendingExit.pending ? exitChordNoticeText(pendingExit.keyName) : 'esc back'}
      </Text>
    </Box>
  )
}

export function PermissionRuleList({
  onExit,
  initialTab,
}: PermissionRuleListProps): React.ReactNode {
  const setAppState = useSetAppState()
  const toolPermissionContext = useAppState(state => state.toolPermissionContext)
  const isTerminalFocused = useTerminalFocus()
  const pendingExit = useExitOnCtrlCDWithKeybindings()

  const defaultTab: TabId = initialTab ?? 'allow'
  const [selectedTab, setSelectedTab] = useState<TabId>(defaultTab)
  const [subDialog, setSubDialog] = useState<SubDialog | null>(null)
  const [changeLog, setChangeLog] = useState<string[]>([])
  const [headerFocused, setHeaderFocused] = useState(false)
  const [listFocusValue, setListFocusValue] = useState<string | undefined>(undefined)
  void listFocusValue

  const setToolPermissionContext = useCallback(
    (context: ToolPermissionContext) => {
      setAppState(prev => ({ ...prev, toolPermissionContext: context }))
    },
    [setAppState],
  )

  const isRulesTab = selectedTab === 'allow' || selectedTab === 'ask' || selectedTab === 'deny'

  const search = useSearchInput({
    isActive: subDialog === null && isRulesTab,
    onExit: () => {},
    onCancel: () => search.setQuery(''),
    onExitUp: () => setHeaderFocused(true),
  })
  const searchMode = search.query !== ''

  const appendLog = useCallback((line: string) => {
    setChangeLog(current => [...current, line])
  }, [])

  const exitManager = useCallback(
    (_flavor: 'default') => {
      if (changeLog.length > 0) {
        onExit(changeLog.join('\n'))
        return
      }
      onExit(
        'Permissions dialog dismissed.',
        { display: 'system' },
      )
    },
    [changeLog, onExit],
  )

  useKeybinding('confirm:no', () => exitManager('default'), {
    context: 'Settings',
    isActive: subDialog === null && !searchMode,
  })

  const handleDelete = useCallback(
    (rule: PermissionRule, nextFocus: string | null) => {
      void deletePermissionRule({
        rule,
        initialContext: toolPermissionContext,
        setToolPermissionContext,
      })
        .then(() => {
          appendLog(
            `Deleted ${BEHAVIOR_ADJECTIVE[rule.ruleBehavior]} rule ${chalk.bold(
              permissionRuleValueToString(rule.ruleValue),
            )}`,
          )
          setListFocusValue(nextFocus ?? undefined)
        })
        .catch(() => {
        })
      setSubDialog(null)
    },
    [toolPermissionContext, setToolPermissionContext, appendLog],
  )

  const handleRulesAdded = useCallback(
    (rules: PermissionRule[], unreachable?: UnreachableRule[]) => {
      for (const rule of rules) {
        appendLog(
          `Added ${BEHAVIOR_ADJECTIVE[rule.ruleBehavior]} rule ${chalk.bold(
            permissionRuleValueToString(rule.ruleValue),
          )}`,
        )
      }
      for (const finding of unreachable ?? []) {
        const severity = finding.shadowType === 'deny' ? 'blocked' : 'shadowed'
        appendLog(
          chalk.bold(
            `Warning: rule ${permissionRuleValueToString(finding.rule.ruleValue)} is ${severity}`,
          ),
        )
        appendLog(chalk.dim(`  ${finding.reason}`))
        appendLog(chalk.dim(`  Fix: ${finding.fix}`))
      }
      setSubDialog(null)
    },
    [appendLog],
  )

  if (subDialog?.kind === 'detail') {
    return (
      <RuleDetail
        rule={subDialog.rule}
        onDelete={() => handleDelete(subDialog.rule, subDialog.nextFocus)}
        onBack={() => setSubDialog(null)}
      />
    )
  }
  if (subDialog?.kind === 'add-input') {
    return (
      <PermissionRuleInput
        ruleBehavior={subDialog.behavior}
        onCancel={() => setSubDialog(null)}
        onSubmit={(ruleValue, ruleBehavior) =>
          setSubDialog({ kind: 'add-destination', ruleValues: [ruleValue], behavior: ruleBehavior })
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
        onAddRules={handleRulesAdded}
        onCancel={() => setSubDialog(null)}
      />
    )
  }

  const renderRulesTab = (behavior: 'allow' | 'ask' | 'deny'): React.ReactNode => (
    <Box flexDirection="column">
      {searchMode ? (
        <SearchBox
          query={search.query}
          isFocused
          isTerminalFocused={isTerminalFocused}
          cursorOffset={search.cursorOffset}
        />
      ) : null}
      <RulesTabContent
        behavior={RULE_TABS[behavior]}
        context={toolPermissionContext}
        query={search.query}
        searchMode={searchMode}
        onSelectRule={(rule, nextFocus) => setSubDialog({ kind: 'detail', rule, nextFocus })}
        onAddRule={() => setSubDialog({ kind: 'add-input', behavior })}
        onCancel={() => exitManager('default')}
      />
    </Box>
  )

  let footer: string
  if (pendingExit.pending) {
    footer = exitChordNoticeText(pendingExit.keyName)
  } else if (headerFocused) {
    footer = '←→ switch tabs · ↓ content · esc cancel'
  } else if (searchMode) {
    footer = 'type to filter · ↵/↓ select · ↑ tabs · esc clear'
  } else {
    footer = '↑↓ navigate · ↵ select · type to search · ←→ switch · esc cancel'
  }

  return (
    <Pane color="permission">
      <Box flexDirection="column">
        <Tabs
          title="Permissions:"
          color="permission"
        defaultTab={defaultTab}
        selectedTab={selectedTab}
        onTabChange={id => setSelectedTab(id as TabId)}
        initialHeaderFocused
        navFromContent={!searchMode}
      >
        <Tab title="Allow" id="allow">
          {renderRulesTab('allow')}
        </Tab>
        <Tab title="Ask" id="ask">
          {renderRulesTab('ask')}
        </Tab>
        <Tab title="Deny" id="deny">
          {renderRulesTab('deny')}
        </Tab>
      </Tabs>
        <Text color="subtle">{footer}</Text>
      </Box>
    </Pane>
  )
}
