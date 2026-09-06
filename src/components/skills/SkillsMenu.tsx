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
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js'
import { Dialog } from '../design-system/Dialog.js'
import { FAINT, IVORY } from '../mercury-ui/theme.js'
import { CommandCenter, SectionHeader } from '../mercury-ui/components.js'

type SkillCommand = CommandBase & PromptCommand

type SkillSource = SettingSource | 'extension' | 'mcp'

type Props = {
  onExit: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
  commands: Command[]
}

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

function getSourceTitle(source: SkillSource): string {
  if (source === 'extension') {
    return 'Extension skills'
  }
  if (source === 'mcp') {
    return 'MCP skills'
  }
  return `${capitalize(getSettingSourceName(source))} skills`
}

function getSourceSubtitle(
  source: SkillSource,
  skills: SkillCommand[],
): string | undefined {
  if (source === 'mcp') {
    const servers = [
      ...new Set(
        skills
          .map(s => {
            const idx = s.name.indexOf(':')
            return idx > 0 ? s.name.slice(0, idx) : null
          })
          .filter((n): n is string => n != null),
      ),
    ]
    return servers.length > 0 ? servers.join(', ') : undefined
  }
  return getDisplayPath(getSkillsPath(source, 'skills'))
}

function useSkillGroups(commands: Command[]): {
  skills: SkillCommand[]
  skillsBySource: Record<SkillSource, SkillCommand[]>
} {
  const skills = useMemo(() => commands.filter(isSkillCommand), [commands])

  const skillsBySource = useMemo((): Record<SkillSource, SkillCommand[]> => {
    const groups: Record<SkillSource, SkillCommand[]> = {
      policySettings: [],
      userSettings: [],
      projectSettings: [],
      localSettings: [],
      flagSettings: [],
      extension: [],
      mcp: [],
    }

    for (const skill of skills) {
      const source = skill.source as SkillSource
      if (source in groups) {
        groups[source].push(skill)
      }
    }

    for (const group of Object.values(groups)) {
      group.sort((a, b) =>
        getCommandName(a).localeCompare(getCommandName(b)),
      )
    }

    return groups
  }, [skills])

  return { skills, skillsBySource }
}

function MercurySkillsMenu({ onExit, commands }: Props): React.ReactNode {
  const { skills, skillsBySource } = useSkillGroups(commands)

  const handleClose = (): void => {
    onExit('Skills dialog dismissed', { display: 'system' })
  }

  const subtitle =
    skills.length === 0
      ? 'no skills found'
      : `${skills.length} ${plural(skills.length, 'skill')}`

  if (skills.length === 0) {
    return (
      <CommandCenter view="skills" subtitle={subtitle} onClose={handleClose}>
        <Box marginTop={1}>
          <Text color={FAINT}>
            Create skills in .mercury/skills/ or {displayConfigHome()}/skills/
          </Text>
        </Box>
      </CommandCenter>
    )
  }

  return (
    <CommandCenter view="skills" subtitle={subtitle} onClose={handleClose}>
      {SOURCE_ORDER.map(source => {
        const groupSkills = skillsBySource[source]
        if (groupSkills.length === 0) {
          return null
        }
        const groupSubtitle = getSourceSubtitle(source, groupSkills)
        return (
          <Box flexDirection="column" key={source}>
            <SectionHeader count={groupSkills.length}>
              {getSourceTitle(source)}
            </SectionHeader>
            {groupSubtitle ? (
              <Text color={FAINT}>{groupSubtitle}</Text>
            ) : null}
            {groupSkills.map(skill => {
              const estimatedTokens = estimateSkillFrontmatterTokens(skill)
              const tokenDisplay = `~${formatTokens(estimatedTokens)}`
              const extensionName =
                skill.source === 'extension'
                  ? skill.extensionInfo?.manifest.name
                  : undefined
              return (
                <Text key={`${skill.name}-${skill.source}`}>
                  <Text color={IVORY}>{getCommandName(skill)}</Text>
                  <Text color={FAINT}>
                    {extensionName ? ` · ${extensionName}` : ''} · {tokenDisplay}{' '}
                    tokens
                  </Text>
                </Text>
              )
            })}
          </Box>
        )
      })}
    </CommandCenter>
  )
}

export function SkillsMenu({ onExit, commands }: Props): React.ReactNode {
  return <MercurySkillsMenu onExit={onExit} commands={commands} />
}
