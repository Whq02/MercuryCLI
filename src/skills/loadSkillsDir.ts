import { existsSync, promises as fsPromises } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { memoize } from 'lodash-es'
import ignore from 'ignore'
import type { Command, PromptCommand } from '../types/command.js'
import type { ToolUseContext } from '../Tool.js'
import type { HooksSettings } from '../schemas/hooks.js'
import { HooksSchema } from '../schemas/hooks.js'
import type { EffortValue } from '../utils/effort.js'
import { parseEffortValue, EFFORT_LEVELS } from '../utils/effort.js'
import {
  parseFrontmatter,
  parseBooleanFrontmatter,
  parseShellFrontmatter,
  splitPathInFrontmatter,
  coerceDescriptionToString,
  type FrontmatterShell,
} from '../utils/frontmatterParser.js'
import {
  extractDescriptionFromMarkdown,
  getProjectDirsUpToHome,
  loadMarkdownFilesForSubdir,
  clearMarkdownFileCache,
  parseSlashCommandToolsFromFrontmatter,
} from '../utils/markdownConfigLoader.js'
import { parseArgumentNames, substituteArguments } from '../utils/argumentSubstitution.js'
import { executeShellCommandsInPrompt } from '../utils/promptShellExecution.js'
import {
  PROJECT_CONFIG_DIR_NAMES,
  projectConfigCandidatePaths,
} from '../utils/projectConfig.js'
import { getMercuryHome, isBareMode, isEnvDefinedFalsy, isEnvTruthy } from '../utils/envUtils.js'
import { getManagedFilePath } from '../utils/settings/managedPath.js'
import {
  getEnabledSettingSources,
  isSettingSourceEnabled,
  type SettingSource,
} from '../utils/settings/constants.js'
import { isRestrictedToExtensionsOnly } from '../utils/settings/extensionOnlyPolicy.js'
import { isPathGitignored } from '../utils/git/gitignore.js'
import { getSessionId, getAddedDirectories } from '../bootstrap/state.js'
import { createSignal } from '../utils/signal.js'
import { flagEnv } from '../substrate/flagRegistry.js'
import { errorMessage, isENOENT, isFsInaccessible } from '../utils/errors.js'
import { logForDebugging } from '../utils/debug.js'
import { logError } from '../utils/log.js'
import { parseUserSpecifiedModel } from '../utils/model/model.js'
import { roughTokenCountEstimation } from '../services/tokenEstimation.js'

export type LoadedFrom =
  | 'skills'
  | 'extension'
  | 'managed'
  | 'bundled'
  | 'mcp'

const SKILL_FILE_NAME = 'SKILL.md'
const SKILL_FALLBACK_LABEL = 'skill'


export type SkillLoadRefusal = { path: string; error: string; source: string }

const skillLoadRefusals = new Map<string, SkillLoadRefusal>()

function recordSkillRefusal(path: string, error: string, source: string): void {
  skillLoadRefusals.set(path, { path, error, source })
}

export function slashNameProblem(name: string): string | null {
  if (name === '' || name.endsWith(':') || name.startsWith(':')) {
    return 'derives an empty command name — no name to invoke'
  }
  if (/\s/.test(name)) {
    return `contains whitespace ('/${name}' can never be one command token)`
  }
  return null
}

export function getSkillLoadRefusals(): SkillLoadRefusal[] {
  return [...skillLoadRefusals.values()]
}

export const EMPTY_SKILL_FILE_REASON = 'the file is empty — no frontmatter, no body'

const BOOLEAN_OPT_OUT_KEYS = ['disable-model-invocation', 'user-invocable'] as const

export function skillFrontmatterProblem(frontmatter: Record<string, unknown>): string | null {
  for (const key of BOOLEAN_OPT_OUT_KEYS) {
    const value = frontmatter[key]
    if (value === undefined || value === null) continue
    if (value === true || value === false || value === 'true' || value === 'false') continue
    return `frontmatter key ${key}: "${String(value)}" is not true or false`
  }
  return null
}


export function getProjectSkillsWatchPaths(
  dir: 'skills',
  cwd: string = process.cwd(),
): string[] {
  return projectConfigCandidatePaths(cwd, dir)
}

