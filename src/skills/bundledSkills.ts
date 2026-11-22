import { randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize, sep } from 'node:path'
import type { Command, PromptCommand } from '../types/command.js'
import type { ToolUseContext } from '../Tool.js'
import type { ContentBlockParam } from '../types/wire.js'
import type { HooksSettings } from '../schemas/hooks.js'
import type { EffortValue } from '../utils/effort.js'
import { getBundledSkillsRoot } from '../utils/permissions/filesystem.js'
import { exclusiveCreateNoFollowFlags } from '../utils/platform/files.js'
import { logForDebugging } from '../utils/debug.js'
import { baseDirLine } from './baseDirLine.js'
import { passedOverAs } from '../utils/passedOver.js'
import { notBuilt, unbuilt, type Unbuilt } from '../pi/holes.js'

type BundledSkillDefinition = Unbuilt

const skillFolders: Map<string, string> = unbuilt('src/skills/bundledSkills.ts:38')

export function getBundledSkillExtractDir(skillName: string): string {
  return notBuilt('src/skills/bundledSkills.ts:40')
}

type SkillFileTarget = Unbuilt

function skillFileTargets(baseDir: string, files: Record<string, string>): SkillFileTarget[] {
  return notBuilt('src/skills/bundledSkills.ts:46')
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
  return notBuilt('src/skills/bundledSkills.ts:165')
}

export function getBundledSkills(): Command[] {
  return notBuilt('src/skills/bundledSkills.ts:218')
}
