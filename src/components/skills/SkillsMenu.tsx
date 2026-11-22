import capitalize from 'lodash-es/capitalize.js'
import * as React from 'react'
import { displayConfigHome } from '../../utils/envUtils.js'
import { useMemo } from 'react'
import {
  type Command,
  type CommandBase,
  type CommandResultDisplay,
  getCommandName,
  type PromptCommand,
} from '../../commands.js'
import { Box, Text } from '../../ink.js'
import {
  estimateSkillFrontmatterTokens,
  getSkillsPath,
} from '../../skills/loadSkillsDir.js'
import { getDisplayPath } from '../../utils/file.js'
import { formatTokens } from '../../utils/format.js'
import {
  getSettingSourceName,
  type SettingSource,
} from '../../utils/settings/constants.js'
import { plural } from '../../utils/stringUtils.js'
import { FAINT, IVORY } from '../mercury-ui/theme.js'
import { CommandCenter, SectionHeader } from '../mercury-ui/components.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

type SkillCommand = Unbuilt

type SkillSource = Unbuilt

type Props = Unbuilt

const SOURCE_ORDER: SkillSource[] = [
  'projectSettings',
  'userSettings',
  'policySettings',
  'extension',
  'mcp',
]

function isSkillCommand(cmd: Command): cmd is SkillCommand {
  return (
    cmd.type === 'prompt' &&
    (cmd.loadedFrom === 'skills' ||
      cmd.loadedFrom === 'extension' ||
      cmd.loadedFrom === 'mcp')
  )
}

function MercurySkillsMenu(arg0: Props): React.ReactNode {
  return notBuilt('src/components/skills/SkillsMenu.tsx:122')
}

export function SkillsMenu({ onExit, commands }: Props): React.ReactNode {
  return <MercurySkillsMenu onExit={onExit} commands={commands} />
}