export function getSkillsPath(source: SettingSource | 'extension', dir: string): string {
  switch (source) {
    case 'userSettings':
      return join(getMercuryHome(), dir)
    case 'policySettings':
      return join(getManagedFilePath(), '.mercury', dir)
    case 'projectSettings':
    case 'localSettings':
      return join(process.cwd(), '.mercury', dir)
    case 'extension':
      return 'extension'
    default:
      return ''
  }
}


export type ParsedSkillFrontmatterFields = {
  description: string
  hasUserSpecifiedDescription: boolean
  displayName?: string
  allowedTools: string[]
  argumentHint?: string
  argNames?: string[]
  whenToUse?: string
  version?: string
  model?: string
  disableModelInvocation: boolean
  userInvocable: boolean
  hooks?: HooksSettings
  context?: 'fork'
  agent?: string
  effort?: EffortValue
  shell?: FrontmatterShell
}

export function parseSkillFrontmatterFields(
  frontmatter: Record<string, unknown>,
  markdownContent: string,
  resolvedName: string,
  fallbackLabel: 'skill' | 'custom command' = SKILL_FALLBACK_LABEL,
): ParsedSkillFrontmatterFields {
  const userDescription = coerceDescriptionToString(frontmatter['description'])
  const description =
    userDescription ?? extractDescriptionFromMarkdown(markdownContent, fallbackLabel)

  const displayName =
    frontmatter['name'] !== undefined ? String(frontmatter['name']) : undefined

  let hooks: HooksSettings | undefined
  if (frontmatter['hooks'] !== undefined) {
    const validated = HooksSchema().safeParse(frontmatter['hooks'])
    if (validated.success) {
      hooks = validated.data as HooksSettings
    } else {
      logForDebugging(
        `skill ${resolvedName}: invalid hooks frontmatter ignored (${validated.error.message})`,
      )
    }
  }

  let model: string | undefined
  const rawModel = frontmatter['model']
  if (rawModel !== undefined && rawModel !== null) {
    model = String(rawModel) === 'inherit' ? undefined : parseUserSpecifiedModel(String(rawModel))
  }

  let effort: EffortValue | undefined
  const rawEffort = frontmatter['effort']
  if (rawEffort !== undefined && rawEffort !== null) {
    effort = parseEffortValue(rawEffort)
    if (effort === undefined) {
      logForDebugging(
        `skill ${resolvedName}: unrecognised effort "${String(rawEffort)}" — valid values: ${EFFORT_LEVELS.join(', ')}, or an integer`,
      )
    }
  }

  return {
    description,
    hasUserSpecifiedDescription: userDescription !== null,
    displayName,
    allowedTools: parseSlashCommandToolsFromFrontmatter(frontmatter['allowed-tools']),
    argumentHint:
      frontmatter['argument-hint'] !== undefined
        ? String(frontmatter['argument-hint'])
        : undefined,
    argNames: parseArgumentNames(
      frontmatter['arguments'] as string | string[] | undefined,
    ),
    whenToUse:
      frontmatter['when-to-use'] !== undefined
        ? String(frontmatter['when-to-use'])
        : undefined,
    version:
      frontmatter['version'] !== undefined ? String(frontmatter['version']) : undefined,
    model,
    disableModelInvocation: parseBooleanFrontmatter(frontmatter['disable-model-invocation']),
    userInvocable:
      frontmatter['user-invocable'] === undefined
        ? true
        : parseBooleanFrontmatter(frontmatter['user-invocable']),
    hooks,
    context: frontmatter['context'] === 'fork' ? 'fork' : undefined,
    agent: frontmatter['agent'] !== undefined ? String(frontmatter['agent']) : undefined,
    effort,
    shell: parseShellFrontmatter(frontmatter['shell'], resolvedName),
  }
}

function parseSkillPathFilters(frontmatter: Record<string, unknown>): string[] | undefined {
  const raw = frontmatter['paths']
  if (raw === undefined || raw === null) return undefined
  const patterns = splitPathInFrontmatter(raw as string | string[])
    .map(pattern => (pattern.endsWith('/**') ? pattern.slice(0, -'/**'.length) : pattern))
    .filter(pattern => pattern !== '')
  if (patterns.length === 0) return undefined
  if (patterns.every(pattern => pattern === '**')) return undefined
  return patterns
}


