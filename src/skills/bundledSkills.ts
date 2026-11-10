import { randomBytes } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { chmod, lstat, mkdir, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize, sep } from 'node:path'
import type { Command, PromptCommand } from '../types/command.js'
import type { ToolUseContext } from '../Tool.js'
import type { ContentBlockParam } from '../types/wire.js'
import type { HooksSettings } from '../schemas/hooks.js'
import type { EffortValue } from '../utils/effort.js'
import { getBundledSkillsRoot } from '../utils/permissions/filesystem.js'
import { logForDebugging } from '../utils/debug.js'
import { baseDirLine } from './baseDirLine.js'

type BundledSkillDefinition = {
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
  files?: Record<string, string> | (() => Readonly<Record<string, string>>)
  getPromptForCommand: (
    args: string,
    context: ToolUseContext,
  ) => Promise<ContentBlockParam[]>
}

const skillFolders = new Map<string, string>()

export function getBundledSkillExtractDir(skillName: string): string {
  return skillFolders.get(skillName) ?? join(getBundledSkillsRoot(), skillName)
}

type SkillFileTarget = { path: string; content: string }

function skillFileTargets(baseDir: string, files: Record<string, string>): SkillFileTarget[] {
  const targets: SkillFileTarget[] = []
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
  return targets
}

function foldersUnder(baseDir: string, targets: readonly SkillFileTarget[]): string[] {
  const folders = new Set<string>([baseDir])
  for (const target of targets) {
    for (let dir = dirname(target.path); dir.length > baseDir.length; dir = dirname(dir)) folders.add(dir)
  }
  return [...folders].sort((a, b) => a.length - b.length)
}

const standsAsFolder = (path: string): Promise<boolean> => lstat(path).then(info => info.isDirectory(), () => false)
const standsAsFile = (path: string): Promise<boolean> => lstat(path).then(info => info.isFile(), () => false)

let processFolderReal: string | undefined

async function processFolderStands(): Promise<boolean> {
  if (processFolderReal === undefined) return false
  const root = getBundledSkillsRoot()
  return (await standsAsFolder(root)) && (await realpath(root).catch(() => undefined)) === processFolderReal
}

async function ownProcessFolder(): Promise<string> {
  const root = getBundledSkillsRoot()
  await mkdir(root, { recursive: true, mode: 0o700 })
  const real = await realpath(root)
  if (!(await standsAsFolder(root)) || (processFolderReal !== undefined && real !== processFolderReal)) {
    throw new Error(`the bundled-skills folder ${root} is not the directory this process made`)
  }
  processFolderReal = real
  return real
}

async function skillFolderStandsWhole(baseDir: string, targets: readonly SkillFileTarget[]): Promise<boolean> {
  if (!(await processFolderStands())) return false
  for (const folder of foldersUnder(baseDir, targets)) {
    if (!(await standsAsFolder(folder))) return false
  }
  return (await Promise.all(targets.map(target => standsAsFile(target.path)))).every(Boolean)
}

async function extractSkillFiles(skillName: string, files: Record<string, string>, baseDir: string): Promise<string> {
  const processFolder = await ownProcessFolder()
  const targets = skillFileTargets(baseDir, files)
  for (const folder of foldersUnder(baseDir, targets)) {
    await mkdir(folder, { mode: 0o700 })
  }
  if ((await realpath(baseDir)) !== join(processFolder, basename(baseDir))) {
    throw new Error(`the bundled skill folder ${baseDir} is not under the directory this process made`)
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
  skillFolders.set(skillName, baseDir)
  return baseDir
}

const extractionPromises = new Map<string, Promise<string | null>>()

function extractedSkillDir(definition: BundledSkillDefinition): Promise<string | null> {
  const earlier = extractionPromises.get(definition.name)
  const promise = (earlier ?? Promise.resolve(undefined))
    .then(async standing => {
      const files = (typeof definition.files === 'function' ? definition.files() : definition.files) ?? {}
      if (typeof standing === 'string' && (await skillFolderStandsWhole(standing, skillFileTargets(standing, files)))) return standing
      const folderName = earlier === undefined ? definition.name : `${definition.name}-${randomBytes(8).toString('hex')}`
      return extractSkillFiles(definition.name, files, join(getBundledSkillsRoot(), folderName))
    })
    .catch(error => {
      logForDebugging(
        `bundled skill ${definition.name}: reference-file extraction under ${getBundledSkillsRoot()} failed: ${String(error)}`,
      )
      return null
    })
  extractionPromises.set(definition.name, promise)
  return promise
}


const registry: Command[] = []

export function registerBundledSkill(definition: BundledSkillDefinition): void {
  const userInvocable = definition.userInvocable !== false
  const hasFiles = typeof definition.files === 'function' || (definition.files !== undefined && Object.keys(definition.files).length > 0)

  const getPromptForCommand: PromptCommand['getPromptForCommand'] = hasFiles
    ? async (args, context) => {
        const baseDir = await extractedSkillDir(definition)
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
