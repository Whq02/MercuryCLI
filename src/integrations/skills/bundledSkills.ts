import { randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize, sep } from 'node:path'
import type { Command, PromptCommand } from '../../commands/catalogue/command.js'
import type { ToolUseContext } from '../../tools/kit/tool.js'
import type { ContentBlockParam } from '../../engine/message-shapes/wire.js'
import type { HooksSettings } from '../event-hook-schemas/hooks.js'
import type { EffortValue } from '../../models/effort/effort.js'
import { getBundledSkillsRoot } from '../../permissions/rules/filesystem.js'
import { exclusiveCreateNoFollowFlags } from '../../platform/host-os/files.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { baseDirLine } from './baseDirLine.js'
import { passedOverAs } from '../../platform/errors/passedOver.js'

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
  files?: Readonly<Record<string, string>> | (() => Readonly<Record<string, string>>)
  getPromptForCommand(args: string, context: ToolUseContext): Promise<ContentBlockParam[]>
}

const skillFolders = new Map<string, string>()

export function getBundledSkillExtractDir(skillName: string): string {
  return skillFolders.get(skillName) ?? join(getBundledSkillsRoot(), skillName)
}

type SkillFileTarget = {
  path: string
  content: string
}

function skillFileTargets(baseDir: string, files: Record<string, string>): SkillFileTarget[] {
  const targets: SkillFileTarget[] = []
  for (const [relativePath, content] of Object.entries(files)) {
    const normalized = normalize(relativePath)
    if (
      isAbsolute(relativePath) ||
      isAbsolute(normalized) ||
      normalized.split(sep).includes('..') ||
      normalized.split('/').includes('..')
    ) {
      throw new Error(`bundled skill file path escapes the skill directory: ${relativePath}`)
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

const standsAsFolder = (path: string): Promise<boolean> => lstat(path).then(info => info.isDirectory(), passedOverAs(false))
const standsAsFile = (path: string): Promise<boolean> => lstat(path).then(info => info.isFile(), passedOverAs(false))

let processFolderReal: string | undefined

async function processFolderStands(): Promise<boolean> {
  if (processFolderReal === undefined) return false
  const root = getBundledSkillsRoot()
  return (await standsAsFolder(root)) && (await realpath(root).catch(passedOverAs(undefined))) === processFolderReal
}

async function ownProcessFolder(): Promise<string> {
  const root = getBundledSkillsRoot()
  if (processFolderReal === undefined) {
    await mkdir(root, { recursive: true, mode: 0o700 })
    if (!(await standsAsFolder(root))) {
      throw new Error(`the bundled-skills folder ${root} is not a directory of its own`)
    }
    processFolderReal = await realpath(root)
    return processFolderReal
  }
  const missing: string[] = []
  let standing = processFolderReal
  while (!(await lstat(standing).then(() => true, passedOverAs(false)))) {
    missing.unshift(standing)
    const parent = dirname(standing)
    if (parent === standing) break
    standing = parent
  }
  if (!(await standsAsFolder(standing)) || (await realpath(standing)) !== standing) {
    throw new Error(`${standing} is no longer the directory the bundled-skills folder of this process was made under`)
  }
  for (const folder of missing) {
    await mkdir(folder, { mode: 0o700 })
  }
  if (!(await processFolderStands())) {
    throw new Error(`the bundled-skills folder ${root} is not the directory this process made`)
  }
  return processFolderReal
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
    if (folder === baseDir && (await realpath(baseDir)) !== join(processFolder, basename(baseDir))) {
      throw new Error(`the bundled skill folder ${baseDir} is not under the directory this process made`)
    }
  }
  await Promise.all(
    targets.map(async ({ path, content }) => {
      await writeFile(path, content, { flag: exclusiveCreateNoFollowFlags(), mode: 0o600 })
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
  const hasFiles =
    typeof definition.files === 'function' ||
    (definition.files !== undefined && Object.keys(definition.files).length > 0)
  const getPromptForCommand = hasFiles
    ? async (args: string, context: ToolUseContext): Promise<ContentBlockParam[]> => {
        const baseDir = await extractedSkillDir(definition)
        const blocks = await definition.getPromptForCommand(args, context)
        if (baseDir === null) return blocks
        const prefix = baseDirLine(baseDir)
        const first = blocks[0]
        if (first && first.type === 'text') {
          return [{ ...first, text: `${prefix}${first.text}` }, ...blocks.slice(1)]
        }
        return [{ type: 'text', text: prefix }, ...blocks]
      }
    : definition.getPromptForCommand

  const command: PromptCommand = {
    type: 'prompt',
    name: definition.name,
    description: typeof definition.description === 'string' ? definition.description : '',
    source: 'bundled',
    loadedFrom: 'bundled',
    progressMessage: 'running',
    contentLength: 0,
    hasUserSpecifiedDescription: true,
    allowedTools: definition.allowedTools ?? [],
    disableModelInvocation: definition.disableModelInvocation ?? false,
    userInvocable,
    isHidden: !userInvocable,
    ...(definition.menuDescription !== undefined ? { menuDescription: definition.menuDescription } : {}),
    ...(definition.aliases !== undefined ? { aliases: definition.aliases } : {}),
    ...(definition.whenToUse !== undefined ? { whenToUse: definition.whenToUse } : {}),
    ...(typeof definition.argumentHint === 'string' ? { argumentHint: definition.argumentHint } : {}),
    ...(definition.model !== undefined ? { model: definition.model } : {}),
    ...(definition.effort !== undefined ? { effort: definition.effort } : {}),
    ...(definition.isEnabled !== undefined ? { isEnabled: definition.isEnabled } : {}),
    ...(definition.hooks !== undefined ? { hooks: definition.hooks } : {}),
    ...(definition.context !== undefined ? { context: definition.context } : {}),
    ...(definition.agent !== undefined ? { agent: definition.agent } : {}),
    getPromptForCommand,
  }

  if (typeof definition.description === 'function') {
    const readDescription = definition.description
    Object.defineProperty(command, 'description', {
      get: readDescription,
      enumerable: true,
      configurable: true,
    })
  }
  if (typeof definition.argumentHint === 'function') {
    const readArgumentHint = definition.argumentHint
    Object.defineProperty(command, 'argumentHint', {
      get: readArgumentHint,
      enumerable: true,
      configurable: true,
    })
  }

  registry.push(command)
}

export function getBundledSkills(): Command[] {
  return [...registry]
}