const SKILL_DIR_TOKEN = /\$\{MERCURY_SKILL_DIR\}/g
const SESSION_ID_TOKEN = /\$\{MERCURY_SESSION_ID\}/g

export function isSkillSelfAuthEnabled(): boolean {
  return !isEnvDefinedFalsy(flagEnv('MERCURY_SKILL_SELF_AUTH'))
}

export function createSkillCommand(options: {
  name: string
  markdownContent: string
  source: SettingSource | 'extension' | 'builtin' | 'mcp' | 'bundled'
  baseDir?: string
  loadedFrom: LoadedFrom
  fields: ParsedSkillFrontmatterFields
  pathFilters?: string[]
}): Command {
  const { name, markdownContent, source, baseDir, loadedFrom, fields, pathFilters } = options

  const getPromptForCommand: PromptCommand['getPromptForCommand'] = async (
    args,
    context,
  ) => {
    let content = markdownContent
    if (baseDir !== undefined) {
      content = `Base directory for this skill: ${baseDir} (read or grep files under it for the skill's own references)\n\n${content}`
    }
    content = substituteArguments(content, args, true, fields.argNames)
    if (baseDir !== undefined) {
      const dirForShell = process.platform === 'win32' ? baseDir.replaceAll('\\', '/') : baseDir
      content = content.replace(SKILL_DIR_TOKEN, dirForShell)
    }
    const sessionId = getSessionId()
    content = content.replace(SESSION_ID_TOKEN, String(sessionId))
    if (loadedFrom !== 'mcp') {
      const wrappedContext = wrapContextForSkillSelfAuth(context, fields.allowedTools)
      content = await executeShellCommandsInPrompt(
        content,
        wrappedContext,
        `/${name}`,
        fields.shell,
      )
    }
    return [{ type: 'text', text: content }]
  }

  const command: PromptCommand = {
    type: 'prompt',
    name,
    getPromptForCommand,
    description: fields.description,
    hasUserSpecifiedDescription: fields.hasUserSpecifiedDescription,
    allowedTools: fields.allowedTools,
    ...(fields.argumentHint !== undefined ? { argumentHint: fields.argumentHint } : {}),
    ...(fields.argNames && fields.argNames.length > 0 ? { argNames: fields.argNames } : {}),
    ...(fields.whenToUse !== undefined ? { whenToUse: fields.whenToUse } : {}),
    ...(fields.version !== undefined ? { version: fields.version } : {}),
    ...(fields.model !== undefined ? { model: fields.model } : {}),
    disableModelInvocation: fields.disableModelInvocation,
    userInvocable: fields.userInvocable,
    ...(fields.context !== undefined ? { context: fields.context } : {}),
    ...(fields.agent !== undefined ? { agent: fields.agent } : {}),
    ...(fields.effort !== undefined ? { effort: fields.effort } : {}),
    ...(pathFilters !== undefined ? { pathFilters } : {}),
    contentLength: markdownContent.length,
    isHidden: !fields.userInvocable,
    progressMessage: 'running',
    userFacingName: () => fields.displayName ?? name,
    source,
    loadedFrom,
    ...(fields.hooks !== undefined ? { hooks: fields.hooks } : {}),
    ...(baseDir !== undefined ? { skillRoot: baseDir } : {}),
  }
  return command
}

function wrapContextForSkillSelfAuth(
  context: ToolUseContext,
  allowedTools: string[],
): ToolUseContext {
  return {
    ...context,
    getAppState: () => {
      const state = context.getAppState()
      const grant = isSkillSelfAuthEnabled() ? { command: allowedTools } : {}
      return {
        ...state,
        toolPermissionContext: {
          ...state.toolPermissionContext,
          alwaysAllowRules: {
            ...state.toolPermissionContext.alwaysAllowRules,
            ...grant,
          },
        },
      }
    },
  }
}

export function estimateSkillFrontmatterTokens(skill: Command): number {
  return roughTokenCountEstimation(
    [skill.name, skill.description, skill.whenToUse ?? ''].join(' '),
  )
}


type LoadedSkill = { command: Command; filePath: string; source: string }

