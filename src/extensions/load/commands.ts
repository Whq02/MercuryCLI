// ============================================================================
//  src/extensions/load/commands.ts — the two prompt-command catalogues an
//  extension contributes: its SKILLS (a folder holding SKILL.md each,
//  /<name>:<skill>) and its COMMANDS (<cmd>.md prompt files, /<name>:<cmd>).
//  Each entry carries source 'extension', loadedFrom 'extension' and the
//  owning extension's manifest + id. Read from the active set only.
// ============================================================================
import { getSessionId } from '../../bootstrap/state.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Command } from '../../types/command.js'
import { parseArgumentNames, substituteArguments } from '../../utils/argumentSubstitution.js'
import { logForDebugging } from '../../utils/debug.js'
import { EFFORT_LEVELS, parseEffortValue } from '../../utils/effort.js'
import {
  coerceDescriptionToString,
  parseBooleanFrontmatter,
  parseShellFrontmatter,
  type FrontmatterData,
} from '../../utils/frontmatterParser.js'
import { extractDescriptionFromMarkdown, parseSlashCommandToolsFromFrontmatter } from '../../utils/markdownConfigLoader.js'
import { parseUserSpecifiedModel } from '../../utils/model/model.js'
import { executeShellCommandsInPrompt } from '../../utils/promptShellExecution.js'
import { activeFor, type ActiveExtension } from '../active.js'
import { substituteOptionsInCommand, substituteOptionsInContent, substituteRootAndData } from '../options.js'

type BuildInput = {
  ext: ActiveExtension
  name: string
  file: string
  body: string
  frontmatter: FrontmatterData
  skill: boolean
  skillDir?: string
}

