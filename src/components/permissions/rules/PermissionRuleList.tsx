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
import { plural } from '../../../utils/stringUtils.js'
import {
  applyPermissionUpdate,
  persistPermissionUpdate,
} from '../../../utils/permissions/PermissionUpdate.js'
import {
  getAllowRules,
  getAskRules,
  getDenyRules,
  permissionRuleSourceDisplayString,
} from '../../../utils/permissions/decision/rules.js'
import { deletePermissionRule } from '../../../utils/permissions/permissions.js'
import { permissionRuleValueToString } from '../../../utils/permissions/permissionRuleParser.js'
import { getAutoModeDenials } from '../../../utils/autoModeDenials.js'
import type { ToolPermissionContext } from '../../../Tool.js'
import type { LocalJSXCommandOnDone } from '../../../types/command.js'
import type {
  PermissionBehavior,
  PermissionRule,
  PermissionRuleValue,
} from '../../../types/permissions.js'
import type { UnreachableRule } from '../../../utils/permissions/shadowedRuleDetection.js'
import { AddPermissionRules } from './AddPermissionRules.js'
import { AddWorkspaceDirectory } from './AddWorkspaceDirectory.js'
import { PermissionRuleDescription } from './PermissionRuleDescription.js'
import { PermissionRuleInput } from './PermissionRuleInput.js'
import { RecentDenialsTab, type RecentDenialsState } from './RecentDenialsTab.js'
import { RemoveWorkspaceDirectory } from './RemoveWorkspaceDirectory.js'
import { WorkspaceTab } from './WorkspaceTab.js'

type TabId = 'recent' | 'allow' | 'ask' | 'deny' | 'workspace'
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
  | { kind: 'add-directory' }
  | { kind: 'remove-directory'; path: string }

export type PermissionRuleListProps = {
  onExit: LocalJSXCommandOnDone
  initialTab?: TabId
  onRetryDenials?: (commands: string[]) => void
}

const BEHAVIOR_ADJECTIVE: Record<PermissionBehavior, string> = {
  allow: 'allowed',
  deny: 'denied',
  ask: 'ask',
}

/** The per-behaviour subtitle above each rules tab. */
const TAB_SUBTITLE: Record<'allow' | 'ask' | 'deny', string> = {
  allow: "Mercury won't ask before using allowed tools.",
  ask: 'Mercury will always ask for confirmation before using these tools.',
  deny: 'Mercury will always reject requests to use denied tools.',
}

/** A stable selection key over the WHOLE rule record including its source —
 *  two identical rule values from different sources stay distinct. */
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

/** One rules tab: search-filterable sorted list plus the add entry. */
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
    // The add entry is present only with an empty query.
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
    // The next focus target is computed BEFORE any deletion: the next rule in
    // the sorted list (excluding the add entry), the previous when the
    // selected rule is last, nothing when it is the only one.
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

/** Rule detail: read-only for managed policy rules, a destructive delete
 *  confirmation otherwise. */
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

