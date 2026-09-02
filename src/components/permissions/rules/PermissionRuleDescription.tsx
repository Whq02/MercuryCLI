import * as React from 'react'
import { Text } from '../../../ink.js'
import { BASH_TOOL_NAME } from '../../../tools/BashTool/toolName.js'
import type { PermissionRuleValue } from '../../../types/permissions.js'

/**
 * Plain-language gloss of a rule value. Returns nothing for a non-Bash rule
 * that has content.
 */
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
    if (ruleContent.endsWith(':*')) {
      return (
        <Text dimColor>
          any Bash command starting with <Text bold>{ruleContent.slice(0, -2)}</Text>
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
