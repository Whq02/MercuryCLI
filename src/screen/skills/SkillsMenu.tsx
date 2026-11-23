import capitalize from 'lodash-es/capitalize.js'
import * as React from 'react'
import { displayConfigHome } from '../../platform/environment/envUtils.js'
import { useMemo } from 'react'
import {
  type Command,
  type CommandBase,
  type CommandResultDisplay,
  getCommandName,
  type PromptCommand,
} from '../../commands/catalogue/commands.js'
import { Box, Text } from '../themedRenderer.js'
import {
  estimateSkillFrontmatterTokens,
  getSkillsPath,
} from '../../integrations/skills/loadSkillsDir.js'
import { getDisplayPath } from '../../platform/files/file.js'
import { formatTokens } from '../../platform/text/format.js'
import {
  getSettingSourceName,
  type SettingSource,
} from '../../platform/settings/settingSources.js'
import { plural } from '../../platform/text/strings.js'
import { FAINT, IVORY } from '../widgets/theme.js'
import { CommandCenter, SectionHeader } from '../widgets/components.js'

type SkillCommand = CommandBase &
  PromptCommand & {
    loadedFrom: 'skills' | 'extension' | 'mcp'
  }

type SkillSource = SettingSource | 'extension' | 'mcp'

type Props = {
  onExit: (result?: string, options?: { display?: CommandResultDisplay }) => void
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

function groupTitle(source: SkillSource): string {
  if (source === 'extension') return 'Extension skills'
  if (source === 'mcp') return 'MCP skills'
  return `${capitalize(getSettingSourceName(source))} skills`
}

function mcpServerName(skill: SkillCommand): string | undefined {
  const colon = skill.name.indexOf(':')
  return colon > 0 ? skill.name.slice(0, colon) : undefined
}

function groupSubtitle(source: SkillSource, skills: SkillCommand[]): string | undefined {
  if (source === 'mcp') {
    const servers = Array.from(
      new Set(skills.map(mcpServerName).filter((name): name is string => name !== undefined)),
    )
    return servers.length > 0 ? servers.join(', ') : undefined
  }
  return getDisplayPath(getSkillsPath(source, 'skills'))
}

function MercurySkillsMenu({ onExit, commands }: Props): React.ReactNode {
  const skills = useMemo(() => commands.filter(isSkillCommand), [commands])

  const groups = useMemo(() => {
    const bySource = new Map<SkillSource, SkillCommand[]>()
    for (const skill of skills) {
      const source = skill.source as SkillSource
      const list = bySource.get(source) ?? []
      list.push(skill)
      bySource.set(source, list)
    }
    const ordered: Array<{ source: SkillSource; items: SkillCommand[] }> = []
    for (const source of SOURCE_ORDER) {
      const items = bySource.get(source)
      if (!items || items.length === 0) continue
      items.sort((a, b) => getCommandName(a).localeCompare(getCommandName(b)))
      ordered.push({ source, items })
    }
    return ordered
  }, [skills])

  const subtitle =
    skills.length === 0
      ? 'no skills found'
      : `${skills.length} ${plural(skills.length, 'skill', 'skills')}`

  return (
    <CommandCenter
      view="skills"
      subtitle={subtitle}
      onClose={() => onExit('Skills dialog dismissed', { display: 'system' })}
    >
      {skills.length === 0 ? (
        <Box marginTop={1}>
          <Text color={FAINT}>
            Create skills in .mercury/skills/ or {displayConfigHome()}/skills/
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          {groups.map(({ source, items }) => {
            const sub = groupSubtitle(source, items)
            return (
              <Box key={source} flexDirection="column">
                <SectionHeader count={items.length}>{groupTitle(source)}</SectionHeader>
                {sub ? <Text color={FAINT}>{sub}</Text> : null}
                {items.map(skill => {
                  const extName = source === 'extension' ? skill.extensionInfo?.manifest.name : undefined
                  const tokens = formatTokens(estimateSkillFrontmatterTokens(skill))
                  return (
                    <Text key={skill.name}>
                      <Text color={IVORY}>{getCommandName(skill)}</Text>
                      <Text color={FAINT}>{`${extName ? ` · ${extName}` : ''} · ~${tokens} tokens`}</Text>
                    </Text>
                  )
                })}
              </Box>
            )
          })}
        </Box>
      )}
    </CommandCenter>
  )
}

export function SkillsMenu({ onExit, commands }: Props): React.ReactNode {
  return <MercurySkillsMenu onExit={onExit} commands={commands} />
}