/** The `/permissions` manager. */
export function PermissionRuleList({
  onExit,
  initialTab,
  onRetryDenials,
}: PermissionRuleListProps): React.ReactNode {
  const setAppState = useSetAppState()
  const toolPermissionContext = useAppState(state => state.toolPermissionContext)
  const isTerminalFocused = useTerminalFocus()
  const pendingExit = useExitOnCtrlCDWithKeybindings()

  // Denials are consulted once for the default-tab rule; the tab itself
  // captures its own copy at ITS mount.
  const [hasDenials] = useState(() => getAutoModeDenials().length > 0)
  const defaultTab: TabId = initialTab ?? (hasDenials ? 'recent' : 'allow')
  const [selectedTab, setSelectedTab] = useState<TabId>(defaultTab)
  const [subDialog, setSubDialog] = useState<SubDialog | null>(null)
  const [changeLog, setChangeLog] = useState<string[]>([])
  const [denialsState, setDenialsState] = useState<RecentDenialsState>({
    approved: new Set(),
    retryMarked: new Set(),
    denials: [],
  })
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

  // Search rides the shared single-line editor hook (its raw-input site
  // lives outside this file). Typing seeds the query; escape clears it;
  // enter/down hand focus back to the list; up hands focus to the tabs.
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
    (flavor: 'default' | 'workspace') => {
      const retryDisplays = [...denialsState.retryMarked]
        .sort((a, b) => a - b)
        .map(index => denialsState.denials[index]?.display ?? '')
        .filter(display => display !== '')
      if (retryDisplays.length > 0) {
        onRetryDenials?.(retryDisplays)
        onExit(undefined, {
          shouldQuery: true,
          metaMessages: [
            `Permission was granted for ${plural(retryDisplays.length, 'command')} ${retryDisplays.join(', ')} — retry ${retryDisplays.length === 1 ? 'it' : 'them'} now.`,
          ],
        })
        return
      }
      const approvedDisplays = [...denialsState.approved]
        .sort((a, b) => a - b)
        .map(index => denialsState.denials[index]?.display ?? '')
        .filter(display => display !== '')
      if (approvedDisplays.length > 0 || changeLog.length > 0) {
        const lines = [
          ...(approvedDisplays.length > 0
            ? [`Approved: ${approvedDisplays.map(display => chalk.bold(display)).join(', ')}`]
            : []),
          ...changeLog,
        ]
        onExit(lines.join('\n'))
        return
      }
      onExit(
        flavor === 'workspace'
          ? 'Workspace dialog dismissed.'
          : 'Permissions dialog dismissed.',
        { display: 'system' },
      )
    },
    [denialsState, changeLog, onExit, onRetryDenials],
  )

  // Escape at the list level: active only while no sub-dialog is open and
  // search mode is off.
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
          // The engine throws for read-only sources; those never reach the
          // delete affordance.
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

  const handleAddDirectory = useCallback(
    (path: string, remember?: boolean) => {
      const update = {
        type: 'addDirectories' as const,
        directories: [path],
        destination: remember ? ('localSettings' as const) : ('session' as const),
      }
      const updated = applyPermissionUpdate(toolPermissionContext, update)
      if (remember) persistPermissionUpdate(update)
      setToolPermissionContext(updated)
      appendLog(
        remember
          ? `Added workspace directory ${chalk.bold(path)} (saved to local settings)`
          : `Added workspace directory ${chalk.bold(path)} for this session`,
      )
      setSubDialog(null)
    },
    [toolPermissionContext, setToolPermissionContext, appendLog],
  )

  // ── Sub-dialogs replace the pane wholesale ───────────────────────────────
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
  if (subDialog?.kind === 'add-directory') {
    return (
      <AddWorkspaceDirectory
        permissionContext={toolPermissionContext}
        onAddDirectory={handleAddDirectory}
        onCancel={() => setSubDialog(null)}
      />
    )
  }
  if (subDialog?.kind === 'remove-directory') {
    return (
      <RemoveWorkspaceDirectory
        directoryPath={subDialog.path}
        permissionContext={toolPermissionContext}
        setPermissionContext={setToolPermissionContext}
        onRemove={path => {
          appendLog(`Removed workspace directory ${chalk.bold(path)}`)
          setSubDialog(null)
        }}
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

  // ── Footer hint ──────────────────────────────────────────────────────────
  let footer: string
  if (pendingExit.pending) {
    footer = exitChordNoticeText(pendingExit.keyName)
  } else if (headerFocused) {
    footer = '←→ switch tabs · ↓ content · esc cancel'
  } else if (searchMode) {
    footer = 'type to filter · ↵/↓ select · ↑ tabs · esc clear'
  } else if (defaultTab === 'recent') {
    footer = '↵ approve · r retry · ↑↓ navigate · ←→ switch · esc cancel'
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
        initialHeaderFocused={!hasDenials}
        navFromContent={!searchMode}
      >
        <Tab title="Recently denied" id="recent">
          <RecentDenialsTab
            onStateChange={setDenialsState}
            onHeaderFocusChange={setHeaderFocused}
          />
        </Tab>
        <Tab title="Allow" id="allow">
          {renderRulesTab('allow')}
        </Tab>
        <Tab title="Ask" id="ask">
          {renderRulesTab('ask')}
        </Tab>
        <Tab title="Deny" id="deny">
          {renderRulesTab('deny')}
        </Tab>
        <Tab title="Workspace" id="workspace">
          <WorkspaceTab
            toolPermissionContext={toolPermissionContext}
            onExit={() => exitManager('workspace')}
            onRequestAddDirectory={() => setSubDialog({ kind: 'add-directory' })}
            onRequestRemoveDirectory={path => setSubDialog({ kind: 'remove-directory', path })}
            onHeaderFocusChange={setHeaderFocused}
          />
        </Tab>
      </Tabs>
        <Text color="subtle">{footer}</Text>
      </Box>
    </Pane>
  )
}