function buildCommand(input: BuildInput): Command {
  const { ext, name, file, body, frontmatter, skill, skillDir } = input
  const owner = ext.manifest.name
  const id = ext.entry.id
  const root = ext.root
  const declaredDescription = coerceDescriptionToString(frontmatter.description, name, owner)
  const description =
    declaredDescription ?? extractDescriptionFromMarkdown(body, skill ? `A skill from the ${owner} extension` : `A command from the ${owner} extension`)

  // Root/data and option substitution on allowed-tools BEFORE parsing, so a
  // rule like Bash(${MERCURY_EXTENSION_ROOT}/bin/*) names a real path.
  const substituteRule = (rule: string): string => substituteOptionsInCommand(substituteRootAndData(rule, root, id), ext.options)
  const rawAllowed = frontmatter['allowed-tools']
  const substitutedAllowed =
    typeof rawAllowed === 'string' ? substituteRule(rawAllowed) : Array.isArray(rawAllowed) ? rawAllowed.map(e => (typeof e === 'string' ? substituteRule(e) : e)) : rawAllowed
  const allowedTools = parseSlashCommandToolsFromFrontmatter(substitutedAllowed)
  const argNames = parseArgumentNames((frontmatter['arguments'] ?? undefined) as string | string[] | undefined)

  let model: string | undefined
  const rawModel = frontmatter.model
  if (typeof rawModel === 'string' && rawModel !== '' && rawModel !== 'inherit') model = parseUserSpecifiedModel(rawModel)

  let effort
  const rawEffort = frontmatter.effort
  if (rawEffort !== undefined && rawEffort !== null) {
    effort = parseEffortValue(rawEffort)
    if (effort === undefined) logForDebugging(`extension command ${name}: effort must be one of ${EFFORT_LEVELS.join(', ')} or an integer — dropped`)
  }

  const userInvocable = frontmatter['user-invocable'] === undefined || frontmatter['user-invocable'] === null ? true : parseBooleanFrontmatter(frontmatter['user-invocable'])
  const shell = parseShellFrontmatter(frontmatter['shell'], file)
  const displayName = coerceDescriptionToString(frontmatter['name'])
  const whenToUse = coerceDescriptionToString(frontmatter.when_to_use)
  const version = coerceDescriptionToString(frontmatter.version)
  const disableModelInvocation = parseBooleanFrontmatter(frontmatter['disable-model-invocation'])
  const optionSchema = ext.manifest.needs?.options

  const command = {
    type: 'prompt' as const,
    name,
    description,
    hasUserSpecifiedDescription: declaredDescription !== null,
    progressMessage: skill ? 'loading' : 'running',
    ...(displayName ? { userFacingName: () => displayName } : {}),
    ...(whenToUse ? { whenToUse } : {}),
    ...(version ? { version } : {}),
    argNames,
    ...(frontmatter['argument-hint'] ? { argumentHint: String(frontmatter['argument-hint']) } : {}),
    allowedTools,
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(shell !== undefined ? { shell } : {}),
    userInvocable,
    isHidden: !userInvocable,
    disableModelInvocation,
    contentLength: body.length,
    source: 'extension' as const,
    loadedFrom: 'extension' as const,
    extensionInfo: { manifest: ext.manifest, id },
    ...(skill && skillDir ? { skillRoot: skillDir } : {}),
    async getPromptForCommand(args: string, context?: unknown): Promise<Array<{ type: 'text'; text: string }>> {
      let text = body
      if (skill && skillDir) text = `Base directory for this skill: ${skillDir}\n\n${text}`
      text = substituteArguments(text, args, true, argNames)
      text = substituteRootAndData(text, root, id)
      // Prose enters the model's context: a sensitive option renders its placeholder.
      text = substituteOptionsInContent(text, ext.options, optionSchema)
      if (skill && skillDir) {
        // Mercury's own template spelling substitutes; any other product's
        // template spelling stays literal in the body.
        const dir = skillDir.replace(/\\/g, '/')
        text = text.replaceAll('${MERCURY_SKILL_DIR}', dir)
      }
      text = text.replaceAll('${MERCURY_SESSION_ID}', getSessionId())
      // In-prompt shell execution runs LAST, with this command's own
      // allowed-tools injected as the always-allow COMMAND rules on a copy
      // of the app state — a command's declared allowed-tools authorises
      // its own embedded snippets and nothing else; the model's later
      // calls follow the session's permission mode.
      const toolContext = context as ToolUseContext | undefined
      if (toolContext) {
        const executorContext: ToolUseContext = {
          ...toolContext,
          getAppState: () => {
            const state = toolContext.getAppState()
            return {
              ...state,
              toolPermissionContext: {
                ...state.toolPermissionContext,
                alwaysAllowRules: { ...state.toolPermissionContext.alwaysAllowRules, command: allowedTools },
              },
            }
          },
        }
        text = await executeShellCommandsInPrompt(text, executorContext, `/${name}`, shell)
      }
      return [{ type: 'text' as const, text }]
    },
  } satisfies Command
  return command
}

let skillsMemo: Command[] | null = null
let commandsMemo: Command[] | null = null

/** The SKILLS catalogue: every active extension's resolved skills (commands ride with skills on the switch). */
export function getExtensionSkills(): Command[] {
  if (skillsMemo) return skillsMemo
  const out: Command[] = []
  for (const ext of activeFor('skills')) {
    for (const skill of ext.resolution.skills) {
      try {
        out.push(buildCommand({ ext, name: skill.name, file: skill.file, body: skill.body, frontmatter: skill.frontmatter, skill: true, skillDir: skill.dir }))
      } catch (error) {
        logForDebugging(`extension skill ${skill.name} failed to build: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  skillsMemo = out
  return out
}

/** The COMMANDS catalogue. */
export function getExtensionCommands(): Command[] {
  if (commandsMemo) return commandsMemo
  const out: Command[] = []
  for (const ext of activeFor('skills')) {
    for (const cmd of ext.resolution.commands) {
      try {
        out.push(buildCommand({ ext, name: cmd.name, file: cmd.file, body: cmd.body, frontmatter: cmd.frontmatter, skill: false }))
      } catch (error) {
        logForDebugging(`extension command ${cmd.name} failed to build: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  commandsMemo = out
  return out
}

/** The reload's cache clear (the command catalogue's clear calls this). */
export function clearExtensionCommandCaches(): void {
  skillsMemo = null
  commandsMemo = null
}
