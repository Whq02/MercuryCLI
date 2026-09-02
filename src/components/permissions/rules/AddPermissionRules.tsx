import * as React from 'react'
import { Box, Text } from '../../../ink.js'
import { Dialog } from '../../design-system/Dialog.js'
import { Select } from '../../CustomSelect/select.js'
import type { OptionWithDescription } from '../../CustomSelect/select.js'
import { plural } from '../../../utils/stringUtils.js'
import { toTildePath } from '../../../utils/path.js'
import {
  SOURCES,
  type EditableSettingSource,
} from '../../../utils/settings/constants.js'
import {
  getRelativeSettingsFilePathForSource,
  getSettingsFilePathForSource,
} from '../../../utils/settings/settings.js'
import {
  applyPermissionUpdate,
  persistPermissionUpdate,
} from '../../../utils/permissions/PermissionUpdate.js'
import { detectUnreachableRules, type UnreachableRule } from '../../../utils/permissions/shadowedRuleDetection.js'
import { permissionRuleValueToString } from '../../../utils/permissions/permissionRuleParser.js'
import { SandboxManager } from '../../../utils/sandbox/sandbox-adapter.js'
import type { ToolPermissionContext } from '../../../Tool.js'
import type {
  PermissionBehavior,
  PermissionRule,
  PermissionRuleValue,
} from '../../../types/permissions.js'
import { PermissionRuleDescription } from './PermissionRuleDescription.js'

/** One save-destination option, described by where it will be written. */
export function optionForPermissionSaveDestination(
  source: EditableSettingSource,
): OptionWithDescription<string> {
  if (source === 'userSettings') {
    const path = getSettingsFilePathForSource(source)
    return {
      label: 'User settings',
      value: source,
      description: path ? toTildePath(path) : 'your user settings',
    }
  }
  if (source === 'projectSettings') {
    return {
      label: 'Project settings (checked in)',
      value: source,
      description: getRelativeSettingsFilePathForSource(source) ?? undefined,
    }
  }
  return {
    label: 'Project settings (local)',
    value: source,
    description: getRelativeSettingsFilePathForSource(source) ?? undefined,
  }
}

export function AddPermissionRules({
  onAddRules,
  onCancel,
  ruleValues,
  ruleBehavior,
  initialContext,
  setToolPermissionContext,
}: {
  onAddRules: (rules: PermissionRule[], unreachable?: UnreachableRule[]) => void
  onCancel: () => void
  ruleValues: PermissionRuleValue[]
  ruleBehavior: PermissionBehavior
  initialContext: ToolPermissionContext
  setToolPermissionContext: (context: ToolPermissionContext) => void
}): React.ReactNode {
  const options = SOURCES.map(optionForPermissionSaveDestination)

  function handleChange(destination: string): void {
    const update = {
      type: 'addRules' as const,
      rules: ruleValues,
      behavior: ruleBehavior,
      destination: destination as EditableSettingSource,
    }
    const updated = applyPermissionUpdate(initialContext, update)
    persistPermissionUpdate(update)
    setToolPermissionContext(updated)

    const created: PermissionRule[] = ruleValues.map(ruleValue => ({
      source: destination as EditableSettingSource,
      ruleBehavior,
      ruleValue,
    }))
    // Newly unreachable rules are detected against the UPDATED context, with
    // the same sandbox auto-allow flag the debug pane uses, and reported only
    // when they match the rules just added.
    const sandboxAutoAllowEnabled =
      SandboxManager.isSandboxingEnabled() &&
      SandboxManager.isAutoAllowBashIfSandboxedEnabled()
    const unreachable = detectUnreachableRules(updated, { sandboxAutoAllowEnabled }).filter(
      finding =>
        ruleValues.some(
          added =>
            added.toolName === finding.rule.ruleValue.toolName &&
            added.ruleContent === finding.rule.ruleValue.ruleContent,
        ),
    )
    onAddRules(created, unreachable.length > 0 ? unreachable : undefined)
  }

  return (
    <Dialog title={`Add ${plural(ruleValues.length, 'rule')}`} onCancel={onCancel} color="permission">
      <Text>
        Where should {ruleValues.length === 1 ? 'this rule' : 'these rules'} be saved?
      </Text>
      {ruleValues.map((ruleValue, index) => (
        <Box key={index} flexDirection="column">
          <Text bold>{permissionRuleValueToString(ruleValue)}</Text>
          <PermissionRuleDescription ruleValue={ruleValue} />
        </Box>
      ))}
      <Select options={options} onChange={handleChange} onCancel={onCancel} />
    </Dialog>
  )
}
