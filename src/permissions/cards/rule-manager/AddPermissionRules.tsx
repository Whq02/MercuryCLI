import * as React from 'react'
import { Box, Text } from '../../../screen/themedRenderer.js'
import type { ToolPermissionContext } from '../../../tools/kit/tool.js'
import type { PermissionBehavior, PermissionRule, PermissionRuleValue, PermissionUpdate } from '../../rules/permissions.js'
import { toTildePath } from '../../../platform/files/path.js'
import { permissionRuleValueToString } from '../../rules/permissionRuleParser.js'
import { applyPermissionUpdate, persistPermissionUpdate } from '../../rules/permissionUpdate.js'
import { detectUnreachableRules, type UnreachableRule } from '../../rules/shadowedRuleDetection.js'
import { SOURCES, type EditableSettingSource } from '../../../platform/settings/settingSources.js'
import { getRelativeSettingsFilePathForSource, getSettingsFilePathForSource } from '../../../platform/settings/settings.js'
import { plural } from '../../../platform/text/strings.js'
import { Select } from '../../../screen/select/Select.js'
import type { OptionWithDescription } from '../../../screen/select/Select.js'
import { Dialog } from '../../../screen/theme/Dialog.js'
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
      <Text>
        {ruleValues.length === 1 ? 'Where should this rule be saved?' : 'Where should these rules be saved?'}
      </Text>
      {ruleValues.map((ruleValue, index) => (
        <Box key={index} flexDirection="column">
          <Text bold>{permissionRuleValueToString(ruleValue)}</Text>
          <PermissionRuleDescription ruleValue={ruleValue} />
        </Box>
      ))}
      <Select
        options={SOURCES.map(destinationOption)}
        onChange={handleSelect}
        onCancel={onCancel}
      />
    </Dialog>
  )
}