async function loadSkillsFromDir(
  dir: string,
  source: SettingSource | 'extension',
  sourceLabel: string,
): Promise<LoadedSkill[]> {
  let entries: Array<{ name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean }>
  try {
    entries = await fsPromises.readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (!isENOENT(error) && !isFsInaccessible(error as Error)) {
      logForDebugging(`skills: could not read directory ${dir}: ${errorMessage(error)}`)
    }
    return []
  }
  const results = await Promise.all(
    entries.map(async (entry): Promise<LoadedSkill | null> => {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) return null
      const skillDir = join(dir, entry.name)
      const skillFile = join(skillDir, SKILL_FILE_NAME)
      let markdown: string
      try {
        markdown = await fsPromises.readFile(skillFile, 'utf8')
      } catch (error) {
        if (!isENOENT(error)) {
          logForDebugging(
            `skills: could not read ${skillFile}: ${errorMessage(error)}`,
            { level: 'warn' },
          )
        }
        return null
      }
      try {
        if (markdown.trim() === '') {
          recordSkillRefusal(skillFile, EMPTY_SKILL_FILE_REASON, sourceLabel)
          return null
        }
        const parsed = parseFrontmatter(markdown, skillFile)
        if (parsed.parseError) {
          recordSkillRefusal(skillFile, `frontmatter did not parse: ${parsed.parseError.message}`, sourceLabel)
          return null
        }
        const fieldProblem = skillFrontmatterProblem(parsed.frontmatter)
        if (fieldProblem !== null) {
          recordSkillRefusal(skillFile, fieldProblem, sourceLabel)
          return null
        }
        const nameProblem = slashNameProblem(entry.name)
        if (nameProblem !== null) {
          recordSkillRefusal(skillFile, `uninvocable name: ${nameProblem}`, sourceLabel)
          return null
        }
        const fields = parseSkillFrontmatterFields(
          parsed.frontmatter,
          parsed.content,
          entry.name,
          SKILL_FALLBACK_LABEL,
        )
        const pathFilters = parseSkillPathFilters(parsed.frontmatter)
        const command = createSkillCommand({
          name: entry.name,
          markdownContent: parsed.content,
          source,
          baseDir: skillDir,
          loadedFrom: 'skills',
          fields,
          pathFilters,
        })
        return { command, filePath: skillFile, source: sourceLabel }
      } catch (error) {
        logForDebugging(`skills: failed to load ${skillFile}: ${errorMessage(error)}`)
        return null
      }
    }),
  )
  return results.filter((r): r is LoadedSkill => r !== null)
}


type MarkdownFileEntry = {
  filePath: string
  baseDir: string
  frontmatter: Record<string, unknown>
  content: string
  source: 'policySettings' | 'userSettings' | 'projectSettings'
  parseError?: { message: string }
}


const pendingConditional = new Map<string, Command>()
const activatedSkillNames = new Set<string>()

