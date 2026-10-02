import * as React from 'react'
import { Text } from '../../../ink.js'
import { BASH_TOOL_NAME } from '../../../tools/BashTool/toolName.js'
import type { PermissionRuleValue } from '../../../types/permissions.js'
import { hasWildcards, permissionRuleExtractPrefix } from '../../../utils/permissions/shellRuleMatching.js'

export function PermissionRuleDescription({
  ruleValue,
}: {
  ruleValue: PermissionRuleValue
}): React.ReactNode {
  const { toolName, ruleContent } = ruleValue
  if (toolName === BASH_TOOL_NAME) {
    if (ruleContent === undefined || ruleContent === '') {
      return <Text dimColor>any Bash command</Text>
    }
    const prefix = permissionRuleExtractPrefix(ruleContent)
    if (prefix !== null) {
      return (
        <Text dimColor>
          any Bash command starting with <Text bold>{prefix}</Text>
        </Text>
      )
    }
    if (hasWildcards(ruleContent)) {
      return (
        <Text dimColor>
          any Bash command matching <Text bold>{ruleContent}</Text>
        </Text>
      )
    }
    return (
      <Text dimColor>
        the Bash command <Text bold>{ruleContent}</Text>
      </Text>
    )
  }
  if (ruleContent === undefined || ruleContent === '') {
    return (
      <Text dimColor>
        any use of the <Text bold>{toolName}</Text> tool
      </Text>
    )
  }
  return null
}
