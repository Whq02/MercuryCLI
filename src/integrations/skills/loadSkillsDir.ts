import { existsSync, promises as fsPromises } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { memoize } from 'lodash-es'
import ignore from 'ignore'
import type { Command, PromptCommand } from '../../commands/catalogue/command.js'
import type { ToolUseContext } from '../../tools/kit/tool.js'
import type { HooksSettings } from '../event-hook-schemas/hooks.js'
import { readHooksMap } from '../event-hook-schemas/hooks.js'
import type { EffortValue } from '../../models/effort/effort.js'
import { parseEffortValue, EFFORT_LEVELS } from '../../models/effort/effort.js'
import {
  parseFrontmatter,
  parseBooleanFrontmatter,
  parseShellFrontmatter,
  splitPathInFrontmatter,
  coerceDescriptionToString,
  type FrontmatterShell,
} from '../../platform/text/frontmatterParser.js'
import {
  extractDescriptionFromMarkdown,
  getProjectDirsUpToHome,
  clearMarkdownFileCache,
  parseSlashCommandToolsFromFrontmatter,
} from '../../platform/settings/markdownConfigLoader.js'
import { parseArgumentNames, substituteArguments } from '../extensions/load/argumentSubstitution.js'
import { executeShellCommandsInPrompt } from '../../engine/tool-dispatch/promptShellExecution.js'
import {
  PROJECT_CONFIG_DIR_NAMES,
  projectConfigCandidatePaths,
} from '../../platform/settings/projectConfig.js'
import { toPosixSeparators } from '../../platform/host-os/paths.js'
import { getMercuryHome, isBareMode, isEnvDefinedFalsy } from '../../platform/environment/envUtils.js'
import { getManagedFilePath } from '../../platform/settings/managedPath.js'
import {
  isSettingSourceEnabled,
  type SettingSource,
} from '../../platform/settings/settingSources.js'
import { isRestrictedToExtensionsOnly } from '../../platform/settings/extensionOnlyPolicy.js'
import { isPathGitignored } from '../../platform/git/gitignore.js'
import { getSessionId } from '../../boot/process-state/processState.js'
import { createSignal } from '../../platform/async/signal.js'
import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import { errorMessage, isENOENT, isFsInaccessible } from '../../platform/errors/errors.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { logError } from '../../platform/logs/errorLog.js'
import { parseUserSpecifiedModel } from '../../models/catalogue/engineModel.js'
import { roughTokenCountEstimation } from '../../models/facts/tokenEstimation.js'
import { forgetHiddenCharacters, recordHiddenCharacters } from '../../platform/text/hiddenCharacterFindings.js'
import { baseDirLine } from './baseDirLine.js'
import { checkHasTrustDialogAccepted } from '../../platform/config/trust.js'
import { passedOver } from '../../platform/errors/passedOver.js'

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
    const reading = readHooksMap(frontmatter['hooks'])
    for (const fault of reading.faults) logForDebugging(`skill ${resolvedName}: hook ${fault}`)
    if (Object.keys(reading.hooks).length > 0) hooks = reading.hooks
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
  const raw = frontmatter['paths'] ?? frontmatter['globs']
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
  const command: PromptCommand = {
    type: 'prompt',
    name,
    description: fields.description,
    hasUserSpecifiedDescription: fields.hasUserSpecifiedDescription,
    allowedTools: fields.allowedTools,
    disableModelInvocation: fields.disableModelInvocation,
    userInvocable: fields.userInvocable,
    isHidden: !fields.userInvocable,
    progressMessage: 'running',
    contentLength: markdownContent.length,
    source,
    loadedFrom,
    userFacingName: () => fields.displayName || name,
    ...(fields.argumentHint !== undefined ? { argumentHint: fields.argumentHint } : {}),
    ...(fields.argNames !== undefined && fields.argNames.length > 0
      ? { argNames: fields.argNames }
      : {}),
    ...(fields.whenToUse !== undefined ? { whenToUse: fields.whenToUse } : {}),
    ...(fields.version !== undefined ? { version: fields.version } : {}),
    ...(fields.model !== undefined ? { model: fields.model } : {}),
    ...(fields.hooks !== undefined ? { hooks: fields.hooks } : {}),
    ...(fields.context !== undefined ? { context: fields.context } : {}),
    ...(fields.agent !== undefined ? { agent: fields.agent } : {}),
    ...(fields.effort !== undefined ? { effort: fields.effort } : {}),
    ...(baseDir ? { skillRoot: baseDir } : {}),
    ...(pathFilters !== undefined ? { pathFilters } : {}),
    async getPromptForCommand(args: string, context: ToolUseContext) {
      let content = baseDir ? `${baseDirLine(baseDir)}${markdownContent}` : markdownContent
      content = substituteArguments(content, args, true, fields.argNames)
      if (baseDir) {
        const posixBaseDir = toPosixSeparators(baseDir)
        content = content.replace(SKILL_DIR_TOKEN, () => posixBaseDir)
      }
      const sessionId = String(getSessionId())
      content = content.replace(SESSION_ID_TOKEN, () => sessionId)
      if (loadedFrom !== 'mcp') {
        const execContext =
          fields.allowedTools.length > 0
            ? wrapContextForSkillSelfAuth(context, fields.allowedTools)
            : context
        content = await executeShellCommandsInPrompt(content, execContext, `/${name}`, fields.shell)
      }
      return [{ type: 'text', text: content }]
    },
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

export const SKILL_WALK_MAX_DEPTH = 8

export async function findSkillDirs(dir: string): Promise<string[] | null> {
  const found: string[] = []
  const visited = new Set<string>()
  const walk = async (current: string, depth: number): Promise<boolean> => {
    let identity = current
    try {
      identity = await fsPromises.realpath(current)
    } catch {
      identity = current
    }
    if (visited.has(identity)) return true
    visited.add(identity)
    let entries: Array<{ name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean }>
    try {
      entries = await fsPromises.readdir(current, { withFileTypes: true })
    } catch (error) {
      if (depth === 0 && !isENOENT(error) && !isFsInaccessible(error as Error)) {
        logForDebugging(`skills: could not read directory ${current}: ${errorMessage(error)}`)
      }
      return false
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const child = join(current, entry.name)
      let holdsSkill = false
      try {
        holdsSkill = (await fsPromises.stat(join(child, SKILL_FILE_NAME))).isFile()
      } catch {
        holdsSkill = false
      }
      if (holdsSkill) {
        found.push(child)
        continue
      }
      if (depth + 1 < SKILL_WALK_MAX_DEPTH) await walk(child, depth + 1)
    }
    return true
  }
  return (await walk(dir, 0)) ? found : null
}

async function loadSkillsFromDir(
  dir: string,
  source: SettingSource | 'extension',
  sourceLabel: string,
): Promise<LoadedSkill[]> {
  const skillDirs = await findSkillDirs(dir)
  if (skillDirs === null) return []
  const results = await Promise.all(
    skillDirs.map(async (skillDir): Promise<LoadedSkill | null> => {
      const entry = { name: basename(skillDir) }
      const skillFile = join(skillDir, SKILL_FILE_NAME)
      let markdown: string
      try {
        markdown = await fsPromises.readFile(skillFile, 'utf8')
      } catch (error) {
        if (!isENOENT(error)) {
          const message = errorMessage(error)
          recordSkillRefusal(skillFile, `could not read: ${message}`, sourceLabel)
          logForDebugging(
            `skills: could not read ${skillFile}: ${message}`,
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
        recordHiddenCharacters('skill', skillFile, markdown)
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
        const message = errorMessage(error)
        recordSkillRefusal(skillFile, `failed to load: ${message}`, sourceLabel)
        logForDebugging(`skills: failed to load ${skillFile}: ${message}`)
        return null
      }
    }),
  )
  return results.filter((r): r is LoadedSkill => r !== null)
}


const pendingConditional = new Map<string, Command>()
const conditionalBases = new Map<string, string>()
const activatedSkillNames = new Set<string>()

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

const loadAllSkillsMemo = memoize(
  async (cwd: string): Promise<Command[]> => {
    const managedDir = getSkillsPath('policySettings', 'skills')
    const userDir = getSkillsPath('userSettings', 'skills')
    const projectDirs = getProjectDirsUpToHome('skills', cwd)
    logForDebugging(
      `skills: managed=${managedDir} user=${userDir} project=[${projectDirs.join(', ')}]`,
    )
    if (isBareMode()) return []

    const extOnly = isRestrictedToExtensionsOnly('skills')
    const targets: Array<{
      dir: string
      source: SettingSource
      label: string
    }> = [{ dir: managedDir, source: 'policySettings', label: 'managed' }]

    if (isSettingSourceEnabled('userSettings') && !extOnly) {
      targets.push({ dir: userDir, source: 'userSettings', label: 'user' })
    }
    if (isSettingSourceEnabled('projectSettings') && !extOnly && checkHasTrustDialogAccepted()) {
      for (const dir of projectDirs) {
        targets.push({ dir, source: 'projectSettings', label: 'project' })
      }
    }

    const batches = await Promise.all(
      targets.map(target => loadSkillsFromDir(target.dir, target.source, target.label)),
    )
    const allLoaded = batches.flat()

    const seenRealpaths = new Map<string, string>()
    const unique: LoadedSkill[] = []
    let dropped = 0
    for (const item of allLoaded) {
      let real: string | null = null
      try {
        real = await fsPromises.realpath(item.filePath)
      } catch (error) {
        passedOver(error)
      }
      if (real !== null) {
        const winnerSource = seenRealpaths.get(real)
        if (winnerSource !== undefined) {
          logForDebugging(
            `skills: duplicate ${item.command.name} from ${item.source} skipped — already loaded from ${winnerSource}`,
          )
          dropped++
          continue
        }
        seenRealpaths.set(real, item.source)
      }
      unique.push(item)
    }
    if (dropped > 0) {
      logForDebugging(`skills: removed ${dropped} duplicate(s)`)
    }

    const commands = splitConditional(unique.map(item => item.command))
    const sourceCounts = new Map<string, number>()
    for (const item of unique) {
      sourceCounts.set(item.source, (sourceCounts.get(item.source) ?? 0) + 1)
    }
    const breakdown = [...sourceCounts.entries()]
      .map(([src, count]) => `${src}=${count}`)
      .join(' ')
    const withheldCount = unique.length - commands.length
    logForDebugging(
      `skills: ${unique.length} unique — ${commands.length} unconditional, ${withheldCount} conditional (${breakdown})`,
    )
    return commands
  },
  (cwd: string) => `${cwd}\0${checkHasTrustDialogAccepted() ? '1' : '0'}`,
)

export function getSkillDirCommands(cwd: string): Promise<Command[]> {
  return loadAllSkillsMemo(cwd)
}

export function clearSkillCaches(): void {
  loadAllSkillsMemo.cache.clear?.()
  clearMarkdownFileCache()
  pendingConditional.clear()
  conditionalBases.clear()
  activatedSkillNames.clear()
  skillLoadRefusals.clear()
  forgetHiddenCharacters('skill')
  pruneDynamicSkillsSync()
}


type DynamicSkillEntry = { name: string; key: string; filePath: string; mtimeMs: number; command: Command }
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
  if (!checkHasTrustDialogAccepted()) return true
  if (!isSettingSourceEnabled('projectSettings') || isRestrictedToExtensionsOnly('skills')) {
    logForDebugging('skills: dynamic directories refused (project settings disabled or extensions-only policy)')
    return true
  }
  return false
}

async function mtimeOf(filePath: string): Promise<number | null> {
  try {
    return (await fsPromises.stat(filePath)).mtimeMs
  } catch (error) {
    passedOver(error)
    return null
  }
}

async function listSkillFiles(dir: string): Promise<Array<{ name: string; mtimeMs: number }> | null> {
  const skillDirs = await findSkillDirs(dir)
  if (skillDirs === null) return null
  const seen: Array<{ name: string; mtimeMs: number }> = []
  for (const skillDir of skillDirs) {
    const mtimeMs = await mtimeOf(join(skillDir, SKILL_FILE_NAME))
    if (mtimeMs !== null) seen.push({ name: relative(dir, skillDir), mtimeMs })
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
  const entries: DynamicSkillEntry[] = loaded.map(skill => {
    const key = relative(dir, dirname(skill.filePath))
    return {
      name: skill.command.name,
      key,
      filePath: skill.filePath,
      mtimeMs: seen?.find(entry => entry.name === key)?.mtimeMs ?? 0,
      command: skill.command,
    }
  })
  return { entries, seen }
}

function pathFiltersOf(command: Command): string[] {
  return (command as { pathFilters?: string[] }).pathFilters ?? []
}

function seatDynamicEntry(dir: string, entry: DynamicSkillEntry, wasActive: boolean): boolean {
  if (pathFiltersOf(entry.command).length > 0 && !wasActive && !activatedSkillNames.has(entry.name)) {
    pendingConditional.set(entry.name, entry.command)
    conditionalBases.set(entry.name, dirname(dirname(dir)))
    return false
  }
  if (dynamicSkills.get(entry.name) === entry.command) return false
  dynamicSkills.set(entry.name, entry.command)
  return true
}

function applyDynamicDir(
  dir: string,
  entries: DynamicSkillEntry[],
  seen: Array<{ name: string; mtimeMs: number }> | null,
  now: number,
): boolean {
  const previous = examinedCandidates.get(dir)
  let changed = false
  const active = new Set<string>()
  if (previous?.state === 'loaded') {
    for (const old of previous.entries) {
      const stillProvided = entries.some(entry => entry.name === old.name)
      if (dynamicSkills.get(old.name) === old.command) {
        if (stillProvided) active.add(old.name)
        else {
          dynamicSkills.delete(old.name)
          changed = true
        }
      }
      if (pendingConditional.get(old.name) === old.command) {
        pendingConditional.delete(old.name)
        conditionalBases.delete(old.name)
      }
    }
  }
  for (const entry of entries) {
    if (seatDynamicEntry(dir, entry, active.has(entry.name))) changed = true
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
      if (pendingConditional.get(entry.name) === entry.command) {
        pendingConditional.delete(entry.name)
        conditionalBases.delete(entry.name)
      }
      return false
    })
    for (const entry of survivors) {
      if (pathFiltersOf(entry.command).length > 0 && dynamicSkills.get(entry.name) !== entry.command && !pendingConditional.has(entry.name)) seatDynamicEntry(dir, entry, false)
    }
    examinedCandidates.set(dir, {
      state: 'loaded',
      examinedAt: 0,
      entries: survivors,
      seen: record.seen.filter(was => survivors.some(entry => entry.key === was.name)),
    })
  }
  if (changed) skillsLoadedSignal.emit()
}

export async function discoverSkillDirsForPaths(
  filePaths: string[],
  cwd: string,
): Promise<string[]> {
  const resolvedCwd = resolve(cwd)
  const cwdPrefix = resolvedCwd.endsWith(sep) ? resolvedCwd : `${resolvedCwd}${sep}`
  const now = Date.now()
  const discovered: string[] = []
  const inspected = new Set<string>()
  const changedLoaded = new Set<string>()

  for (const filePath of filePaths) {
    const resolvedPath = resolve(resolvedCwd, filePath)
    let dir = dirname(resolvedPath)
    while (dir !== resolvedCwd && dir.startsWith(cwdPrefix)) {
      for (const configDirName of PROJECT_CONFIG_DIR_NAMES) {
        const candidate = join(dir, configDirName, 'skills')
        if (inspected.has(candidate)) continue

        const record = examinedCandidates.get(candidate)
        const touchUnderCandidate =
          resolvedPath === candidate || resolvedPath.startsWith(`${candidate}${sep}`)
        if (
          record !== undefined &&
          !touchUnderCandidate &&
          now - record.examinedAt < dynamicProbeTtlMs
        ) {
          continue
        }

        inspected.add(candidate)

        if (record?.state === 'loaded') {
          if (await dynamicDirChanged(candidate, record)) {
            changedLoaded.add(candidate)
          } else {
            examinedCandidates.set(candidate, { ...record, examinedAt: now })
          }
          continue
        }

        let isDir = false
        try {
          isDir = (await fsPromises.stat(candidate)).isDirectory()
        } catch (error) {
          passedOver(error)
        }
        if (!isDir) {
          examinedCandidates.set(candidate, { state: 'missing', examinedAt: now })
          continue
        }

        if (await isPathGitignored(dir, resolvedCwd)) {
          logForDebugging(`skills: ${candidate} skipped (containing directory is git-ignored)`)
          examinedCandidates.set(candidate, { state: 'missing', examinedAt: now })
          continue
        }

        examinedCandidates.set(candidate, {
          state: 'loaded',
          examinedAt: now,
          entries: [],
          seen: [],
        })
        discovered.push(candidate)
      }

      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }

  if (changedLoaded.size > 0) {
    const toReload = [...changedLoaded].sort((a, b) => b.length - a.length)
    await reloadDynamicDirs(toReload)
  }

  return discovered.sort((a, b) => b.length - a.length)
}

export async function addSkillDirectories(
  dirs: string[],
  touched?: { filePaths: string[]; cwd: string },
): Promise<void> {
  if (dirs.length === 0 || dynamicSkillsRefused()) return
  const now = Date.now()
  const loaded = await Promise.all(dirs.map(async dir => ({ dir, ...(await loadDynamicDir(dir)) })))
  let changed = false
  let count = 0
  for (let i = loaded.length - 1; i >= 0; i--) {
    const { dir, entries, seen } = loaded[i]!
    count += entries.length
    if (applyDynamicDir(dir, entries, seen, now)) changed = true
  }
  if (count > 0) {
    logForDebugging(`skills: ${count} dynamic skill(s) from ${dirs.length} directorie(s)`)
  }
  if (changed) {
    skillsLoadedSignal.emit()
  }
  if (touched) {
    activateConditionalSkillsForPaths(touched.filePaths, touched.cwd)
  }
}

export function getDynamicSkills(): Command[] {
  return [...dynamicSkills.values()]
}

export function activateConditionalSkillsForPaths(
  filePaths: string[],
  cwd: string,
): string[] {
  if (pendingConditional.size === 0 || filePaths.length === 0) return []
  const activated: string[] = []
  for (const [name, command] of [...pendingConditional.entries()]) {
    const filters = pathFiltersOf(command)
    if (filters.length === 0) continue
    const matcher = ignore().add(filters)
    const anchor = conditionalBases.get(name) ?? cwd
    for (const filePath of filePaths) {
      const rel =
        anchor === cwd && !isAbsolute(filePath)
          ? filePath
          : relative(anchor, resolve(cwd, filePath))
      const normalizedRel = toPosixSeparators(rel)
      if (normalizedRel === '' || isAbsolute(rel) || normalizedRel.startsWith('..')) {
        continue
      }
      if (matcher.ignores(normalizedRel)) {
        dynamicSkills.set(name, command)
        pendingConditional.delete(name)
        conditionalBases.delete(name)
        activatedSkillNames.add(name)
        logForDebugging(`skills: conditional skill ${name} activated by ${normalizedRel}`)
        activated.push(name)
        break
      }
    }
  }
  if (activated.length > 0) {
    skillsLoadedSignal.emit()
  }
  return activated
}

export function clearDynamicSkills(): void {
  dynamicSkills.clear()
  examinedCandidates.clear()
  pendingConditional.clear()
  conditionalBases.clear()
  activatedSkillNames.clear()
}