async function loadAllSkillsUncached(cwd: string): Promise<Command[]> {
  const userDir = getSkillsPath('userSettings', 'skills')
  const managedDir = getSkillsPath('policySettings', 'skills')
  const projectDirs = getProjectDirsUpToHome('skills', cwd)
  const additionalDirs: string[] = []
  for (const added of getAddedDirectories()) {
    for (const home of PROJECT_CONFIG_DIR_NAMES) {
      additionalDirs.push(join(added, home, 'skills'))
    }
  }
  logForDebugging(
    `skills: managed=${managedDir} user=${userDir} project=[${projectDirs.join(', ')}]`,
  )

  const extensionsOnly = isRestrictedToExtensionsOnly('skills')
  const projectEnabled = isSettingSourceEnabled('projectSettings') && !extensionsOnly

  if (isBareMode()) {
    if (additionalDirs.length === 0 || !projectEnabled) {
      logForDebugging(
        additionalDirs.length === 0
          ? 'skills: bare mode with no added directories — none loaded'
          : 'skills: bare mode and project settings disabled or skill-locked — none loaded',
      )
      return []
    }
    const groups = await Promise.all(
      additionalDirs.map(dir => loadSkillsFromDir(dir, 'projectSettings', 'additional')),
    )
    return splitConditional(groups.flat().map(s => s.command))
  }

  const managedPromise = loadSkillsFromDir(managedDir, 'policySettings', 'managed')
  const userPromise =
    isSettingSourceEnabled('userSettings') && !extensionsOnly
      ? loadSkillsFromDir(userDir, 'userSettings', 'user')
      : Promise.resolve([] as LoadedSkill[])
  const projectPromise = projectEnabled
    ? Promise.all(
        projectDirs.map(dir => loadSkillsFromDir(dir, 'projectSettings', 'project')),
      ).then(groups => groups.flat())
    : Promise.resolve([] as LoadedSkill[])
  const additionalPromise = projectEnabled
    ? Promise.all(
        additionalDirs.map(dir => loadSkillsFromDir(dir, 'projectSettings', 'additional')),
      ).then(groups => groups.flat())
    : Promise.resolve([] as LoadedSkill[])
  const [managed, user, project, additional] = await Promise.all([
    managedPromise,
    userPromise,
    projectPromise,
    additionalPromise,
  ])
  const ordered = [...managed, ...user, ...project, ...additional]

  const identities = await Promise.all(
    ordered.map(async skill => {
      try {
        return await fsPromises.realpath(skill.filePath)
      } catch {
        return null
      }
    }),
  )
  const seen = new Map<string, LoadedSkill>()
  const unique: LoadedSkill[] = []
  let duplicates = 0
  ordered.forEach((skill, index) => {
    const identity = identities[index]
    if (identity === null || identity === undefined) {
      unique.push(skill)
      return
    }
    const winner = seen.get(identity)
    if (winner) {
      duplicates++
      logForDebugging(
        `skills: duplicate ${skill.command.name} from ${skill.source} skipped — already loaded from ${winner.source}`,
      )
      return
    }
    seen.set(identity, skill)
    unique.push(skill)
  })
  if (duplicates > 0) logForDebugging(`skills: removed ${duplicates} duplicate(s)`)

  const commands = unique.map(s => s.command)
  const perSource = new Map<string, number>()
  for (const skill of unique) {
    perSource.set(skill.source, (perSource.get(skill.source) ?? 0) + 1)
  }
  const result = splitConditional(commands)
  logForDebugging(
    `skills: ${commands.length} unique — ${result.length} unconditional, ${commands.length - result.length} conditional (${[...perSource].map(([k, v]) => `${k}=${v}`).join(' ')})`,
  )
  return result
}

function splitConditional(commands: Command[]): Command[] {
  const unconditional: Command[] = []
  let withheld = 0
  for (const command of commands) {
    const filters = (command as { pathFilters?: string[] }).pathFilters
    if (filters && filters.length > 0 && !activatedSkillNames.has(command.name)) {
      pendingConditional.set(command.name, command)
      withheld++
      continue
    }
    unconditional.push(command)
  }
  if (withheld > 0) logForDebugging(`skills: withheld ${withheld} conditional skill(s)`)
  return unconditional
}

const loadAllSkillsMemo = memoize(loadAllSkillsUncached)

export function getSkillDirCommands(cwd: string): Promise<Command[]> {
  return loadAllSkillsMemo(cwd)
}

export function clearSkillCaches(): void {
  loadAllSkillsMemo.cache.clear?.()
  clearMarkdownFileCache()
  pendingConditional.clear()
  activatedSkillNames.clear()
  skillLoadRefusals.clear()
  pruneDynamicSkillsSync()
}

export const getCommandDirCommands = getSkillDirCommands
export const clearCommandCaches = clearSkillCaches


type DynamicSkillEntry = { name: string; filePath: string; mtimeMs: number; command: Command }
type DynamicDirRecord =
  | { state: 'missing'; examinedAt: number }
  | { state: 'loaded'; examinedAt: number; entries: DynamicSkillEntry[]; seen: Array<{ name: string; mtimeMs: number }> }

const dynamicSkills = new Map<string, Command>()
const examinedCandidates = new Map<string, DynamicDirRecord>()
const skillsLoadedSignal = createSignal()

const DYNAMIC_PROBE_TTL_MS = 30_000
let dynamicProbeTtlMs = DYNAMIC_PROBE_TTL_MS

export function setDynamicSkillProbeTtlForProofs(ms: number | null): void {
  dynamicProbeTtlMs = ms ?? DYNAMIC_PROBE_TTL_MS
}

