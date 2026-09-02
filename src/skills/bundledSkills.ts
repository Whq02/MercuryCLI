import { constants as fsConstants } from 'node:fs'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, sep } from 'node:path'
import type { Command, PromptCommand } from '../types/command.js'
import type { ToolUseContext } from '../Tool.js'
import type { ContentBlockParam } from '../types/wire.js'
import type { HooksSettings } from '../schemas/hooks.js'
import type { EffortValue } from '../utils/effort.js'
import { getBundledSkillsRoot } from '../utils/permissions/filesystem.js'
import { logForDebugging } from '../utils/debug.js'

export type BundledSkillDefinition = {
  name: string
  description: string | (() => string)
  menuDescription?: string
  aliases?: string[]
  whenToUse?: string
  argumentHint?: string | (() => string)
  allowedTools?: string[]
  model?: string
  effort?: EffortValue
  disableModelInvocation?: boolean
  userInvocable?: boolean
  isEnabled?: () => boolean
  hooks?: HooksSettings
  context?: 'inline' | 'fork'
  agent?: string
  files?: Record<string, string>
  getPromptForCommand: (
    args: string,
    context: ToolUseContext,
  ) => Promise<ContentBlockParam[]>
}

export function getBundledSkillExtractDir(skillName: string): string {
  return join(getBundledSkillsRoot(), skillName)
}

async function extractSkillFiles(skillName: string, files: Record<string, string>): Promise<string> {
  const baseDir = getBundledSkillExtractDir(skillName)
  const targets: Array<{ path: string; content: string }> = []
  for (const [key, content] of Object.entries(files)) {
    const normalized = normalize(key)
    if (
      isAbsolute(normalized) ||
      normalized.split(sep).includes('..') ||
      normalized.split('/').includes('..')
    ) {
      throw new Error(`bundled skill file path escapes the skill directory: ${key}`)
    }
    if (typeof content !== 'string') continue
    targets.push({ path: join(baseDir, normalized), content })
  }
  const dirs = new Set(targets.map(target => dirname(target.path)))
  for (const dir of dirs) {
    await mkdir(dir, { recursive: true, mode: 0o700 })
  }
  await Promise.all(
    targets.map(async ({ path, content }) => {
      if (process.platform === 'win32') {
        await writeFile(path, content, { flag: 'wx', mode: 0o600 })
      } else {
        const { O_CREAT, O_EXCL, O_WRONLY, O_NOFOLLOW } = fsConstants
        await writeFile(path, content, {
          flag: O_CREAT | O_EXCL | O_WRONLY | (O_NOFOLLOW ?? 0),
          mode: 0o600,
        })
      }
      if (content.startsWith('#!')) {
        await chmod(path, 0o700)
      }
    }),
  )
  return baseDir
}

const extractionPromises = new Map<string, Promise<string | null>>()

function extractOnce(definition: BundledSkillDefinition): Promise<string | null> {
  const existing = extractionPromises.get(definition.name)
  if (existing) return existing
  const promise = extractSkillFiles(definition.name, definition.files ?? {}).catch(error => {
    logForDebugging(
      `bundled skill ${definition.name}: reference-file extraction into ${getBundledSkillExtractDir(definition.name)} failed: ${String(error)}`,
    )
    return null
  })
  extractionPromises.set(definition.name, promise)
  return promise
}

function baseDirLine(baseDir: string): string {
  return `Base directory for this skill: ${baseDir} (read or grep files under it for the skill's own references)\n\n`
}

const registry: Command[] = []

export function registerBundledSkill(definition: BundledSkillDefinition): void {
  const userInvocable = definition.userInvocable !== false
  const hasFiles = definition.files !== undefined && Object.keys(definition.files).length > 0

  const getPromptForCommand: PromptCommand['getPromptForCommand'] = hasFiles
    ? async (args, context) => {
        const baseDir = await extractOnce(definition)
        const blocks = await definition.getPromptForCommand(args, context)
        if (baseDir === null) return blocks
        const [first, ...rest] = blocks
        if (first !== undefined && first.type === 'text') {
          return [{ ...first, text: `${baseDirLine(baseDir)}${first.text}` }, ...rest]
        }
        return [{ type: 'text', text: baseDirLine(baseDir) }, ...blocks]
      }
    : definition.getPromptForCommand

  const command: PromptCommand = {
    type: 'prompt',
    name: definition.name,
    description: '',
    progressMessage: 'running',
    contentLength: 0,
    source: 'bundled',
    loadedFrom: 'bundled',
    hasUserSpecifiedDescription: true,
    allowedTools: definition.allowedTools ?? [],
    disableModelInvocation: definition.disableModelInvocation ?? false,
    userInvocable,
    isHidden: !userInvocable,
    getPromptForCommand,
    ...(definition.menuDescription !== undefined ? { menuDescription: definition.menuDescription } : {}),
    ...(definition.aliases !== undefined ? { aliases: definition.aliases } : {}),
    ...(definition.whenToUse !== undefined ? { whenToUse: definition.whenToUse } : {}),
    ...(definition.model !== undefined ? { model: definition.model } : {}),
    ...(definition.effort !== undefined ? { effort: definition.effort } : {}),
    ...(definition.isEnabled !== undefined ? { isEnabled: definition.isEnabled } : {}),
    ...(definition.hooks !== undefined ? { hooks: definition.hooks } : {}),
    ...(definition.context !== undefined ? { context: definition.context } : {}),
    ...(definition.agent !== undefined ? { agent: definition.agent } : {}),
    ...(typeof definition.argumentHint === 'string' ? { argumentHint: definition.argumentHint } : {}),
  }
  if (typeof definition.description === 'function') {
    Object.defineProperty(command, 'description', { get: definition.description, enumerable: true })
  } else {
    command.description = definition.description
  }
  if (typeof definition.argumentHint === 'function') {
    Object.defineProperty(command, 'argumentHint', { get: definition.argumentHint, enumerable: true })
  }
  registry.push(command)
}

export function getBundledSkills(): Command[] {
  return [...registry]
}

export function clearBundledSkills(): void {
  registry.length = 0
}
