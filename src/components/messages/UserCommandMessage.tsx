// Echo row for an invoked slash command or skill, extracted from the
// command-message / command-args transcript tags (contract data).

import figures from 'figures'
import React from 'react'
import { Box, Text } from '../../ink.js'
import type { TextBlockParam } from '../../types/wire.js'
import {
  COMMAND_ARGS_TAG,
  COMMAND_MESSAGE_TAG,
} from '../../constants/xml.js'
import { extractTag } from '../../utils/messages.js'

export function UserCommandMessage({
  addMargin,
  param,
}: {
  addMargin: boolean
  param: TextBlockParam
}): React.ReactNode {
  const commandName = extractTag(param.text, COMMAND_MESSAGE_TAG)
  if (!commandName) return null
  const args = extractTag(param.text, COMMAND_ARGS_TAG) ?? ''
  const isSkill = extractTag(param.text, 'skill-format') === 'true'

  return (
    <Box marginTop={addMargin ? 1 : 0}>
      <Text backgroundColor="userMessageBackground">
        <Text color="suggestion">{figures.pointer} </Text>
        {isSkill ? (
          <Text>
            Skill <Text bold>{commandName}</Text>
            {args ? <Text dimColor> {args}</Text> : null}
          </Text>
        ) : (
          <Text>
            /{commandName}
            {args ? ` ${args}` : ''}
          </Text>
        )}
      </Text>
    </Box>
  )
}

export default UserCommandMessage
