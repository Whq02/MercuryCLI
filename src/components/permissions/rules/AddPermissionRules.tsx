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
import { notBuilt } from '../../../pi/holes.js'

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

export function AddPermissionRules(arg0: {
  onAddRules: (rules: PermissionRule[], unreachable?: UnreachableRule[]) => void
  onCancel: () => void
  ruleValues: PermissionRuleValue[]
  ruleBehavior: PermissionBehavior
  initialContext: ToolPermissionContext
  setToolPermissionContext: (context: ToolPermissionContext) => void
}): React.ReactNode {
  return notBuilt('src/components/permissions/rules/AddPermissionRules.tsx:45')
}