export function onDynamicSkillsLoaded(callback: () => void): () => void {
  return skillsLoadedSignal.subscribe(() => {
    try {
      callback()
    } catch (error) {
      logError(error)
    }
  })
}

function dynamicSkillsRefused(): boolean {
  if (!isSettingSourceEnabled('projectSettings') || isRestrictedToExtensionsOnly('skills')) {
    logForDebugging('skills: dynamic directories refused (project settings disabled or extensions-only policy)')
    return true
  }
  return false
}

async function mtimeOf(filePath: string): Promise<number | null> {
  try {
    return (await fsPromises.stat(filePath)).mtimeMs
  } catch {
    return null
  }
}

async function listSkillFiles(dir: string): Promise<Array<{ name: string; mtimeMs: number }> | null> {
  let names: string[]
  try {
    names = (await fsPromises.readdir(dir, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
      .map(entry => entry.name)
  } catch {
    return null
  }
  const seen: Array<{ name: string; mtimeMs: number }> = []
  for (const name of names) {
    const mtimeMs = await mtimeOf(join(dir, name, SKILL_FILE_NAME))
    if (mtimeMs !== null) seen.push({ name, mtimeMs })
  }
  return seen
}

async function dynamicDirChanged(dir: string, record: Extract<DynamicDirRecord, { state: 'loaded' }>): Promise<boolean> {
  const seen = await listSkillFiles(dir)
  if (seen === null) return true
  if (seen.length !== record.seen.length) return true
  for (const was of record.seen) {
    const now = seen.find(entry => entry.name === was.name)
    if (now === undefined || now.mtimeMs !== was.mtimeMs) return true
  }
  return false
}

async function loadDynamicDir(dir: string): Promise<{ entries: DynamicSkillEntry[]; seen: Array<{ name: string; mtimeMs: number }> | null }> {
  const seen = await listSkillFiles(dir)
  const loaded = seen === null ? [] : await loadSkillsFromDir(dir, 'projectSettings', 'dynamic')
  const entries: DynamicSkillEntry[] = loaded.map(skill => ({
    name: skill.command.name,
    filePath: skill.filePath,
    mtimeMs: seen?.find(entry => entry.name === skill.command.name)?.mtimeMs ?? 0,
    command: skill.command,
  }))
  return { entries, seen }
}

function applyDynamicDir(
  dir: string,
  entries: DynamicSkillEntry[],
  seen: Array<{ name: string; mtimeMs: number }> | null,
  now: number,
): boolean {
  const previous = examinedCandidates.get(dir)
  let changed = false
  if (previous?.state === 'loaded') {
    for (const old of previous.entries) {
      if (dynamicSkills.get(old.name) === old.command && !entries.some(entry => entry.name === old.name)) {
        dynamicSkills.delete(old.name)
        changed = true
      }
    }
  }
  for (const entry of entries) {
    if (dynamicSkills.get(entry.name) !== entry.command) {
      dynamicSkills.set(entry.name, entry.command)
      changed = true
    }
  }
  examinedCandidates.set(dir, seen === null ? { state: 'missing', examinedAt: now } : { state: 'loaded', examinedAt: now, entries, seen })
  return changed
}

async function reloadDynamicDirs(dirs: string[]): Promise<void> {
  if (dirs.length === 0 || dynamicSkillsRefused()) return
  const now = Date.now()
  const loaded = await Promise.all(dirs.map(async dir => ({ dir, ...(await loadDynamicDir(dir)) })))
  let changed = false
  for (let i = loaded.length - 1; i >= 0; i--) {
    const { dir, entries, seen } = loaded[i] as (typeof loaded)[number]
    if (applyDynamicDir(dir, entries, seen, now)) changed = true
  }
  if (changed) {
    logForDebugging(`skills: ${dirs.length} dynamic directorie(s) re-read after a change on disk`)
    skillsLoadedSignal.emit()
  }
}

function pruneDynamicSkillsSync(): void {
  let changed = false
  for (const [dir, record] of examinedCandidates) {
    if (record.state !== 'loaded') continue
    const survivors = record.entries.filter(entry => {
      if (existsSync(entry.filePath)) return true
      if (dynamicSkills.get(entry.name) === entry.command) {
        dynamicSkills.delete(entry.name)
        changed = true
      }
      return false
    })
    examinedCandidates.set(dir, {
      state: 'loaded',
      examinedAt: 0,
      entries: survivors,
      seen: record.seen.filter(was => survivors.some(entry => entry.name === was.name)),
    })
  }
  if (changed) skillsLoadedSignal.emit()
}

export async function discoverSkillDirsForPaths(
  filePaths: string[],
  cwd: string,
): Promise<string[]> {
  const discovered: string[] = []
  const stale: string[] = []
  const now = Date.now()
  const cwdPrefix = cwd.endsWith(sep) ? cwd : cwd + sep
  for (const filePath of filePaths) {
    const touched = resolve(cwd, filePath)
    let dir = dirname(touched)
    while (dir.startsWith(cwdPrefix) && dir !== cwd) {
      for (const home of PROJECT_CONFIG_DIR_NAMES) {
        const candidate = join(dir, home, 'skills')
        if (discovered.includes(candidate)) continue
        const record = examinedCandidates.get(candidate)
        const inside = touched.startsWith(candidate + sep)
        if (record !== undefined && !inside && now - record.examinedAt < dynamicProbeTtlMs) continue
        if (record?.state === 'loaded') {
          if (await dynamicDirChanged(candidate, record)) {
            if (!stale.includes(candidate)) stale.push(candidate)
          } else {
            record.examinedAt = now
          }
          continue
        }
        try {
          const stat = await fsPromises.stat(candidate)
          if (!stat.isDirectory()) {
            examinedCandidates.set(candidate, { state: 'missing', examinedAt: now })
            continue
          }
        } catch {
          examinedCandidates.set(candidate, { state: 'missing', examinedAt: now })
          continue
        }
        if (await isPathGitignored(dir, cwd)) {
          logForDebugging(`skills: ${candidate} skipped (containing directory is git-ignored)`)
          examinedCandidates.set(candidate, { state: 'missing', examinedAt: now })
          continue
        }
        examinedCandidates.set(candidate, { state: 'loaded', examinedAt: now, entries: [], seen: [] })
        discovered.push(candidate)
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  await reloadDynamicDirs(stale.sort((a, b) => b.length - a.length))
  return discovered.sort((a, b) => b.length - a.length)
}

export async function addSkillDirectories(dirs: string[]): Promise<void> {
  if (dynamicSkillsRefused()) return
  if (dirs.length === 0) return
  const now = Date.now()
  const loaded = await Promise.all(dirs.map(async dir => ({ dir, ...(await loadDynamicDir(dir)) })))
  let changed = false
  let count = 0
  for (let i = loaded.length - 1; i >= 0; i--) {
    const { dir, entries, seen } = loaded[i] as (typeof loaded)[number]
    if (applyDynamicDir(dir, entries, seen, now)) changed = true
    count += entries.length
  }
  if (count > 0) logForDebugging(`skills: ${count} dynamic skill(s) from ${dirs.length} directorie(s)`)
  if (changed) skillsLoadedSignal.emit()
}

export function getDynamicSkills(): Command[] {
  return [...dynamicSkills.values()]
}

export function activateConditionalSkillsForPaths(
  filePaths: string[],
  cwd: string,
): string[] {
  if (pendingConditional.size === 0) return []
  const activated: string[] = []
  for (const [name, command] of pendingConditional) {
    const filters = (command as { pathFilters?: string[] }).pathFilters ?? []
    if (filters.length === 0) continue
    const matcher = ignore().add(filters)
    for (const filePath of filePaths) {
      const rel = isAbsolute(filePath) ? relative(cwd, filePath) : filePath
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) continue
      if (matcher.ignores(rel)) {
        dynamicSkills.set(name, command)
        pendingConditional.delete(name)
        activatedSkillNames.add(name)
        activated.push(name)
        logForDebugging(`skills: conditional skill ${name} activated by ${rel}`)
        break
      }
    }
  }
  if (activated.length > 0) skillsLoadedSignal.emit()
  return activated
}

export function getConditionalSkillCount(): number {
  return pendingConditional.size
}

export function clearDynamicSkills(): void {
  dynamicSkills.clear()
  examinedCandidates.clear()
  pendingConditional.clear()
  activatedSkillNames.clear()
}
