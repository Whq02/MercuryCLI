import * as React from 'react'
import { Box, Text } from '../../../ink.js'
import type { ToolPermissionContext } from '../../../Tool.js'
import type { PermissionBehavior, PermissionRule, PermissionRuleValue, PermissionUpdate } from '../../../types/permissions.js'
import { toTildePath } from '../../../utils/path.js'
import { permissionRuleValueToString } from '../../../utils/permissions/permissionRuleParser.js'
import { applyPermissionUpdate, persistPermissionUpdate } from '../../../utils/permissions/PermissionUpdate.js'
import { detectUnreachableRules, type UnreachableRule } from '../../../utils/permissions/shadowedRuleDetection.js'
import { SOURCES, type EditableSettingSource } from '../../../utils/settings/constants.js'
import { getRelativeSettingsFilePathForSource, getSettingsFilePathForSource } from '../../../utils/settings/settings.js'
import { plural } from '../../../utils/stringUtils.js'
import { Select } from '../../CustomSelect/select.js'
import type { OptionWithDescription } from '../../CustomSelect/select.js'
import { Dialog } from '../../design-system/Dialog.js'
import { PermissionRuleDescription } from './PermissionRuleDescription.js'

const DESTINATION_LABEL: Record<EditableSettingSource, string> = {
  userSettings: 'User settings',
  projectSettings: 'Project settings (checked in)',
  localSettings: 'Project settings (local)',
}

function destinationDescription(source: EditableSettingSource): string | undefined {
  if (source !== 'userSettings') return getRelativeSettingsFilePathForSource(source)
  const path = getSettingsFilePathForSource(source)
  return path ? toTildePath(path) : 'your user settings'
}

const destinationOption = (source: EditableSettingSource): OptionWithDescription<EditableSettingSource> => ({
  label: DESTINATION_LABEL[source],
  value: source,
  description: destinationDescription(source),
})

const sameSpelling = (a: PermissionRuleValue, b: PermissionRuleValue): boolean =>
  a.toolName === b.toolName && a.ruleContent === b.ruleContent

function newlyUnreachable(context: ToolPermissionContext, added: PermissionRuleValue[]): UnreachableRule[] | undefined {
  const findings = detectUnreachableRules(context).filter(finding =>
    added.some(value => sameSpelling(value, finding.rule.ruleValue)),
  )
  return findings.length > 0 ? findings : undefined
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
  const handleSelect = (destination: EditableSettingSource): void => {
    const update: PermissionUpdate = {
      type: 'addRules',
      rules: ruleValues,
      behavior: ruleBehavior,
      destination,
    }
    const nextContext = applyPermissionUpdate(initialContext, update)
    persistPermissionUpdate(update)
    setToolPermissionContext(nextContext)
    const created: PermissionRule[] = ruleValues.map(ruleValue => ({
      source: destination,
      ruleBehavior,
      ruleValue,
    }))
    onAddRules(created, newlyUnreachable(nextContext, ruleValues))
  }

  return (
    <Dialog
      title={`Add ${plural(ruleValues.length, 'rule')}`}
      color="permission"
      onCancel={onCancel}
    >
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          {ruleValues.map((ruleValue, index) => (
            <Box key={index} flexDirection="column">
              <Text bold>{permissionRuleValueToString(ruleValue)}</Text>
              <PermissionRuleDescription ruleValue={ruleValue} />
            </Box>
          ))}
        </Box>
        <Text>
          {ruleValues.length === 1
            ? 'Where should this rule be saved?'
            : 'Where should these rules be saved?'}
        </Text>
        <Select
          options={SOURCES.map(destinationOption)}
          onChange={handleSelect}
          onCancel={onCancel}
        />
      </Box>
    </Dialog>
  )
}
